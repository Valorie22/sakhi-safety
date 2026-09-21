import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { api, ApiError, type TriggerResult } from '../api';

/**
 * Durability for the one request that must never be silently lost.
 *
 * What this DOES do:
 *   - writes the intent to disk before the network is touched, so a trigger
 *     survives the app being killed mid-request
 *   - retries with backoff until it lands
 *   - carries a client-generated UUID so a retry that actually did reach the
 *     server resolves to the original emergency instead of creating a second one
 *   - replays queued location pings once connectivity returns
 *
 * What this does NOT do, and must not be described as doing:
 *   - reach the police with no internet connection at all. There is no offline
 *     transport here. A queued trigger is a promise to send it the moment a
 *     connection exists, nothing more, and the UI says exactly that.
 *
 * The transport is deliberately isolated behind `flush()` so a future mesh or
 * SMS relay could be added as an alternative sender without reshaping callers.
 */

const TRIGGER_KEY = 'sakhi.pendingTrigger.v1';
const PINGS_KEY = 'sakhi.pendingPings.v1';
const MAX_PINGS = 200;

export interface PendingTrigger {
  clientRequestId: string;
  triggerType: 'button' | 'shake' | 'timer';
  level: number;
  lat: number;
  lng: number;
  accuracy?: number;
  addressHint?: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

export interface PendingPing {
  emergencyId: string;
  lat: number;
  lng: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  recordedAt: string;
}

export function newRequestId(): string {
  return Crypto.randomUUID();
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable. The in-flight attempt still proceeds; we
    // just lose the ability to resume it after a cold start.
  }
}

export async function getPendingTrigger(): Promise<PendingTrigger | null> {
  return readJson<PendingTrigger | null>(TRIGGER_KEY, null);
}

export async function clearPendingTrigger(): Promise<void> {
  await AsyncStorage.removeItem(TRIGGER_KEY);
}

/**
 * Persists the intent, then tries to send it. Returns the server's answer if it
 * lands immediately; returns null if it is queued, in which case `flush()` keeps
 * trying.
 */
export async function submitTrigger(
  input: Omit<PendingTrigger, 'queuedAt' | 'attempts' | 'clientRequestId'> & { clientRequestId?: string },
): Promise<TriggerResult | null> {
  const pending: PendingTrigger = {
    ...input,
    clientRequestId: input.clientRequestId ?? newRequestId(),
    queuedAt: Date.now(),
    attempts: 0,
  };

  // Disk first. If the process dies on the next line, the intent survives.
  await writeJson(TRIGGER_KEY, pending);

  return attemptTrigger(pending);
}

async function attemptTrigger(pending: PendingTrigger): Promise<TriggerResult | null> {
  try {
    const result = await api.triggerEmergency({
      clientRequestId: pending.clientRequestId,
      triggerType: pending.triggerType,
      level: pending.level,
      lat: pending.lat,
      lng: pending.lng,
      accuracy: pending.accuracy,
      addressHint: pending.addressHint,
    });
    await clearPendingTrigger();
    return result;
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : null;

    // A 4xx that is not a rate limit will never succeed on retry - drop it
    // rather than looping forever against a request the server rejects.
    if (apiErr && !apiErr.isRetryable) {
      await clearPendingTrigger();
      throw err;
    }

    await writeJson(TRIGGER_KEY, {
      ...pending,
      attempts: pending.attempts + 1,
      lastError: apiErr?.message ?? String(err),
    });
    return null;
  }
}

export async function queuePing(ping: PendingPing): Promise<void> {
  const queue = await readJson<PendingPing[]>(PINGS_KEY, []);
  queue.push(ping);
  // Keep the newest: during a long outage, recent positions matter, and an
  // unbounded queue would eventually blow up storage.
  await writeJson(PINGS_KEY, queue.slice(-MAX_PINGS));
}

export async function pendingPingCount(): Promise<number> {
  return (await readJson<PendingPing[]>(PINGS_KEY, [])).length;
}

/**
 * Sends the ping now, queueing it if the network refuses. Returns false when the
 * ping was queued rather than delivered, so the caller can show the connectivity
 * indicator honestly.
 */
export async function sendPing(ping: PendingPing): Promise<boolean> {
  try {
    const result = await api.ping(ping.emergencyId, {
      lat: ping.lat,
      lng: ping.lng,
      accuracy: ping.accuracy,
      speed: ping.speed,
      heading: ping.heading,
      recordedAt: ping.recordedAt,
    });
    // The database refuses pings for a closed emergency; that is a stop signal,
    // not a failure to queue.
    return result.ok || result.reason === 'emergency_closed';
  } catch (err) {
    if (err instanceof ApiError && !err.isRetryable) return true;
    await queuePing(ping);
    return false;
  }
}

/** Drains whatever is waiting. Safe to call on every reconnect. */
export async function flush(): Promise<{ triggerSent: TriggerResult | null; pingsSent: number }> {
  let triggerSent: TriggerResult | null = null;

  const pending = await getPendingTrigger();
  if (pending) {
    // Give up after ~10 minutes of failure rather than retrying forever; by
    // then the screen has been telling her to call 112 directly for a while.
    if (Date.now() - pending.queuedAt > 10 * 60 * 1000) {
      await clearPendingTrigger();
    } else {
      triggerSent = await attemptTrigger(pending).catch(() => null);
    }
  }

  const queue = await readJson<PendingPing[]>(PINGS_KEY, []);
  if (queue.length === 0) return { triggerSent, pingsSent: 0 };

  const stillPending: PendingPing[] = [];
  let sent = 0;

  for (const ping of queue) {
    try {
      await api.ping(ping.emergencyId, {
        lat: ping.lat,
        lng: ping.lng,
        accuracy: ping.accuracy,
        speed: ping.speed,
        heading: ping.heading,
        recordedAt: ping.recordedAt,
      });
      sent++;
    } catch (err) {
      if (err instanceof ApiError && !err.isRetryable) continue;
      stillPending.push(ping);
    }
  }

  await writeJson(PINGS_KEY, stillPending);
  return { triggerSent, pingsSent: sent };
}

/** Exponential backoff with jitter, capped so retries stay responsive. */
export function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 15000);
  return base + Math.random() * 500;
}
