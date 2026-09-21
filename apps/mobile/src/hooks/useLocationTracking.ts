import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { sendPing, flush, pendingPingCount } from '../lib/emergencyQueue';

export interface TrackingState {
  /** True while pings are actually being written to the server. */
  streaming: boolean;
  lastSentAt: number | null;
  lastFixAt: number | null;
  queued: number;
  online: boolean;
  permission: 'granted' | 'denied' | 'unknown';
  error: string | null;
}

/**
 * Live location sharing for one running emergency.
 *
 * Stops writing the moment the emergency closes - historical pings stay in the
 * record, but a resolved incident must not keep broadcasting where she is.
 *
 * `queued` and `online` drive the connectivity indicator. During an emergency
 * she needs to know whether her position is actually reaching anyone, so a
 * silent retry loop with a confident green dot would be a lie.
 */
export function useLocationTracking(emergencyId: string | null, intervalSeconds = 15): TrackingState {
  const [state, setState] = useState<TrackingState>({
    streaming: false,
    lastSentAt: null,
    lastFixAt: null,
    queued: 0,
    online: true,
    permission: 'unknown',
    error: null,
  });

  const watcher = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    const sub = NetInfo.addEventListener((netState) => {
      const online = Boolean(netState.isConnected && netState.isInternetReachable !== false);
      setState((s) => ({ ...s, online }));
      if (online) {
        // Drain whatever piled up while the signal was gone.
        void flush().then(async () => {
          const queued = await pendingPingCount();
          setState((s) => ({ ...s, queued }));
        });
      }
    });
    return () => sub();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!emergencyId) {
        setState((s) => ({ ...s, streaming: false }));
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;

      if (status !== 'granted') {
        setState((s) => ({
          ...s,
          streaming: false,
          permission: 'denied',
          error: 'Location permission denied - responders cannot see where you are',
        }));
        return;
      }
      setState((s) => ({ ...s, permission: 'granted', error: null }));

      // Best effort only: if the OS refuses background location the emergency
      // still works, it just stops updating when the screen locks.
      await Location.requestBackgroundPermissionsAsync().catch(() => {});

      watcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: intervalSeconds * 1000,
          distanceInterval: 5,
        },
        async (position) => {
          const fixAt = Date.now();
          setState((s) => ({ ...s, lastFixAt: fixAt }));

          const delivered = await sendPing({
            emergencyId,
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy ?? undefined,
            speed: position.coords.speed ?? undefined,
            heading: position.coords.heading ?? undefined,
            recordedAt: new Date(position.timestamp).toISOString(),
          });

          setState((s) => ({
            ...s,
            streaming: true,
            lastSentAt: delivered ? Date.now() : s.lastSentAt,
          }));

          if (!delivered) {
            setState((s) => ({ ...s, queued: s.queued + 1 }));
          }
        },
      );

      setState((s) => ({ ...s, streaming: true }));
    }

    void start();

    return () => {
      cancelled = true;
      watcher.current?.remove();
      watcher.current = null;
      setState((s) => ({ ...s, streaming: false }));
    };
  }, [emergencyId, intervalSeconds]);

  return state;
}

/** One-shot fix, used at trigger time. */
export async function getCurrentPosition(): Promise<{
  lat: number;
  lng: number;
  accuracy?: number;
} | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ?? undefined,
    };
  } catch {
    // Fall back to the last known fix rather than refusing to raise the alarm.
    try {
      const last = await Location.getLastKnownPositionAsync();
      if (!last) return null;
      return {
        lat: last.coords.latitude,
        lng: last.coords.longitude,
        accuracy: last.coords.accuracy ?? undefined,
      };
    } catch {
      return null;
    }
  }
}
