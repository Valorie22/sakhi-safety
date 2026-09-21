import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * The case-claiming concurrency guarantee (spec 6.8).
 *
 * This is NOT a sequential simulation. Each claim goes out as its own HTTP
 * request to PostgREST, which means N separate connections, N separate
 * backends and N separate transactions all hitting the same row at the same
 * moment - the exact situation two officers tapping "Take Case" produce.
 *
 * What must hold, every round:
 *   - exactly one caller gets ok:true
 *   - every other caller gets already_claimed
 *   - every loser is told the SAME winner
 *   - the row ends up owned by that winner and nobody else
 *
 * Run with: npm run test:concurrency
 */

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RACERS = 8;
const ROUNDS = 5;

let db: SupabaseClient;
let stationId: string;
let reporterId: string;
const officerIds: string[] = [];
const createdEmergencies: string[] = [];

interface ClaimResult {
  ok: boolean;
  reason?: string;
  officer_id?: string;
  claimed_by_officer_id?: string;
  badge_number?: string;
}

function uuid(): string {
  return crypto.randomUUID();
}

async function makeUser(email: string, fullName: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: `Test!${uuid().slice(0, 12)}`,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

beforeAll(async () => {
  if (!URL || !KEY) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in services/api/.env to run this test.',
    );
  }
  db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const tag = uuid().slice(0, 8);

  // A station whose radius comfortably covers the trigger point.
  const { data: station, error: stationError } = await db.rpc('admin_create_station', {
    p_name: `Race Test Station ${tag}`,
    p_lat: 19.076,
    p_lng: 72.8777,
    p_radius: 5000,
    p_address: null,
    p_phone: null,
  });
  if (stationError) throw new Error(`station create failed: ${stationError.message}`);
  stationId = (station as { id: string }).id;

  reporterId = await makeUser(`race-reporter-${tag}@example.com`, 'Race Reporter');

  // Several officers, all at the same station, so they share one queue.
  for (let i = 0; i < RACERS; i++) {
    const id = await makeUser(`race-officer-${tag}-${i}@example.com`, `Race Officer ${i}`);
    await db.from('profiles').update({ role: 'police' }).eq('id', id);
    const { error } = await db
      .from('police_officers')
      .insert({ id, station_id: stationId, badge_number: `RT-${tag}-${i}` });
    if (error) throw new Error(`officer insert failed: ${error.message}`);
    officerIds.push(id);
  }
}, 120_000);

afterAll(async () => {
  if (!db) return;
  for (const id of createdEmergencies) await db.from('emergencies').delete().eq('id', id);
  for (const id of officerIds) await db.auth.admin.deleteUser(id).catch(() => {});
  if (reporterId) await db.auth.admin.deleteUser(reporterId).catch(() => {});
  if (stationId) await db.from('police_stations').delete().eq('id', stationId).catch(() => {});
}, 120_000);

async function freshEmergency(): Promise<string> {
  const { data, error } = await db.rpc('trigger_emergency', {
    p_user_id: reporterId,
    p_client_request_id: uuid(),
    p_trigger_type: 'button',
    p_level: 1,
    p_lat: 19.076,
    p_lng: 72.8777,
    p_accuracy: 10,
    p_address_hint: null,
  });
  if (error) throw new Error(`trigger failed: ${error.message}`);
  const id = (data as { emergency_id: string }).emergency_id;
  createdEmergencies.push(id);
  return id;
}

describe('atomic case claiming', () => {
  it(`lets exactly one of ${RACERS} simultaneous officers win, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const emergencyId = await freshEmergency();

      // Fire them all without awaiting in between: the requests leave together.
      const results = await Promise.all(
        officerIds.map(async (officerId): Promise<ClaimResult> => {
          const { data, error } = await db.rpc('claim_emergency', {
            p_emergency_id: emergencyId,
            p_officer_id: officerId,
          });
          if (error) throw new Error(`claim rpc failed: ${error.message}`);
          return data as ClaimResult;
        }),
      );

      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);

      expect(winners, `round ${round}: expected exactly one winner`).toHaveLength(1);
      expect(losers).toHaveLength(RACERS - 1);

      // Every loser must be told the truth about who actually holds the case.
      for (const loser of losers) {
        expect(loser.reason).toBe('already_claimed');
        expect(loser.claimed_by_officer_id).toBe(winners[0]!.officer_id);
      }

      // And the database must agree with what the winner was told.
      const { data: row } = await db
        .from('emergencies')
        .select('claimed_by_officer_id, status, claimed_at')
        .eq('id', emergencyId)
        .single();

      expect(row!.claimed_by_officer_id).toBe(winners[0]!.officer_id);
      expect(row!.status).toBe('claimed');
      expect(row!.claimed_at).toBeTruthy();

      // Exactly one case_claimed event, not one per attempt.
      const { data: events } = await db
        .from('emergency_timeline')
        .select('id')
        .eq('emergency_id', emergencyId)
        .eq('event_type', 'case_claimed');

      expect(events, `round ${round}: one claim event only`).toHaveLength(1);
    }
  }, 180_000);

  it('refuses a claim from an officer at a station the case was never routed to', async () => {
    const emergencyId = await freshEmergency();
    const tag = uuid().slice(0, 8);

    const { data: farStation } = await db.rpc('admin_create_station', {
      p_name: `Far Station ${tag}`,
      p_lat: 28.6139,
      p_lng: 77.209,
      p_radius: 1000,
      p_address: null,
      p_phone: null,
    });
    const farStationId = (farStation as { id: string }).id;
    const outsiderId = await makeUser(`race-outsider-${tag}@example.com`, 'Outsider');
    await db.from('profiles').update({ role: 'police' }).eq('id', outsiderId);
    await db
      .from('police_officers')
      .insert({ id: outsiderId, station_id: farStationId, badge_number: `FAR-${tag}` });

    const { data } = await db.rpc('claim_emergency', {
      p_emergency_id: emergencyId,
      p_officer_id: outsiderId,
    });

    expect((data as ClaimResult).ok).toBe(false);
    expect((data as ClaimResult).reason).toBe('not_routed_to_your_station');

    await db.auth.admin.deleteUser(outsiderId).catch(() => {});
    await db.from('police_stations').delete().eq('id', farStationId);
  }, 60_000);

  it('does not create a second emergency when the same request is retried', async () => {
    const key = uuid();
    const args = {
      p_user_id: reporterId,
      p_client_request_id: key,
      p_trigger_type: 'button' as const,
      p_level: 1,
      p_lat: 19.076,
      p_lng: 72.8777,
      p_accuracy: 10,
      p_address_hint: null,
    };

    // Six retries of "the same" request, fired together the way a flaky
    // connection plus an eager retry loop would.
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const { data, error } = await db.rpc('trigger_emergency', args);
        if (error) throw new Error(error.message);
        return data as { emergency_id: string; idempotent_replay: boolean };
      }),
    );

    const ids = new Set(results.map((r) => r.emergency_id));
    expect(ids.size, 'all retries must resolve to one emergency').toBe(1);

    const id = [...ids][0]!;
    createdEmergencies.push(id);

    const { count } = await db
      .from('emergencies')
      .select('id', { count: 'exact', head: true })
      .eq('client_request_id', key);

    expect(count).toBe(1);
  }, 60_000);
});
