import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api, type ClaimResult } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { MapPanel } from '../../../src/components/MapPanel';
import { Timeline, type TimelineEvent } from '../../../src/components/Timeline';
import { Body, Button, Card, ErrorNote, H2, LevelBadge, Loading, Row, StatusPill } from '../../../src/components/ui';
import { useEmergencyRealtime } from '../../../src/hooks/useRealtime';
import { colors, levels, radius, spacing, type } from '../../../src/theme';

export default function PoliceCase() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();

  const [emergency, setEmergency] = useState<any>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [trail, setTrail] = useState<Array<{ lat: number; lng: number; recorded_at?: string }>>([]);
  const [audio, setAudio] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [takenBy, setTakenBy] = useState<ClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, events, locations, segments] = await Promise.all([
        api.emergency(id),
        api.timeline(id),
        api.locations(id, 200),
        api.audioSegments(id).catch(() => ({ segments: [] })),
      ]);
      setEmergency(detail.emergency);
      setTimeline(events.timeline);
      setTrail([...locations.locations].reverse());
      setAudio(segments.segments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the case');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEmergencyRealtime(id ?? null, {
    onEmergency: (row) => {
      setEmergency((prev: any) => ({ ...prev, ...row }));

      // Someone else won the race. Say so immediately, without a refresh and
      // without waiting for our own request to come back.
      if (row.claimed_by_officer_id && row.claimed_by_officer_id !== profile?.id) {
        setTakenBy((prev) => prev ?? { ok: false, reason: 'already_claimed' });
        void load();
      }
    },
    onTimeline: (row) => setTimeline((prev) => [...prev, row as TimelineEvent]),
    onLocation: (row) => setTrail((prev) => [...prev, { lat: row.lat, lng: row.lng }].slice(-200)),
  });

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.claimCase(id!);
      if (result.ok) {
        await load();
      } else {
        setTakenBy(result);
      }
    } catch (err: any) {
      // A 409 from the API carries the winner's details in its body.
      const body = err?.body as ClaimResult | undefined;
      if (body?.reason === 'already_claimed') setTakenBy(body);
      else setError(err instanceof Error ? err.message : 'Could not take the case');
    } finally {
      setBusy(false);
    }
  };

  const advance = async (status: 'responding' | 'on_scene' | 'resolved') => {
    setBusy(true);
    try {
      await api.setCaseStatus(id!, status);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the case');
    } finally {
      setBusy(false);
    }
  };

  const playAudio = async (audioId: string) => {
    try {
      const { url } = await api.audioUrl(id!, audioId);
      // Short-lived signed URL, issued only after the server re-checked that
      // this officer's station was dispatched to this emergency.
      await Linking.openURL(url);
    } catch (err) {
      Alert.alert('Could not open evidence', err instanceof Error ? err.message : 'Try again');
    }
  };

  if (loading) return <Loading label="Opening case" />;

  if (!emergency) {
    return (
      <ScrollView contentContainerStyle={s.centered}>
        <Text style={s.notFound}>This case is not available to your station.</Text>
        <Button title="Back to queue" onPress={() => router.replace('/(police)/queue')} />
      </ScrollView>
    );
  }

  const meta = levels[(emergency.level as 1 | 2 | 3) ?? 1];
  const mine = emergency.claimed_by_officer_id === profile?.id;
  const claimable = emergency.status === 'active' && !emergency.claimed_by_officer_id;
  const position = trail[trail.length - 1];
  const lastPing = trail[trail.length - 1] as any;
  const stale =
    lastPing?.recorded_at && Date.now() - new Date(lastPing.recorded_at).getTime() > 60_000;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xxl * 1.5, paddingBottom: spacing.xxl * 2 }}
    >
      {error ? <ErrorNote message={error} /> : null}

      <View style={[s.hero, { backgroundColor: meta.bg, borderColor: meta.color }]}>
        <Text style={s.code}>{emergency.emergency_code}</Text>
        <Row style={{ marginTop: spacing.sm, flexWrap: 'wrap' }}>
          <LevelBadge level={emergency.level} />
          <StatusPill status={emergency.status} />
        </Row>
      </View>

      {takenBy?.reason === 'already_claimed' ? (
        <View style={s.taken}>
          <Text style={s.takenTitle}>CASE ALREADY TAKEN</Text>
          <Text style={s.takenBody}>
            {takenBy.officer_name ?? emergency.officer?.profile?.full_name ?? 'Another officer'}
            {takenBy.badge_number ? ` · Badge ${takenBy.badge_number}` : ''} is handling this case.
          </Text>
        </View>
      ) : null}

      <Card>
        <Text style={s.label}>REPORTER</Text>
        <Text style={s.value}>{emergency.reporter?.full_name ?? 'Unknown'}</Text>
        {emergency.reporter?.phone ? (
          <Button
            title={`Call ${emergency.reporter.phone}`}
            variant="secondary"
            onPress={() => void Linking.openURL(`tel:${emergency.reporter.phone}`)}
            style={{ marginTop: spacing.md }}
          />
        ) : null}
      </Card>

      <Card>
        <Text style={s.label}>TRIGGER</Text>
        <Text style={s.value}>{emergency.trigger_type}</Text>
        <Text style={s.sub}>Started {new Date(emergency.created_at).toLocaleString()}</Text>
        {emergency.address_hint ? <Text style={s.sub}>{emergency.address_hint}</Text> : null}
      </Card>

      <Card>
        <Text style={s.label}>ASSIGNED</Text>
        {emergency.officer ? (
          <>
            <Text style={s.value}>
              {emergency.officer.profile?.full_name ?? 'Officer'} · Badge {emergency.officer.badge_number}
            </Text>
            <Text style={s.sub}>
              {emergency.officer.station?.station_code} · claimed{' '}
              {emergency.claimed_at ? new Date(emergency.claimed_at).toLocaleTimeString() : ''}
            </Text>
          </>
        ) : (
          <Text style={[s.value, { color: colors.warning }]}>Nobody has taken this case</Text>
        )}
      </Card>

      <H2>Location</H2>
      {stale ? (
        <View style={s.staleStrip}>
          <Text style={s.staleText}>
            STALE · no position update for over a minute. The last known point is shown.
          </Text>
        </View>
      ) : null}

      <MapPanel
        points={position ? [{ lat: position.lat, lng: position.lng, label: 'Reporter' }] : []}
        trail={trail}
        height={260}
      />

      {position ? (
        <Button
          title="Open in maps"
          variant="secondary"
          onPress={() =>
            void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${position.lat},${position.lng}`)
          }
        />
      ) : null}

      {claimable ? (
        <Button title="TAKE CASE" onPress={claim} loading={busy} style={{ marginTop: spacing.lg }} />
      ) : null}

      {mine ? (
        <View style={{ marginTop: spacing.lg }}>
          <Text style={s.label}>UPDATE STATUS</Text>
          {emergency.status === 'claimed' ? (
            <Button title="I'm responding" onPress={() => void advance('responding')} loading={busy} />
          ) : null}
          {['claimed', 'responding'].includes(emergency.status) ? (
            <Button title="I'm on scene" variant="secondary" onPress={() => void advance('on_scene')} loading={busy} />
          ) : null}
          {['claimed', 'responding', 'on_scene'].includes(emergency.status) ? (
            <Button
              title="Resolve case"
              variant="secondary"
              onPress={() =>
                Alert.alert('Resolve this case?', 'This stops live location and closes the incident.', [
                  { text: 'Not yet', style: 'cancel' },
                  { text: 'Resolve', onPress: () => void advance('resolved') },
                ])
              }
              loading={busy}
            />
          ) : null}
          {emergency.level < 3 ? (
            <Button
              title={`Escalate to Level ${emergency.level + 1}`}
              variant="ghost"
              onPress={async () => {
                await api.policeEscalate(id!, (emergency.level + 1) as 2 | 3).catch(() => {});
                await load();
              }}
            />
          ) : null}
        </View>
      ) : null}

      <H2>Audio evidence</H2>
      {emergency.level < 2 ? (
        <Body muted>This is a Level 1 case, so no audio was recorded.</Body>
      ) : audio.length === 0 ? (
        <Body muted>No audio segments have been uploaded yet.</Body>
      ) : (
        audio.map((segment) => (
          <Card key={segment.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View>
                <Text style={s.value}>Segment {segment.segment_index + 1}</Text>
                <Text style={s.sub}>
                  {segment.duration_seconds ? `${Math.round(segment.duration_seconds)}s · ` : ''}
                  {segment.status}
                </Text>
              </View>
              {segment.status === 'uploaded' ? (
                <Button title="Open" variant="secondary" onPress={() => void playAudio(segment.id)} />
              ) : null}
            </Row>
          </Card>
        ))
      )}
      <Text style={s.evidenceNote}>
        Opening a segment issues a link that expires in two minutes, and records who opened it.
      </Text>

      <H2>Timeline</H2>
      <Card>
        <Timeline events={timeline} />
      </Card>

      <Button title="Back to queue" variant="ghost" onPress={() => router.replace('/(police)/queue')} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.bg },
  notFound: { ...type.heading, color: colors.textMuted, textAlign: 'center', marginBottom: spacing.lg },
  hero: { borderRadius: radius.lg, borderWidth: 1.5, padding: spacing.lg, marginBottom: spacing.md },
  code: { fontSize: 32, fontWeight: '900', color: colors.text },
  label: { ...type.label, color: colors.textFaint, marginBottom: spacing.xs },
  value: { ...type.heading, color: colors.text },
  sub: { ...type.small, color: colors.textMuted, marginTop: 2 },
  taken: {
    backgroundColor: '#3A2412',
    borderWidth: 1.5,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  takenTitle: { ...type.label, color: colors.warning, fontSize: 14 },
  takenBody: { ...type.body, color: '#FFD9B0', marginTop: spacing.xs },
  staleStrip: {
    backgroundColor: '#3A2412',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  staleText: { ...type.small, color: colors.warning, fontWeight: '700' },
  evidenceNote: { ...type.small, color: colors.textFaint, marginTop: spacing.sm, lineHeight: 19 },
});
