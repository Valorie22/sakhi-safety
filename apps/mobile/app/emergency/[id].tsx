import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import { MapPanel } from '../../src/components/MapPanel';
import { Timeline, type TimelineEvent } from '../../src/components/Timeline';
import { Button, ConnectivityBar, LevelBadge, Loading, StatusPill } from '../../src/components/ui';
import { useLocationTracking } from '../../src/hooks/useLocationTracking';
import { useAudioEvidence } from '../../src/hooks/useAudioEvidence';
import { useEmergencyRealtime } from '../../src/hooks/useRealtime';
import { colors, levels, radius, spacing, type } from '../../src/theme';

const CLOSED = ['resolved', 'cancelled'];

function elapsed(since: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The active-emergency screen.
 *
 * While an emergency is running this is the entire interface: no tabs, no back
 * gesture, nothing to navigate into. Everything on screen answers one of four
 * questions - what level is this, has an officer got it, is my location getting
 * through, and how do I stand down.
 */
export default function EmergencyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, settings } = useAuth();
  const router = useRouter();

  useKeepAwake(); // The screen must not sleep during an incident.

  const [emergency, setEmergency] = useState<any>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [trail, setTrail] = useState<Array<{ lat: number; lng: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const isMine = emergency?.user_id === profile?.id;
  const closed = emergency ? CLOSED.includes(emergency.status) : false;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, events, locations] = await Promise.all([
        api.emergency(id),
        api.timeline(id),
        api.locations(id, 100),
      ]);
      setEmergency(detail.emergency);
      setTimeline(events.timeline);
      setTrail(
        [...locations.locations].reverse().map((l: any) => ({ lat: l.lat, lng: l.lng })),
      );
    } catch {
      // Realtime will catch us up; don't blank the screen on one failed fetch.
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the elapsed clock honest.
  useEffect(() => {
    if (closed) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [closed]);

  useEmergencyRealtime(id ?? null, {
    onEmergency: (row) => setEmergency((prev: any) => ({ ...prev, ...row })),
    onTimeline: (row) => setTimeline((prev) => [...prev, row as TimelineEvent]),
    onLocation: (row) => setTrail((prev) => [...prev, { lat: row.lat, lng: row.lng }].slice(-100)),
  });

  // Only the person in danger streams location and records audio.
  const tracking = useLocationTracking(isMine && !closed ? (id ?? null) : null, 15);

  const audio = useAudioEvidence({
    emergencyId: isMine && !closed ? (id ?? null) : null,
    level: emergency?.level ?? 1,
    enabled: Boolean(settings?.audio_opt_in),
  });

  const cancel = async (reason: string) => {
    setCancelOpen(false);
    try {
      await api.cancelEmergency(id!, reason);
      await audio.stop();
      await load();
    } catch (err) {
      Alert.alert('Could not cancel', err instanceof Error ? err.message : 'Try again');
    }
  };

  const escalate = async (level: 2 | 3) => {
    try {
      await api.escalate(id!, level);
      await load();
    } catch (err) {
      Alert.alert('Could not escalate', err instanceof Error ? err.message : 'Try again');
    }
  };

  const position = useMemo(() => trail[trail.length - 1] ?? null, [trail]);

  if (loading) return <Loading label="Opening your emergency" />;

  if (!emergency) {
    return (
      <View style={s.centered}>
        <Text style={s.notFound}>This emergency is not available to you.</Text>
        <Button title="Go back" onPress={() => router.replace('/(app)')} />
      </View>
    );
  }

  const meta = levels[(emergency.level as 1 | 2 | 3) ?? 1];
  const officer = emergency.officer;
  const stations = emergency.stations ?? [];

  return (
    <View style={[s.root, { backgroundColor: closed ? colors.bg : meta.bg }]}>
      <ScrollView contentContainerStyle={s.content}>
        <View style={s.headline}>
          <Text style={[s.status, { color: closed ? colors.textMuted : meta.color }]}>
            {closed ? emergency.status === 'resolved' ? 'RESOLVED' : 'CANCELLED' : 'EMERGENCY ACTIVE'}
          </Text>
          <Text style={s.code}>{emergency.emergency_code}</Text>
          {!closed ? <Text style={s.elapsed}>{elapsed(emergency.created_at)}</Text> : null}
        </View>

        <View style={s.badges}>
          <LevelBadge level={emergency.level} />
          <StatusPill status={emergency.status} />
        </View>

        {isMine && !closed ? (
          <ConnectivityBar
            online={tracking.online}
            queued={tracking.queued}
            lastSentAt={tracking.lastSentAt}
          />
        ) : null}

        {/* Police status: the single thing she most wants to know. */}
        <View style={s.panel}>
          <Text style={s.panelLabel}>POLICE</Text>
          {officer ? (
            <>
              <Text style={s.panelValue}>
                {officer.profile?.full_name ?? 'Officer'} · Badge {officer.badge_number}
              </Text>
              <Text style={s.panelSub}>
                {officer.station?.station_code} {officer.station?.name}
              </Text>
            </>
          ) : stations.length > 0 ? (
            <>
              <Text style={s.panelValue}>
                {stations.length} station{stations.length === 1 ? '' : 's'} alerted
              </Text>
              <Text style={s.panelSub}>
                {stations.map((st: any) => st.station?.station_code).filter(Boolean).join(', ')} · waiting for
                an officer to take the case
              </Text>
            </>
          ) : (
            <>
              <Text style={[s.panelValue, { color: colors.warning }]}>No station covers this location</Text>
              <Text style={s.panelSub}>Your safety circle was alerted. For police, call 112 directly.</Text>
            </>
          )}
        </View>

        {isMine ? (
          <View style={s.panel}>
            <Text style={s.panelLabel}>AUDIO EVIDENCE</Text>
            {emergency.level < 2 ? (
              <Text style={s.panelSub}>Not recording. Audio starts at Level 2.</Text>
            ) : audio.permission === 'denied' ? (
              <Text style={[s.panelSub, { color: colors.warning }]}>
                Microphone denied — location and dispatch are still running.
              </Text>
            ) : audio.capReached ? (
              <Text style={s.panelSub}>Recording limit reached. Everything captured has been uploaded.</Text>
            ) : audio.recording ? (
              <>
                <Text style={[s.panelValue, { color: colors.danger }]}>
                  ● Recording · {Math.floor(audio.elapsedSeconds / 60)}:
                  {String(audio.elapsedSeconds % 60).padStart(2, '0')}
                </Text>
                <Text style={s.panelSub}>
                  {audio.uploading ? 'Uploading a segment…' : 'Only the responding officers can open this.'}
                </Text>
              </>
            ) : (
              <Text style={s.panelSub}>{audio.error ?? 'Starting the recorder…'}</Text>
            )}
          </View>
        ) : null}

        <MapPanel
          points={position ? [{ lat: position.lat, lng: position.lng, label: 'Current position' }] : []}
          trail={trail}
          height={220}
        />

        {!closed && isMine ? (
          <View style={s.actions}>
            {emergency.level < 3 ? (
              <Button
                title={`Escalate to Level ${emergency.level + 1}`}
                variant="secondary"
                onPress={() => void escalate((emergency.level + 1) as 2 | 3)}
              />
            ) : null}

            <Pressable
              onPress={() => setCancelOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="I am safe. Cancel this emergency."
              style={({ pressed }) => [s.standDown, pressed && { opacity: 0.85 }]}
            >
              <Text style={s.standDownText}>I'M SAFE — STAND DOWN</Text>
            </Pressable>
          </View>
        ) : null}

        {closed ? (
          <Button title="Back to home" onPress={() => router.replace('/(app)')} style={{ marginTop: spacing.lg }} />
        ) : null}

        <Text style={s.sectionHeading}>WHAT HAS HAPPENED</Text>
        <View style={s.timelineCard}>
          <Timeline events={timeline} />
        </View>
      </ScrollView>

      <CancelSheet visible={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={cancel} />
    </View>
  );
}

/**
 * Cancellation is deliberately two steps with a reason.
 *
 * Someone under duress can be made to cancel. A second, explicit confirmation
 * is not security, but it does mean a fumbled tap cannot quietly call off the
 * police, and the reason is written to the permanent timeline either way.
 */
function CancelSheet({
  visible,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const reasons = [
    'I am safe now',
    'False alarm',
    'The situation resolved itself',
    'I have other help',
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>Stand down?</Text>
          <Text style={s.sheetBody}>
            This tells the alerted stations and your safety circle that you are no longer in danger, and stops
            location sharing and any recording. It stays on the permanent record.
          </Text>

          {reasons.map((reason) => (
            <Button key={reason} title={reason} variant="secondary" onPress={() => onConfirm(reason)} />
          ))}

          <Button title="No, keep the emergency running" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, paddingTop: spacing.xxl * 1.6, paddingBottom: spacing.xxl * 2 },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFound: { ...type.heading, color: colors.textMuted, textAlign: 'center', marginBottom: spacing.lg },
  headline: { marginBottom: spacing.lg },
  status: { ...type.label, fontSize: 15 },
  code: { fontSize: 40, fontWeight: '900', color: colors.text, letterSpacing: -0.5 },
  elapsed: { ...type.body, color: colors.textMuted, fontVariant: ['tabular-nums'], marginTop: 2 },
  badges: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginBottom: spacing.lg },
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  panelLabel: { ...type.label, color: colors.textFaint, marginBottom: spacing.sm },
  panelValue: { ...type.heading, color: colors.text },
  panelSub: { ...type.small, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 20 },
  actions: { marginTop: spacing.md },
  standDown: {
    backgroundColor: colors.success,
    borderRadius: radius.lg,
    paddingVertical: spacing.xl,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  standDownText: { fontSize: 18, fontWeight: '900', color: '#04281C', letterSpacing: 0.8 },
  sectionHeading: { ...type.label, color: colors.textFaint, marginTop: spacing.xl, marginBottom: spacing.md },
  timelineCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  sheetTitle: { ...type.title, color: colors.text, marginBottom: spacing.sm },
  sheetBody: { ...type.small, color: colors.textMuted, marginBottom: spacing.lg, lineHeight: 20 },
});
