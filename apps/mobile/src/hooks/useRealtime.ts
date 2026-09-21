import { useEffect, useRef } from 'react';
import { supabase } from '../supabase';

type Handler = (payload: { eventType: string; new: any; old: any }) => void;

/**
 * Subscribes to postgres_changes for one table, optionally filtered.
 *
 * Authorisation is not this hook's job and must not be: Realtime evaluates the
 * subscriber's own JWT against the table's RLS policies before it delivers
 * anything, so a client that is not allowed to read a row simply never receives
 * an event for it. The `filter` here narrows traffic; it is not the security
 * boundary, and nothing in the app treats it as one.
 */
export function useTableSubscription(
  table: string,
  filter: string | null,
  handler: Handler,
  enabled = true,
): void {
  const cb = useRef(handler);
  cb.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const channelName = `${table}:${filter ?? 'all'}:${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase.channel(channelName);

    channel.on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
      (payload: any) => {
        cb.current({ eventType: payload.eventType, new: payload.new, old: payload.old });
      },
    );

    channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [table, filter, enabled]);
}

/** The station queue: new emergencies, claims and status changes, live. */
export function useStationQueueRealtime(stationId: string | null, onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!stationId) return;

    const channel = supabase.channel(`station:${stationId}`);

    // A new row in emergency_stations means a fresh dispatch to this station.
    channel.on(
      'postgres_changes' as any,
      { event: 'INSERT', schema: 'public', table: 'emergency_stations', filter: `station_id=eq.${stationId}` },
      () => cb.current(),
    );

    // Any change to an emergency: claims, escalations, status moves. RLS keeps
    // this scoped to emergencies routed to this officer's station.
    channel.on(
      'postgres_changes' as any,
      { event: 'UPDATE', schema: 'public', table: 'emergencies' },
      () => cb.current(),
    );

    channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [stationId]);
}

/** One emergency's live feed: status, level, location pings and timeline. */
export function useEmergencyRealtime(
  emergencyId: string | null,
  handlers: {
    onEmergency?: (row: any) => void;
    onLocation?: (row: any) => void;
    onTimeline?: (row: any) => void;
  },
): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!emergencyId) return;

    const channel = supabase.channel(`emergency:${emergencyId}`);

    channel.on(
      'postgres_changes' as any,
      { event: 'UPDATE', schema: 'public', table: 'emergencies', filter: `id=eq.${emergencyId}` },
      (payload: any) => ref.current.onEmergency?.(payload.new),
    );

    channel.on(
      'postgres_changes' as any,
      {
        event: 'INSERT',
        schema: 'public',
        table: 'emergency_locations',
        filter: `emergency_id=eq.${emergencyId}`,
      },
      (payload: any) => ref.current.onLocation?.(payload.new),
    );

    channel.on(
      'postgres_changes' as any,
      {
        event: 'INSERT',
        schema: 'public',
        table: 'emergency_timeline',
        filter: `emergency_id=eq.${emergencyId}`,
      },
      (payload: any) => ref.current.onTimeline?.(payload.new),
    );

    channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [emergencyId]);
}

/** Incoming notifications for the signed-in account. */
export function useNotificationRealtime(userId: string | null, onNotification: (row: any) => void): void {
  useTableSubscription(
    'notifications',
    userId ? `recipient_id=eq.${userId}` : null,
    (payload) => {
      if (payload.eventType === 'INSERT') onNotification(payload.new);
    },
    Boolean(userId),
  );
}
