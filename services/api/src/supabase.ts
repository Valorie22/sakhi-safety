import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Service-role client. Bypasses RLS entirely, so every route that uses it must
 * do its own authorisation first. Never hand this client, or its key, to a
 * client application.
 */
export const admin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/**
 * A client bound to one end user's JWT. Reads through this client are subject
 * to RLS, which is what we want whenever we are simply fetching data on the
 * caller's behalf: the database re-checks the caller's rights for us.
 */
export function asUser(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
