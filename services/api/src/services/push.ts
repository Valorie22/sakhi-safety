import { env } from '../env.js';
import { admin } from '../supabase.js';

/**
 * Notification delivery.
 *
 * The `notifications` table is the source of truth and doubles as an outbox:
 * the SQL functions that change an emergency's state write rows there inside
 * the same transaction, and this worker drains them afterwards. If the process
 * that triggered the change dies, the rows survive and the next drain picks
 * them up - a dropped push never means a lost alert record.
 *
 * Payloads stay deliberately thin. A push banner can be read off a locked
 * screen, so it carries a code and a level, never a name or an address; the
 * sensitive detail lives behind the authenticated in-app view.
 */

interface OutboxRow {
  id: string;
  recipient_id: string | null;
  recipient_station_id: string | null;
  emergency_id: string | null;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  priority: 'high';
  sound: 'default';
  channelId: string;
}

const EMERGENCY_TYPES = new Set([
  'emergency_triggered',
  'station_notified',
  'level_escalated',
  'officer_assigned',
  'officer_responding',
  'officer_on_scene',
]);

function isExpoToken(token: string): boolean {
  return token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[');
}

async function sendToExpo(messages: ExpoMessage[]): Promise<void> {
  if (messages.length === 0) return;

  // Expo accepts up to 100 messages per request.
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const res = await fetch(env.EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`Expo push responded ${res.status}: ${await res.text()}`);
    }
  }
}

async function deliverOne(row: OutboxRow): Promise<void> {
  const { data: targets, error } = await admin.rpc('push_targets_for_notification', {
    p_notification_id: row.id,
  });
  if (error) throw new Error(error.message);

  const messages: ExpoMessage[] = (targets ?? [])
    .filter((t: { push_token: string | null }) => t.push_token && isExpoToken(t.push_token))
    .map((t: { push_token: string }) => ({
      to: t.push_token,
      title: row.title,
      body: row.body,
      data: {
        notificationId: row.id,
        emergencyId: row.emergency_id,
        type: row.type,
        ...row.payload,
      },
      priority: 'high' as const,
      // Android needs a high-importance channel for these to bypass DND.
      channelId: EMERGENCY_TYPES.has(row.type) ? 'emergency' : 'default',
      sound: 'default' as const,
    }));

  await sendToExpo(messages);

  // A notification with no registered device is still "delivered" as far as the
  // outbox is concerned - the in-app notification centre will show it on next
  // open. Leaving it unpushed would retry forever.
  await admin.rpc('mark_notification_pushed', { p_id: row.id, p_error: null });
}

/** Drains one batch. Returns how many rows were processed. */
export async function drainOutbox(limit = 50): Promise<number> {
  const { data, error } = await admin.rpc('claim_unpushed_notifications', { p_limit: limit });
  if (error) throw new Error(`outbox claim failed: ${error.message}`);

  const rows = (data ?? []) as OutboxRow[];
  for (const row of rows) {
    try {
      await deliverOne(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`push failed for notification ${row.id}:`, message);
      // push_attempts was already incremented by the claim; after 5 tries the
      // row stops being picked up and stays visible in the in-app centre.
      await admin.rpc('mark_notification_pushed', { p_id: row.id, p_error: message });
    }
  }
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;

export function startPushWorker(intervalMs = 2000): void {
  if (timer) return;
  const tick = async () => {
    try {
      // Keep draining while there is a full batch waiting, so a burst of
      // notifications is not paced at one batch per interval.
      let processed = 0;
      do {
        processed = await drainOutbox();
      } while (processed >= 50);
    } catch (err) {
      console.error('push worker tick failed:', err);
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  void tick();
}

export function stopPushWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
