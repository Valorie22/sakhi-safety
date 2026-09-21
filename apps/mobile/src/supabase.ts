import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.\n' +
      'Copy apps/mobile/.env.example to apps/mobile/.env and fill it in.',
  );
}

/**
 * The anon key is public by design. Everything this client can reach is decided
 * by Row Level Security against the signed-in user's JWT, so shipping it in the
 * bundle grants nothing on its own.
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar to parse a session out of.
    detectSessionInUrl: false,
  },
  realtime: {
    // Location pings during an emergency are the busiest channel.
    params: { eventsPerSecond: 10 },
  },
});
