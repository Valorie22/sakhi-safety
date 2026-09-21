import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'sakhi.timer.v1';

interface StoredTimer {
  /** Absolute wall-clock instant the timer fires. */
  fireAt: number;
  durationSeconds: number;
}

export interface TimerState {
  running: boolean;
  /** Whole seconds left, floored at 0. */
  remaining: number;
  durationSeconds: number;
}

/**
 * The unattended countdown.
 *
 * The deadline is stored as an absolute timestamp the moment the timer starts,
 * never as a counter that gets decremented. A decrementing counter drifts,
 * stalls when the JS timer is throttled in the background, and then disagrees
 * with reality on resume. With an absolute deadline, "has it fired?" is just
 * `Date.now() >= fireAt` - which stays correct across backgrounding, a phone
 * that slept for two minutes, and even a full app restart, because the deadline
 * is persisted.
 */
export function useEmergencyTimer(onExpire: () => void) {
  const [state, setState] = useState<TimerState>({ running: false, remaining: 0, durationSeconds: 0 });
  const fireAt = useRef<number | null>(null);
  const fired = useRef(false);
  const callback = useRef(onExpire);
  callback.current = onExpire;

  const clear = useCallback(async () => {
    fireAt.current = null;
    fired.current = false;
    setState({ running: false, remaining: 0, durationSeconds: 0 });
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const evaluate = useCallback(() => {
    if (fireAt.current === null) return;

    const msLeft = fireAt.current - Date.now();
    if (msLeft <= 0) {
      if (!fired.current) {
        // Guard against a resume racing the interval and firing twice.
        fired.current = true;
        void clear();
        callback.current();
      }
      return;
    }
    setState((s) => ({ ...s, running: true, remaining: Math.ceil(msLeft / 1000) }));
  }, [clear]);

  const start = useCallback(
    async (durationSeconds: number) => {
      const deadline = Date.now() + durationSeconds * 1000;
      fireAt.current = deadline;
      fired.current = false;
      setState({ running: true, remaining: durationSeconds, durationSeconds });
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ fireAt: deadline, durationSeconds } satisfies StoredTimer),
      ).catch(() => {});
    },
    [],
  );

  const cancel = useCallback(async () => {
    // Cancelling before zero must leave no trace anywhere: no emergency row,
    // no notification, nothing sent.
    await clear();
  }, [clear]);

  // Resume an in-flight countdown after a cold start.
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        const stored = JSON.parse(raw) as StoredTimer;

        if (Date.now() >= stored.fireAt) {
          // The app was closed straight through the deadline. Firing an SOS
          // now, minutes late and with no idea whether she is still in danger,
          // would be worse than not firing: drop it and say so on screen.
          void clear();
          return;
        }

        fireAt.current = stored.fireAt;
        fired.current = false;
        setState({
          running: true,
          remaining: Math.ceil((stored.fireAt - Date.now()) / 1000),
          durationSeconds: stored.durationSeconds,
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [clear]);

  useEffect(() => {
    if (!state.running) return;
    // 250ms keeps the displayed second honest without busy-waiting.
    const interval = setInterval(evaluate, 250);
    const sub = AppState.addEventListener('change', (next) => {
      // Re-evaluate the instant we come back, rather than waiting a tick.
      if (next === 'active') evaluate();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [state.running, evaluate]);

  return { ...state, start, cancel };
}
