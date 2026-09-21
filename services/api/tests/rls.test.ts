import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * RLS boundary tests.
 *
 * These sign in as real accounts with the public anon key - the same path the
 * mobile app takes - and then try to read things they should not be able to.
 * Testing the policies through the API would only prove the API's own checks;
 * this proves the database refuses even when nothing else does.
 */

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const PASSWORD = 'RlsTest!pass123';

let db: SupabaseClient;
let tag: string;

const users: Record<string, { id: string; email: string; client: SupabaseClient }> = {};
let stationId = '';
let farStationId = '';
let emergencyId = '';

async function signedInUser(key: string, fullName: string): Promise<void> {
  const email = `rls-${key}-${tag}@example.com`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);

  const client = createClient(URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn ${key}: ${signInError.message}`);

  users[key] = { id: data.user.id, email, client };
}

beforeAll(async () => {
  if (!URL || !SERVICE_KEY || !ANON_KEY) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set.');
  }
  db = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  tag = crypto.randomUUID().slice(0, 8);

  await signedInUser('reporter', 'RLS Reporter');
  await signedInUser('family', 'RLS Family');
  await signedInUser('stranger', 'RLS Stranger');
  await signedInUser('officer', 'RLS Officer');
  await signedInUser('farOfficer', 'RLS Far Officer');

  const { data: near } = await db.rpc('admin_create_station', {
    p_name: `RLS Near ${tag}`, p_lat: 19.076, p_lng: 72.8777, p_radius: 5000,
    p_address: null, p_phone: null,
  });
  stationId = (near as { id: string }).id;

  const { data: far } = await db.rpc('admin_create_station', {
    p_name: `RLS Far ${tag}`, p_lat: 28.6139, p_lng: 77.209, p_radius: 1000,
    p_address: null, p_phone: null,
  });
  farStationId = (far as { id: string }).id;

  await db.from('profiles').update({ role: 'police' }).eq('id', users.officer!.id);
  await db.from('police_officers').insert({
    id: users.officer!.id, station_id: stationId, badge_number: `RLS-${tag}-N`,
  });

  await db.from('profiles').update({ role: 'police' }).eq('id', users.farOfficer!.id);
  await db.from('police_officers').insert({
    id: users.farOfficer!.id, station_id: farStationId, badge_number: `RLS-${tag}-F`,
  });

  // family is an ACCEPTED contact of reporter; stranger is not.
  await db.from('emergency_contacts').insert({
    owner_id: users.reporter!.id, contact_id: users.family!.id,
    status: 'accepted', responded_at: new Date().toISOString(),
  });

  const { data: emergency, error } = await db.rpc('trigger_emergency', {
    p_user_id: users.reporter!.id,
    p_client_request_id: crypto.randomUUID(),
    p_trigger_type: 'button', p_level: 2,
    p_lat: 19.076, p_lng: 72.8777, p_accuracy: 10, p_address_hint: 'RLS test',
  });
  if (error) throw new Error(`trigger: ${error.message}`);
  emergencyId = (emergency as { emergency_id: string }).emergency_id;
}, 180_000);

/** Cleanup must never fail the run: the assertions already passed by here. */
async function quietly(work: () => PromiseLike<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    // ignore
  }
}

afterAll(async () => {
  if (!db) return;
  await quietly(() => db.from('emergencies').delete().eq('id', emergencyId));
  for (const u of Object.values(users)) await quietly(() => db.auth.admin.deleteUser(u.id));
  await quietly(() => db.from('police_stations').delete().in('id', [stationId, farStationId]));
}, 120_000);

async function visibleEmergencies(client: SupabaseClient): Promise<number> {
  const { data } = await client.from('emergencies').select('id').eq('id', emergencyId);
  return data?.length ?? 0;
}

describe('who can see an emergency', () => {
  it('the reporter can', async () => {
    expect(await visibleEmergencies(users.reporter!.client)).toBe(1);
  });

  it('an accepted contact can', async () => {
    expect(await visibleEmergencies(users.family!.client)).toBe(1);
  });

  it('an officer at a dispatched station can', async () => {
    expect(await visibleEmergencies(users.officer!.client)).toBe(1);
  });

  it('an unrelated signed-in user cannot', async () => {
    expect(await visibleEmergencies(users.stranger!.client)).toBe(0);
  });

  it('an officer at a station it was never routed to cannot', async () => {
    expect(await visibleEmergencies(users.farOfficer!.client)).toBe(0);
  });
});

describe('scoped child tables follow the same rule', () => {
  for (const table of ['emergency_timeline', 'emergency_locations', 'emergency_stations'] as const) {
    it(`${table}: stranger sees nothing`, async () => {
      const { data } = await users.stranger!.client.from(table).select('id').eq('emergency_id', emergencyId);
      expect(data ?? []).toHaveLength(0);
    });

    it(`${table}: reporter sees rows`, async () => {
      const { data } = await users.reporter!.client.from(table).select('id').eq('emergency_id', emergencyId);
      expect((data ?? []).length).toBeGreaterThan(0);
    });
  }
});

describe('privilege escalation is refused', () => {
  it('a user cannot promote themselves to police', async () => {
    await users.stranger!.client.from('profiles').update({ role: 'police' }).eq('id', users.stranger!.id);

    // Read the truth with the service role - the client's own read could be
    // filtered rather than actually blocked.
    const { data } = await db.from('profiles').select('role').eq('id', users.stranger!.id).single();
    expect(data!.role).toBe('user');
  });

  it('a user cannot promote themselves to admin', async () => {
    await users.stranger!.client.from('profiles').update({ role: 'admin' }).eq('id', users.stranger!.id);
    const { data } = await db.from('profiles').select('role').eq('id', users.stranger!.id).single();
    expect(data!.role).toBe('user');
  });

  it('a non-admin cannot create a police station', async () => {
    const { error } = await users.stranger!.client.from('police_stations').insert({
      name: 'Rogue Station',
      location: 'POINT(72.8777 19.076)',
      coverage_radius_meters: 5000,
    });
    expect(error).toBeTruthy();
  });

  it('a non-admin cannot call the station-creation RPC', async () => {
    const { error } = await users.stranger!.client.rpc('admin_create_station', {
      p_name: 'Rogue', p_lat: 19.076, p_lng: 72.8777, p_radius: 1000,
      p_address: null, p_phone: null,
    });
    expect(error).toBeTruthy();
  });

  it('a signed-in user cannot call trigger_emergency directly as someone else', async () => {
    const { error } = await users.stranger!.client.rpc('trigger_emergency', {
      p_user_id: users.reporter!.id,
      p_client_request_id: crypto.randomUUID(),
      p_trigger_type: 'button', p_level: 3,
      p_lat: 19.076, p_lng: 72.8777, p_accuracy: null, p_address_hint: null,
    });
    expect(error, 'trigger_emergency must not be callable by clients').toBeTruthy();
  });

  it('a signed-in user cannot claim a case directly', async () => {
    const { error } = await users.stranger!.client.rpc('claim_emergency', {
      p_emergency_id: emergencyId, p_officer_id: users.stranger!.id,
    });
    expect(error).toBeTruthy();
  });
});

describe('the timeline is append-only', () => {
  it('rejects an update even from the service role', async () => {
    const { data: row } = await db
      .from('emergency_timeline').select('id').eq('emergency_id', emergencyId).limit(1).single();

    const { error } = await db
      .from('emergency_timeline')
      .update({ event_data: { tampered: true } })
      .eq('id', row!.id);

    expect(error, 'the immutability trigger must reject this').toBeTruthy();
  });

  it('rejects a delete even from the service role', async () => {
    const { data: row } = await db
      .from('emergency_timeline').select('id').eq('emergency_id', emergencyId).limit(1).single();

    const { error } = await db.from('emergency_timeline').delete().eq('id', row!.id);
    expect(error).toBeTruthy();
  });
});

describe('audio evidence is not a family feed', () => {
  it('an accepted contact cannot read audio metadata', async () => {
    const { data } = await users.family!.client
      .from('emergency_audio').select('id').eq('emergency_id', emergencyId);
    expect(data ?? []).toHaveLength(0);
  });

  it('the storage bucket is private', async () => {
    const { data } = await db.storage.getBucket('emergency-audio');
    expect(data!.public).toBe(false);
  });
});
