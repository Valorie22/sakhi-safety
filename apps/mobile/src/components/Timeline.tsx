import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../theme';

export interface TimelineEvent {
  id: string;
  event_type: string;
  event_data: Record<string, any>;
  created_at: string;
}

const LABELS: Record<string, string> = {
  sos_triggered: 'SOS triggered',
  station_notified: 'Station notified',
  family_notified: 'Safety circle notified',
  case_claimed: 'Officer took the case',
  status_changed: 'Status changed',
  level_escalated: 'Level escalated',
  audio_started: 'Audio recording started',
  audio_available: 'Audio evidence uploaded',
  audio_failed: 'Audio upload failed',
  location_stale: 'Location updates lapsed',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

const TONES: Record<string, string> = {
  sos_triggered: colors.primary,
  level_escalated: colors.danger,
  case_claimed: colors.info,
  resolved: colors.success,
  cancelled: colors.textFaint,
  audio_failed: colors.warning,
};

function detail(event: TimelineEvent): string | null {
  const d = event.event_data ?? {};
  switch (event.event_type) {
    case 'sos_triggered':
      return `Triggered by ${d.trigger_type ?? 'unknown'} at level ${d.level ?? 1}`;
    case 'station_notified':
      if (d.matched === 0) return 'No active station covers this location';
      return d.station_code
        ? `${d.station_code}${d.distance_m != null ? ` · ${Math.round(d.distance_m)} m away` : ''}`
        : null;
    case 'family_notified':
      return `${d.count ?? 0} trusted contact${d.count === 1 ? '' : 's'}`;
    case 'case_claimed':
      return d.badge_number ? `Badge ${d.badge_number}` : null;
    case 'status_changed':
      return d.to ? String(d.to).replace('_', ' ') : null;
    case 'level_escalated':
      return `Level ${d.from} to ${d.to}${d.automatic ? ' (no response in time)' : ''}`;
    case 'cancelled':
      return d.reason ? String(d.reason) : 'Cancelled by the reporter';
    case 'audio_available':
      return d.duration_seconds ? `${Math.round(d.duration_seconds)}s segment` : null;
    default:
      return null;
  }
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <Text style={s.empty}>No events recorded yet.</Text>;
  }

  return (
    <View>
      {events.map((event, index) => {
        const tone = TONES[event.event_type] ?? colors.primarySoft;
        const isLast = index === events.length - 1;
        const sub = detail(event);

        return (
          <View key={event.id} style={s.row}>
            <View style={s.gutter}>
              <View style={[s.node, { backgroundColor: tone, borderColor: colors.bg }]} />
              {!isLast ? <View style={s.line} /> : null}
            </View>

            <View style={[s.content, isLast && { paddingBottom: 0 }]}>
              <Text style={s.label}>{LABELS[event.event_type] ?? event.event_type}</Text>
              {sub ? <Text style={s.detail}>{sub}</Text> : null}
              <Text style={s.time}>{time(event.created_at)}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row' },
  gutter: { width: 24, alignItems: 'center' },
  node: { width: 13, height: 13, borderRadius: 7, borderWidth: 2, marginTop: 3 },
  line: { width: 2, flex: 1, backgroundColor: colors.border, marginVertical: 2 },
  content: { flex: 1, paddingBottom: spacing.lg, paddingLeft: spacing.md },
  label: { ...type.body, color: colors.text, fontWeight: '700' },
  detail: { ...type.small, color: colors.textMuted, marginTop: 2 },
  time: { ...type.small, color: colors.textFaint, marginTop: 2, fontVariant: ['tabular-nums'] },
  empty: { ...type.small, color: colors.textFaint, padding: spacing.md },
});

