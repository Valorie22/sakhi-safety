import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { Accelerometer } from 'expo-sensors';

export interface ShakeConfig {
  enabled: boolean;
  /** Acceleration magnitude in g above which a sample counts as a shake peak. */
  threshold: number;
  /** How many peaks are needed. */
  countRequired: number;
  /** Peaks must all fall inside this window. */
  windowMs: number;
  /** Quiet period after a trigger, so one violent motion cannot fire twice. */
  cooldownMs: number;
}

export interface ShakeState {
  /** False when the sensor is unavailable or the app is backgrounded. */
  active: boolean;
  available: boolean;
  /** Peaks collected so far inside the current window. */
  progress: number;
  cooldownUntil: number | null;
  reason: string;
}

/**
 * Shake-to-trigger.
 *
 * Peaks are counted inside a sliding window rather than as a simple counter, so
 * three hard jolts spread over a minute of ordinary walking never add up to an
 * alert. A refractory gap between peaks stops one continuous shake registering
 * as many.
 *
 * Honesty note: this only runs while the app is foregrounded. Expo cannot keep
 * the accelerometer alive in the background on either platform without a
 * dedicated native background task, so `active` goes false the moment the app
 * is backgrounded and the Safety Settings screen says so plainly rather than
 * implying round-the-clock coverage.
 */
export function useShakeDetector(config: ShakeConfig, onShake: () => void): ShakeState {
  const [state, setState] = useState<ShakeState>({
    active: false,
    available: true,
    progress: 0,
    cooldownUntil: null,
    reason: 'Starting up',
  });

  const peaks = useRef<number[]>([]);
  const cooldownUntil = useRef(0);
  const lastPeakAt = useRef(0);
  const callback = useRef(onShake);
  callback.current = onShake;

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    async function start() {
      if (!config.enabled) {
        setState((s) => ({ ...s, active: false, reason: 'Turned off in Safety Settings' }));
        return;
      }

      const available = await Accelerometer.isAvailableAsync().catch(() => false);
      if (cancelled) return;

      if (!available) {
        setState({
          active: false,
          available: false,
          progress: 0,
          cooldownUntil: null,
          reason: 'This device has no usable motion sensor',
        });
        return;
      }

      if (AppState.currentState !== 'active') {
        setState((s) => ({
          ...s,
          active: false,
          available: true,
          reason: 'Paused while the app is in the background',
        }));
        return;
      }

      Accelerometer.setUpdateInterval(100);
      subscription = Accelerometer.addListener(({ x, y, z }) => {
        const now = Date.now();
        if (now < cooldownUntil.current) return;

        // Total acceleration including gravity; at rest this sits near 1g.
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (magnitude < config.threshold) return;

        // Refractory gap: one shove is one peak, not fifteen samples of one.
        if (now - lastPeakAt.current < 120) return;
        lastPeakAt.current = now;

        peaks.current = [...peaks.current.filter((t) => now - t <= config.windowMs), now];
        setState((s) => ({ ...s, progress: peaks.current.length }));

        if (peaks.current.length >= config.countRequired) {
          peaks.current = [];
          cooldownUntil.current = now + config.cooldownMs;
          setState((s) => ({ ...s, progress: 0, cooldownUntil: cooldownUntil.current }));
          callback.current();
        }
      });

      setState({
        active: true,
        available: true,
        progress: 0,
        cooldownUntil: null,
        reason: `${config.countRequired} hard shakes within ${(config.windowMs / 1000).toFixed(1)}s`,
      });
    }

    void start();

    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void start();
      } else {
        subscription?.remove();
        subscription = null;
        peaks.current = [];
        setState((s) => ({ ...s, active: false, progress: 0, reason: 'Paused while the app is in the background' }));
      }
    });

    return () => {
      cancelled = true;
      subscription?.remove();
      appStateSub.remove();
    };
  }, [config.enabled, config.threshold, config.countRequired, config.windowMs, config.cooldownMs]);

  return state;
}
