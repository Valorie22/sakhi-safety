import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Body, Button, Empty, LevelBadge, Row, StatusPill } from '../../src/components/ui';
import { useStationQueueRealtime } from '../../src/hooks/useRealtime';
import { colors, levels, radius, spacing, type } from '../../src/theme';

function since(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * The shared station queue.
 *
 * Every officer at this station sees this exact list. It reorders itself live
 * from Realtime rather than polling, so an officer watching the screen sees a
 * colleague take a case without touching anything.
 */
export default function Queue() {
  const router = useRouter();
  const { profile, officer, signOut } = useAuth();

  const [queue, setQueue] = useState<any[]>([]);
  const [station, setStation] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const [q, st] = await Promise.all([
      api.policeQueue(showClosed).catch(() => ({ queue: [], stationId: '' })),
      api.policeStation().catch(() => ({ station: null, officer: null })),
    ]);
    setQueue(q.queue);
    if (st.station) setStation(st.station);
  }, [showClosed]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: a new dispatch, a claim by a colleague, an escalation.
  useStationQueueRealtime(officer?.stationId ?? null, () => void load());

  // Keep the "waiting for Xm" ages honest without refetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);

  const critical = queue.filter((e) => e.level === 3 && e.status === 'active');
  const unclaimed = queue.filter((e) => e.status === 'active' && e.level < 3);
  const inProgress = queue.filter((e) => ['claimed', 'responding', 'on_scene'].includes(e.status));
  const closed = queue.filter((e) => ['resolved', 'cancelled'].includes(e.status));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xxl * 1.6, paddingBottom: spacing.xxl * 2 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.primary}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.stationCode}>{station?.station_code ?? '—'}</Text>
          <Text style={s.stationName}>{station?.name ?? 'Loading station'}</Text>
          <Text style={s.officerLine}>
            {profile?.full_name} · Badge {officer?.badgeNumber}
          </Text>
        </View>
        <View style={s.liveDot}>
          <View style={s.dot} />
          <Text style={s.liveText}>LIVE</Text>
        </View>
      </View>

      {critical.length > 0 ? (
        <>
          <Text style={[s.sectionHeading, { color: colors.danger }]}>
            CRITICAL · {critical.length} NEEDS AN OFFICER NOW
          </Text>
          {critical.map((e) => (
            <CaseRow key={e.id} emergency={e} onPress={() => router.push(`/(police)/case/${e.id}`)} critical />
          ))}
        </>
      ) : null}

      <Text style={s.sectionHeading}>UNCLAIMED · {unclaimed.length}</Text>
      {unclaimed.length === 0 ? (
        <Empty title="Nothing waiting" hint="New emergencies routed to this station appear here instantly." />
      ) : (
        unclaimed.map((e) => (
          <CaseRow key={e.id} emergency={e} onPress={() => router.push(`/(police)/case/${e.id}`)} />
        ))
      )}

      <Text style={s.sectionHeading}>IN PROGRESS · {inProgress.length}</Text>
      {inProgress.length === 0 ? (
        <Body muted>No cases in progress at this station.</Body>
      ) : (
        inProgress.map((e) => (
          <CaseRow key={e.id} emergency={e} onPress={() => router.push(`/(police)/case/${e.id}`)} />
        ))
      )}

      <Button
        title={showClosed ? 'Hide closed cases' : 'Show closed cases'}
        variant="ghost"
        onPress={() => setShowClosed((v) => !v)}
        style={{ marginTop: spacing.xl }}
      />

      {showClosed
        ? closed.map((e) => (
            <CaseRow key={e.id} emergency={e} onPress={() => router.push(`/(police)/case/${e.id}`)} />
          ))
        : null}

      <Button title="Sign out" variant="ghost" onPress={() => void signOut()} style={{ marginTop: spacing.xl }} />
    </ScrollView>
  );
}

function CaseRow({
  emergency,
  onPress,
  critical,
}: {
  emergency: any;
  onPress: () => void;
  critical?: boolean;
}) {
  const meta = levels[(emergency.level as 1 | 2 | 3) ?? 1];
  const claimed = Boolean(emergency.claimed_by_officer_id);

  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <View
        style={[
          s.card,
          { borderColor: critical ? colors.danger : colors.border },
          critical && { borderWidth: 2, backgroundColor: meta.bg },
        ]}
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={s.code}>{emergency.emergency_code}</Text>
          <Text style={s.age}>{since(emergency.created_at)} ago</Text>
        </Row>

        <Row style={{ marginTop: spacing.sm, flexWrap: 'wrap' }}>
          <LevelBadge level={emergency.level} />
          <StatusPill status={emergency.status} />
        </Row>

        <Text style={s.reporter}>{emergency.reporter?.full_name ?? 'Unknown reporter'}</Text>

        <Text style={s.meta}>
          {emergency.trigger_type} trigger
          {emergency.distanceFromStationM != null
            ? ` · ${(emergency.distanceFromStationM / 1000).toFixed(1)} km from station`
            : ''}
        </Text>

        {claimed ? (
          <Text style={s.claimed}>
            Taken by {emergency.officer?.profile?.full_name ?? 'an officer'} · Badge{' '}
            {emergency.officer?.badge_number}
          </Text>
        ) : (
          <Text style={s.available}>Tap to review and take this case →</Text>
        )}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.lg },
  stationCode: { ...type.hero, color: colors.primary },
  stationName: { ...type.heading, color: colors.text },
  officerLine: { ...type.small, color: colors.textMuted, marginTop: 2 },
  liveDot: { alignItems: 'center', gap: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success },
  liveText: { ...type.label, fontSize: 10, color: colors.success },
  sectionHeading: { ...type.label, color: colors.textMuted, marginTop: spacing.xl, marginBottom: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  code: { ...type.heading, color: colors.text },
  age: { ...type.small, color: colors.textFaint, fontVariant: ['tabular-nums'] },
  reporter: { ...type.body, color: colors.text, marginTop: spacing.md, fontWeight: '600' },
  meta: { ...type.small, color: colors.textMuted, marginTop: 2 },
  claimed: { ...type.small, color: colors.info, marginTop: spacing.sm, fontWeight: '700' },
  available: { ...type.small, color: colors.primarySoft, marginTop: spacing.sm, fontWeight: '700' },
});
