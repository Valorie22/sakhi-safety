import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * Account lifecycle: sign-in, and deletion.
 *
 * Both of these broke in ways the rest of the suite could not see, because the
 * suite only ever created accounts through the Auth admin API and only ever
 * deleted them in cleanup where failures were swallowed.
 *
 * 1. Sign-in. Accounts seeded with raw `insert into auth.users` left GoTrue's
 *    token columns NULL. GoTrue scans them into Go strings, cannot hold NULL,
 *    and returns a 500 "Database error querying schema" - so every seeded demo
 *    account was unable to log in while every test-created account worked.
 *
 * 2. Deletion. emergency_timeline.actor_id was `on delete set null`, so
 *    removing a profile issued an UPDATE against an append-only table and the
 *    delete failed. Then the cascade delete of the timeline hit the same
 *    trigger. An account that had ever appeared in a timeline could not be
 *    removed at all, which is a data-deletion problem, not a nuisance.
 */

const URL_ = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const PASSWORD = 'Lifecycle!pass123';

let db: SupabaseClient;
let tag: string;
const createdUsers: string[] = [];
let stationId = '';

async function quietly(work: () => PromiseLike<unknown>): Promise<void> {
  try { await work(); } catch { /* cleanup must not fail the run */ }
}

beforeAll(async () => {
  db = createClient(URL_, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  tag = crypto.randomUUID().slice(0, 8);

  const { data: station } = await db.rpc('admin_create_station', {
    p_name: `Lifecycle ${tag}`, p_lat: 19.076, p_lng: 72.8777, p_radius: 6000,
    p_address: null, p_phone: null,
  });
  stationId = (station as { id: string }).id;
}, 120_000);

afterAll(async () => {
  for (const id of createdUsers) await quietly(() => db.auth.admin.deleteUser(id));
  if (stationId) await quietly(() => db.from('police_stations').delete().eq('id', stationId));
}, 120_000);

describe('every existing account can actually sign in', () => {
  // The demo accounts are the ones that were broken. Guard them by name so a
  // future re-seed with raw SQL fails here instead of on someone's phone.
  for (const email of [
    'alice@example.com',
    'bob@example.com',
    'off1@example.com',
    'off2@example.com',
    'admin@example.com',
  ]) {
    it(`${email} can sign in`, async () => {
      const client = createClient(URL_, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await client.auth.signInWithPassword({
        email, password: 'Demo!pass1',
      });
      expect(error, `${email}: ${error?.message ?? ''}`).toBeNull();
      expect(data.session?.access_token).toBeTruthy();
    }, 30_000);
  }

  it('no account has NULL in the columns GoTrue reads as strings', async () => {
    // A NULL in any of these makes that user unreadable and their sign-in 500.
    const { data, error } = await db.rpc('count_users_with_null_auth_tokens');
    expect(error).toBeNull();
    expect(data, 'seed accounts must use empty strings, not NULL').toBe(0);
  }, 30_000);
});

describe('an account that appears in a timeline can still be deleted', () => {
  it('deletes cleanly, and the incident goes with it', async () => {
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email: `lifecycle-${tag}@example.com`,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Lifecycle Probe' },
    });
    expect(createError).toBeNull();
    const userId = created!.user!.id;

    const { data: emergency } = await db.rpc('trigger_emergency', {
      p_user_id: userId,
      p_client_request_id: crypto.randomUUID(),
      p_trigger_type: 'button', p_level: 1,
      p_lat: 19.076, p_lng: 72.8777, p_accuracy: 5, p_address_hint: null,
    });
    const emergencyId = (emergency as { emergency_id: string }).emergency_id;

    // They are named in the timeline, which is what used to block the delete.
    const { data: before } = await db
      .from('emergency_timeline').select('id').eq('actor_id', userId);
    expect((before ?? []).length).toBeGreaterThan(0);

    const { error: deleteError } = await db.auth.admin.deleteUser(userId);
    expect(deleteError, 'deleting a user in a timeline must not be blocked').toBeNull();

    const { data: after } = await db
      .from('emergencies').select('id').eq('id', emergencyId);
    expect(after ?? []).toHaveLength(0);
  }, 90_000);

  it('still refuses to delete one event from a live incident', async () => {
    const { data: created } = await db.auth.admin.createUser({
      email: `lifecycle-keep-${tag}@example.com`,
      password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: 'Keeper' },
    });
    const userId = created!.user!.id;
    createdUsers.push(userId);

    const { data: emergency } = await db.rpc('trigger_emergency', {
      p_user_id: userId,
      p_client_request_id: crypto.randomUUID(),
      p_trigger_type: 'button', p_level: 1,
      p_lat: 19.076, p_lng: 72.8777, p_accuracy: 5, p_address_hint: null,
    });
    const emergencyId = (emergency as { emergency_id: string }).emergency_id;

    // The emergency still exists, so this is history-editing, not incident removal.
    const { error } = await db
      .from('emergency_timeline')
      .delete()
      .eq('emergency_id', emergencyId)
      .eq('event_type', 'sos_triggered');

    expect(error, 'dropping one event from a live incident must be refused').toBeTruthy();

    const { error: updateError } = await db
      .from('emergency_timeline')
      .update({ event_data: { tampered: true } })
      .eq('emergency_id', emergencyId);

    expect(updateError, 'editing history must be refused').toBeTruthy();

    await quietly(() => db.from('emergencies').delete().eq('id', emergencyId));
  }, 90_000);
});
