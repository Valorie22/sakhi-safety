import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { api } from '../api';

export interface AudioEvidenceState {
  recording: boolean;
  /** Seconds captured across all segments for this emergency. */
  elapsedSeconds: number;
  segmentIndex: number;
  permission: 'granted' | 'denied' | 'unknown';
  uploading: boolean;
  error: string | null;
  /** True when the total cap has been reached and recording stopped itself. */
  capReached: boolean;
}

interface Options {
  emergencyId: string | null;
  /** Recording only starts at level 2+. */
  level: number;
  enabled: boolean;
  segmentSeconds?: number;
  maxTotalSeconds?: number;
}

/**
 * Ambient audio evidence for Level 2 and above.
 *
 * Recorded in bounded segments and rotated, so a long incident produces several
 * uploadable files instead of one enormous one that is lost if the app dies.
 * There is a hard total cap - recording indefinitely is both a storage problem
 * and, more importantly, not something anyone consented to.
 *
 * Failure here never takes the emergency down with it: if the microphone is
 * refused or recording breaks, location and dispatch carry on untouched and the
 * screen says audio is unavailable. Losing evidence is bad; losing the alert
 * because evidence failed would be much worse.
 */
export function useAudioEvidence({
  emergencyId,
  level,
  enabled,
  segmentSeconds = 120,
  maxTotalSeconds = 1800,
}: Options): AudioEvidenceState & { stop: () => Promise<void> } {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [state, setState] = useState<AudioEvidenceState>({
    recording: false,
    elapsedSeconds: 0,
    segmentIndex: 0,
    permission: 'unknown',
    uploading: false,
    error: null,
    capReached: false,
  });

  const active = useRef(false);
  const totalSeconds = useRef(0);
  const segmentIndex = useRef(0);
  const rotateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentAudioId = useRef<string | null>(null);
  const pendingUploads = useRef(
    new Map<string, { uploadUrl: string; startedAt: number; duration: () => number }>(),
  );

  /** Pushes one finished segment to private storage via a signed upload URL. */
  const uploadSegment = useCallback(
    async (uri: string, audioId: string, durationSeconds: number, uploadUrl: string) => {
      setState((s) => ({ ...s, uploading: true }));
      try {
        const response = await fetch(uri);
        const blob = await response.blob();

        const put = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'audio/m4a', 'x-upsert': 'true' },
          body: blob,
        });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);

        await api.finishAudioSegment(emergencyId!, audioId, {
          status: 'uploaded',
          durationSeconds,
          sizeBytes: blob.size,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await api
          .finishAudioSegment(emergencyId!, audioId, { status: 'failed', errorMessage: message })
          .catch(() => {});
        setState((s) => ({ ...s, error: `Audio segment failed to upload: ${message}` }));
      } finally {
        setState((s) => ({ ...s, uploading: false }));
      }
    },
    [emergencyId],
  );

  const finishCurrentSegment = useCallback(async () => {
    const audioId = currentAudioId.current;
    currentAudioId.current = null;
    if (!audioId || !emergencyId) return;

    try {
      await recorder.stop();
    } catch {
      // Already stopped; nothing to unwind.
    }

    const uri = recorder.uri;
    if (!uri) {
      await api
        .finishAudioSegment(emergencyId, audioId, { status: 'failed', errorMessage: 'no file produced' })
        .catch(() => {});
      return;
    }

    // The upload URL was minted when the segment started; re-request if lost.
    const pending = pendingUploads.current.get(audioId);
    if (pending) {
      pendingUploads.current.delete(audioId);
      await uploadSegment(uri, audioId, pending.duration(), pending.uploadUrl);
    }
  }, [emergencyId, recorder, uploadSegment]);

  const startSegment = useCallback(async () => {
    if (!emergencyId || !active.current) return;

    if (totalSeconds.current >= maxTotalSeconds) {
      active.current = false;
      setState((s) => ({ ...s, recording: false, capReached: true }));
      return;
    }

    try {
      const index = segmentIndex.current;
      const { audioId, uploadUrl } = await api.startAudioSegment(emergencyId, index);
      currentAudioId.current = audioId;

      const startedAt = Date.now();
      pendingUploads.current.set(audioId, {
        uploadUrl,
        startedAt,
        duration: () => Math.round((Date.now() - startedAt) / 1000),
      });

      await recorder.prepareToRecordAsync();
      recorder.record();

      setState((s) => ({ ...s, recording: true, segmentIndex: index, error: null }));

      const remaining = maxTotalSeconds - totalSeconds.current;
      const thisSegment = Math.min(segmentSeconds, remaining);

      rotateTimer.current = setTimeout(() => {
        void (async () => {
          segmentIndex.current += 1;
          await finishCurrentSegment();
          await startSegment();
        })();
      }, thisSegment * 1000);
    } catch (err) {
      setState((s) => ({
        ...s,
        recording: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [emergencyId, maxTotalSeconds, segmentSeconds, recorder, finishCurrentSegment]);

  const stop = useCallback(async () => {
    active.current = false;
    if (rotateTimer.current) clearTimeout(rotateTimer.current);
    if (tickTimer.current) clearInterval(tickTimer.current);
    rotateTimer.current = null;
    tickTimer.current = null;
    await finishCurrentSegment();
    setState((s) => ({ ...s, recording: false }));
  }, [finishCurrentSegment]);

  useEffect(() => {
    let cancelled = false;

    async function begin() {
      if (!emergencyId || level < 2 || !enabled) return;

      const permission = await requestRecordingPermissionsAsync();
      if (cancelled) return;

      if (!permission.granted) {
        // Explicitly not fatal. The rest of the emergency is already running.
        setState((s) => ({
          ...s,
          permission: 'denied',
          error: 'Microphone denied - location and dispatch are still active',
        }));
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      }).catch(() => {});

      setState((s) => ({ ...s, permission: 'granted' }));
      active.current = true;
      totalSeconds.current = 0;
      segmentIndex.current = 0;

      tickTimer.current = setInterval(() => {
        totalSeconds.current += 1;
        setState((s) => ({ ...s, elapsedSeconds: totalSeconds.current }));
      }, 1000);

      await startSegment();
    }

    void begin();

    return () => {
      cancelled = true;
      void stop();
    };
    // Intentionally keyed on identity of the emergency and its level only:
    // re-running this on every render would restart the recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emergencyId, level, enabled]);

  return { ...state, stop };
}
