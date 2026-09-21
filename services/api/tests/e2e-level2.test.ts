import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Server } from 'node:http';
import 'dotenv/config';
import { createApp } from '../src/index.js';

/**
 * The whole Level 2 incident, driven through the real HTTP API with real user
 * JWTs — no service-role shortcuts except for fixtures and for reading back the
 * truth at the end.
 *
 * This is the path that most needed proving without a phone in hand: the audio
 * evidence chain. A recording is registered, pushed to private storage through
 * a signed upload URL, then fetched back by an authorised officer through a
 * short-lived signed download URL — and refused for everyone else.
 *
 *   reporter triggers L2
 *     -> dispatched to the covering station
 *     -> registers an audio segment, uploads bytes, marks it uploaded
 *     -> officer claims the case
 *     -> officer gets a signed URL and the bytes come back byte-identical
 *     -> an unrelated user is refused (403)
 *     -> the access is written to evidence_access_log
 *     -> officer walks status to resolved
 *     -> location pings are refused once the case is closed
 */

const URL_ = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const PASSWORD = 'E2eTest!pass123';

let db: SupabaseClient;
let server: Server;
let base: string;
let tag: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
let stationId = '';
let emergencyId = '';
let audioId = '';

const AUDIO_BYTES = Buffer.from('fake-m4a-evidence-payload-' + Math.random().toString(36), 'utf8');

async function makeUser(key: string, name: string): Promise<void> {
  const email = `e2e-${key}-${tag}@example.com`;
  const { data, error } = await db.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: name },
  });
  if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
  ids[key] = data.user.id;

  const client = createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: session, error: signInError } =
    await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError || !session.session) throw new Error(`signIn ${key}: ${signInError?.message}`);
  tokens[key] = session.session.access_token;
}

async function call(
  as: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function quietly(work: () => PromiseLike<unknown>): Promise<void> {
  try { await work(); } catch { /* cleanup must not fail the run */ }
}

beforeAll(async () => {
  db = createClient(URL_, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  tag = crypto.randomUUID().slice(0, 8);

  server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 4000}`;

  await makeUser('reporter', 'E2E Reporter');
  await makeUser('officer', 'E2E Officer');
  await makeUser('stranger', 'E2E Stranger');

  const { data: station } = await db.rpc('admin_create_station', {
    p_name: `E2E Station ${tag}`, p_lat: 19.076, p_lng: 72.8777, p_radius: 6000,
    p_address: null, p_phone: null,
  });
  stationId = (station as { id: string }).id;

  await db.from('profiles').update({ role: 'police' }).eq('id', ids.officer!);
  await db.from('police_officers').insert({
    id: ids.officer!, station_id: stationId, badge_number: `E2E-${tag}`,
  });

  // Re-issue the officer's token so the API sees the promoted role.
  const oc = createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: s } = await oc.auth.signInWithPassword({
    email: `e2e-officer-${tag}@example.com`, password: PASSWORD,
  });
  tokens.officer = s.session!.access_token;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (!db) return;
  await quietly(() => db.from('emergencies').delete().eq('id', emergencyId));
  for (const id of Object.values(ids)) await quietly(() => db.auth.admin.deleteUser(id));
  await quietly(() => db.from('police_stations').delete().eq('id', stationId));
}, 120_000);

describe('level 2 incident, end to end over HTTP', () => {
  it('reporter triggers a level 2 emergency and it reaches the covering station', async () => {
    const res = await call('reporter', '/api/v1/emergencies', {
      method: 'POST',
      body: {
        clientRequestId: crypto.randomUUID(),
        triggerType: 'button',
        level: 2,
        lat: 19.076,
        lng: 72.8777,
        accuracy: 8,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.stations_notified).toBeGreaterThanOrEqual(1);
    emergencyId = res.body.emergency_id;
    expect(emergencyId).toBeTruthy();
  }, 60_000);

  it('the case shows up in that station queue', async () => {
    const res = await call('officer', '/api/v1/police/queue');
    expect(res.status).toBe(200);
    expect(res.body.queue.some((e: any) => e.id === emergencyId)).toBe(true);
  }, 30_000);

  it('registers an audio segment and returns a signed upload url', async () => {
    const res = await call('reporter', `/api/v1/emergencies/${emergencyId}/audio`, {
      method: 'POST',
      body: { segmentIndex: 0 },
    });

    expect(res.status).toBe(201);
    expect(res.body.uploadUrl).toContain('/storage/v1/');
    audioId = res.body.audioId;

    // Push the bytes the way the phone does.
    const put = await fetch(res.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/m4a', 'x-upsert': 'true' },
      body: AUDIO_BYTES,
    });
    expect(put.ok, `upload failed: ${put.status} ${await put.text().catch(() => '')}`).toBe(true);

    const done = await call('reporter', `/api/v1/emergencies/${emergencyId}/audio/${audioId}`, {
      method: 'PATCH',
      body: { status: 'uploaded', durationSeconds: 12, sizeBytes: AUDIO_BYTES.length },
    });
    expect(done.status).toBe(200);
  }, 90_000);

  it('a level 1 emergency is refused audio registration', async () => {
    const l1 = await call('reporter', '/api/v1/emergencies', {
      method: 'POST',
      body: {
        clientRequestId: crypto.randomUUID(),
        triggerType: 'button', level: 1, lat: 19.076, lng: 72.8777,
      },
    });
    const otherId = l1.body.emergency_id;

    const res = await call('reporter', `/api/v1/emergencies/${otherId}/audio`, {
      method: 'POST', body: { segmentIndex: 0 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('level_too_low');

    await quietly(() => db.from('emergencies').delete().eq('id', otherId));
  }, 60_000);

  it('an officer claims the case', async () => {
    const res = await call('officer', `/api/v1/police/emergencies/${emergencyId}/claim`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  }, 30_000);

  it('the officer gets a signed url and the bytes come back byte-identical', async () => {
    const res = await call('officer', `/api/v1/emergencies/${emergencyId}/audio/${audioId}/url`);
    expect(res.status).toBe(200);
    expect(res.body.expiresInSeconds).toBeLessThanOrEqual(3600);

    const got = await fetch(res.body.url);
    expect(got.ok).toBe(true);
    const bytes = Buffer.from(await got.arrayBuffer());
    expect(bytes.equals(AUDIO_BYTES)).toBe(true);
  }, 60_000);

  it('an unrelated user is refused the evidence', async () => {
    const res = await call('stranger', `/api/v1/emergencies/${emergencyId}/audio/${audioId}/url`);
    expect(res.status).toBe(403);
  }, 30_000);

  it('the audio file is not reachable without a signature', async () => {
    const { data: row } = await db
      .from('emergency_audio').select('storage_path').eq('id', audioId).single();

    const naked = await fetch(`${URL_}/storage/v1/object/public/emergency-audio/${row!.storage_path}`);
    expect(naked.ok, 'a private object must not be served from the public path').toBe(false);
  }, 30_000);

  it('the access was written to evidence_access_log', async () => {
    const { data } = await db
      .from('evidence_access_log')
      .select('actor_id, action')
      .eq('emergency_id', emergencyId);

    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
    expect(data!.some((r: any) => r.actor_id === ids.officer)).toBe(true);
    // The refused stranger must NOT appear: no URL was ever issued to them.
    expect(data!.some((r: any) => r.actor_id === ids.stranger)).toBe(false);
  }, 30_000);

  it('the officer walks the case to resolved', async () => {
    for (const status of ['responding', 'on_scene', 'resolved'] as const) {
      const res = await call('officer', `/api/v1/police/emergencies/${emergencyId}/status`, {
        method: 'POST', body: { status },
      });
      expect(res.status, `transition to ${status}`).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  }, 60_000);

  it('location pings are refused once the case is closed', async () => {
    const res = await call('reporter', `/api/v1/emergencies/${emergencyId}/locations`, {
      method: 'POST', body: { lat: 19.077, lng: 72.878 },
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('emergency_closed');
  }, 30_000);

  it('recording was stopped when the case closed', async () => {
    const { data } = await db
      .from('emergency_audio').select('status, ended_at').eq('emergency_id', emergencyId);
    expect(data!.every((a: any) => a.status !== 'recording')).toBe(true);
  }, 30_000);

  it('the timeline tells the whole story, in order', async () => {
    const res = await call('officer', `/api/v1/emergencies/${emergencyId}/timeline`);
    expect(res.status).toBe(200);

    const kinds = res.body.timeline.map((e: any) => e.event_type);
    for (const expected of [
      'sos_triggered', 'station_notified', 'family_notified',
      'audio_started', 'audio_available', 'case_claimed', 'status_changed', 'resolved',
    ]) {
      expect(kinds, `timeline missing ${expected}`).toContain(expected);
    }

    const times = res.body.timeline.map((e: any) => new Date(e.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }, 30_000);
});
