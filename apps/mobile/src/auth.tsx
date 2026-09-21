import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { api } from './api';

export type Role = 'user' | 'police' | 'admin';

export interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
}

export interface Settings {
  sos_button_enabled: boolean;
  shake_enabled: boolean;
  shake_threshold: number;
  shake_count_required: number;
  shake_window_ms: number;
  shake_cooldown_ms: number;
  timer_enabled: boolean;
  timer_default_seconds: number;
  default_level: number;
  audio_opt_in: boolean;
}

interface AuthValue {
  session: Session | null;
  profile: Profile | null;
  settings: Settings | null;
  officer: { stationId: string; badgeNumber: string } | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; fullName: string; phone?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setSettings: (next: Settings) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [officer, setOfficer] = useState<{ stationId: string; badgeNumber: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    try {
      const me = await api.me();
      setProfile(me.profile);
      setSettings(me.settings);
      setOfficer(
        me.officer ? { stationId: me.officer.stationId, badgeNumber: me.officer.badgeNumber } : null,
      );
    } catch {
      // The session is valid but the API is unreachable. Keep the session so
      // the SOS path still works offline-queued rather than bouncing to login.
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) await loadProfile();
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      setSession(next);
      if (next) {
        await loadProfile();
      } else {
        setProfile(null);
        setSettings(null);
        setOfficer(null);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      settings,
      officer,
      loading,
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error) throw new Error(error.message);
      },
      signUp: async ({ email, password, fullName, phone }) => {
        const { error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          // The database trigger reads these into the profile row. It always
          // sets role 'user' - there is no way to ask for another role here.
          options: { data: { full_name: fullName, phone } },
        });
        if (error) throw new Error(error.message);
      },
      signOut: async () => {
        await api.registerPushToken(null).catch(() => {});
        await supabase.auth.signOut();
      },
      refresh: loadProfile,
      setSettings,
    }),
    [session, profile, settings, officer, loading, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
