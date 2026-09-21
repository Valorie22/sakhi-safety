import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import { SosButton } from '../../src/components/SosButton';
import { Body, Button, Card, ErrorNote, H2, LevelBadge, Row, Screen } from '../../src/components/ui';
import { useShakeDetector } from '../../src/hooks/useShakeDetector';
import { useEmergencyTimer } from '../../src/hooks/useEmergencyTimer';
import { getCurrentPosition } from '../../src/hooks/useLocationTracking';
import { submitTrigger, newRequestId, flush } from '../../src/lib/emergencyQueue';
import { colors, levels, radius, spacing, type } from '../../src/theme';

type TriggerKind = 'button' | 'shake' | 'timer';

export default function Home() {
  const { profile, settings } = useAuth();
  const router = useRouter();

  const [level, setLevel] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedNotice, setQueuedNotice] = useState(false);
  const [coverage, setCoverage] = useState<{ count: number; codes: string[] } | null>(null);
  const [timerPickerOpen, setTimerPickerOpen] = useState(false);

  useEffect(() => {
    if (settings?.default_level) setLevel(settings.default_level);
  }, [settings?.default_level]);

  /** Shared by all three trigger paths - button, shake and timer. */
  const trigger = useCallback(
    async (kind: TriggerKind) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setQueuedNotice(false);

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

      try {
        const position = await getCurrentPosition();

        if (!position) {
          setError(
            'Sakhi could not get your location, so there is nothing useful to send to a station. ' +
              'Turn on location access, or call 112 directly.',
          );
          return;
        }

        const result = await submitTrigger({
          clientRequestId: newRequestId(),
          triggerType: kind,
          level,
          lat: position.lat,
          lng: position.lng,
          accuracy: position.accuracy,
        });

        if (result) {
          router.push(`/emergency/${result.emergency_id}`);
        } else {
          // Saved to disk and retrying. Say so plainly rather than pretending
          // it went through.
          setQueuedNotice(true);
          void flush();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not raise the alert');
      } finally {
        setBusy(false);
      }
    },
    [busy, level, router],
  );

  const shake = useShakeDetector(
    {
      enabled: Boolean(settings?.shake_enabled),
      threshold: settings?.shake_threshold ?? 2.7,
      countRequired: settings?.shake_count_required ?? 3,
      windowMs: settings?.shake_window_ms ?? 2000,
      cooldownMs: settings?.shake_cooldown_ms ?? 15000,
    },
    () => void trigger('shake'),
  );

  const timer = useEmergencyTimer(() => void trigger('timer'));

  // Show which stations actually cover this spot, so coverage is never a
  // surprise at the worst possible moment.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const position = await getCurrentPosition();
      if (!position || cancelled) return;
      try {
        const res = await api.coverage(position.lat, position.lng);
        if (!cancelled) {
          setCoverage({ count: res.stations.length, codes: res.stations.map((s) => s.station_code) });
        }
      } catch {
        // Offline. The coverage card simply stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A running countdown takes over the screen entirely.
  if (timer.running) {
    return <CountdownScreen remaining={timer.remaining} total={timer.durationSeconds} onCancel={timer.cancel} />;
  }

  const levelMeta = levels[level as 1 | 2 | 3];

  return (
    <Screen>
      <Text style={s.greeting}>
        {profile?.full_name ? `Hello, ${profile.full_name.split(' ')[0]}` : 'Hello'}
      </Text>
      <Body muted>Hold the button to alert police and your safety circle.</Body>

      {error ? <ErrorNote message={error} /> : null}

      {queuedNotice ? (
        <View style={s.queued}>
          <Text style={s.queuedTitle}>Saved, but not sent yet</Text>
          <Text style={s.queuedBody}>
            There is no connection right now. Your alert is stored on this phone and will be sent the moment
            signal returns. Sakhi cannot reach the police without a connection — if you can, call 112 now.
          </Text>
        </View>
      ) : null}

      <SosButton onTrigger={() => void trigger('button')} disabled={busy || settings?.sos_button_enabled === false} />

      <Text style={s.levelHeading}>Alert level</Text>
      <View style={s.levelRow}>
        {([1, 2, 3] as const).map((value) => {
          const meta = levels[value];
          const selected = level === value;
          return (
            <Pressable
              key={value}
              onPress={() => setLevel(value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={meta.label}
              style={[
                s.levelChip,
                { borderColor: selected ? meta.color : colors.border },
                selected && { backgroundColor: meta.bg },
              ]}
            >
              <Text style={[s.levelChipTitle, { color: selected ? meta.color : colors.textMuted }]}>
                {meta.short}
              </Text>
              <Text style={[s.levelChipLabel, { color: selected ? meta.color : colors.textFaint }]}>
                {meta.label.split('·')[1]?.trim()}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={s.levelDescription}>{levelMeta.description}</Text>

      <H2>Other ways to trigger</H2>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={s.cardTitle}>Countdown timer</Text>
          <Text style={[s.cardStatus, { color: settings?.timer_enabled ? colors.success : colors.textFaint }]}>
            {settings?.timer_enabled ? 'READY' : 'OFF'}
          </Text>
        </Row>
        <Body muted style={{ marginTop: spacing.sm }}>
          Start a countdown before walking somewhere you are unsure about. If you do not cancel it, Sakhi
          raises the alarm for you.
        </Body>
        <Button
          title="Start a countdown"
          variant="secondary"
          disabled={!settings?.timer_enabled}
          onPress={() => setTimerPickerOpen(true)}
          style={{ marginTop: spacing.md }}
        />
      </Card>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={s.cardTitle}>Shake to alert</Text>
          <Text style={[s.cardStatus, { color: shake.active ? colors.success : colors.warning }]}>
            {shake.active ? 'WATCHING' : 'NOT ACTIVE'}
          </Text>
        </Row>
        <Body muted style={{ marginTop: spacing.sm }}>
          {shake.reason}
        </Body>
        {shake.active && shake.progress > 0 ? (
          <Text style={s.shakeProgress}>
            {shake.progress} of {settings?.shake_count_required ?? 3} shakes detected
          </Text>
        ) : null}
      </Card>

      {coverage ? (
        <Card>
          <Text style={s.cardTitle}>Coverage where you are</Text>
          {coverage.count > 0 ? (
            <Body muted style={{ marginTop: spacing.sm }}>
              {coverage.count} station{coverage.count === 1 ? '' : 's'} cover this location
              {coverage.codes.length ? `: ${coverage.codes.join(', ')}` : ''}.
            </Body>
          ) : (
            <Body style={{ marginTop: spacing.sm, color: colors.warning }}>
              No police station on this system covers where you are standing. Your safety circle will still be
              alerted, but no station will be. Call 112 for police.
            </Body>
          )}
        </Card>
      ) : null}

      <TimerPicker
        visible={timerPickerOpen}
        defaultSeconds={settings?.timer_default_seconds ?? 30}
        onClose={() => setTimerPickerOpen(false)}
        onStart={(seconds) => {
          setTimerPickerOpen(false);
          void timer.start(seconds);
        }}
      />
    </Screen>
  );
}

function TimerPicker({
  visible,
  defaultSeconds,
  onClose,
  onStart,
}: {
  visible: boolean;
  defaultSeconds: number;
  onClose: () => void;
  onStart: (seconds: number) => void;
}) {
  const options = Array.from(new Set([10, 30, 60, 300, defaultSeconds])).sort((a, b) => a - b);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.modalBackdrop}>
        <View style={s.modalSheet}>
          <Text style={s.modalTitle}>How long?</Text>
          <Text style={s.modalBody}>
            Sakhi raises a Level 1 alert when the countdown reaches zero. Cancel it any time before then and
            nothing is sent to anyone.
          </Text>

          {options.map((seconds) => (
            <Button
              key={seconds}
              title={seconds >= 60 ? `${Math.round(seconds / 60)} minute${seconds >= 120 ? 's' : ''}` : `${seconds} seconds`}
              variant="secondary"
              onPress={() => onStart(seconds)}
            />
          ))}

          <Button title="Never mind" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function CountdownScreen({
  remaining,
  total,
  onCancel,
}: {
  remaining: number;
  total: number;
  onCancel: () => void;
}) {
  const confirmCancel = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    void onCancel();
  };

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <View style={s.countdown}>
      <Text style={s.countdownLabel}>ALERT IN</Text>
      <Text style={s.countdownNumber}>
        {minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : seconds}
      </Text>
      <Text style={s.countdownHint}>
        Sakhi will alert police and your safety circle when this reaches zero.
      </Text>

      <View style={s.countdownTrack}>
        <View style={[s.countdownFill, { width: `${total > 0 ? (remaining / total) * 100 : 0}%` }]} />
      </View>

      <Pressable
        onPress={confirmCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel the countdown. Nothing will be sent."
        style={({ pressed }) => [s.cancelBig, pressed && { opacity: 0.85 }]}
      >
        <Text style={s.cancelBigText}>I'M SAFE — CANCEL</Text>
      </Pressable>

      <Text style={s.countdownFoot}>Cancelling now sends nothing to anyone.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  greeting: { ...type.hero, color: colors.text },
  levelHeading: { ...type.label, color: colors.textMuted, marginTop: spacing.lg, marginBottom: spacing.sm },
  levelRow: { flexDirection: 'row', gap: spacing.sm },
  levelChip: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
    minHeight: 64,
    justifyContent: 'center',
  },
  levelChipTitle: { fontSize: 20, fontWeight: '900' },
  levelChipLabel: { ...type.label, fontSize: 10, marginTop: 2 },
  levelDescription: { ...type.small, color: colors.textMuted, marginTop: spacing.md, lineHeight: 20 },
  cardTitle: { ...type.heading, color: colors.text },
  cardStatus: { ...type.label },
  shakeProgress: { ...type.small, color: colors.primarySoft, marginTop: spacing.sm, fontWeight: '700' },
  queued: {
    backgroundColor: '#3A2412',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  queuedTitle: { ...type.heading, color: colors.warning, marginBottom: spacing.sm },
  queuedBody: { ...type.small, color: '#FFD9B0', lineHeight: 20 },

  modalBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: { ...type.title, color: colors.text, marginBottom: spacing.sm },
  modalBody: { ...type.small, color: colors.textMuted, marginBottom: spacing.lg, lineHeight: 20 },

  countdown: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  countdownLabel: { ...type.label, color: colors.primarySoft, fontSize: 14 },
  countdownNumber: {
    fontSize: 140,
    fontWeight: '900',
    color: colors.primary,
    fontVariant: ['tabular-nums'],
    lineHeight: 156,
  },
  countdownHint: { ...type.body, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md, lineHeight: 23 },
  countdownTrack: {
    width: '100%',
    height: 8,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    marginTop: spacing.xl,
    overflow: 'hidden',
  },
  countdownFill: { height: '100%', backgroundColor: colors.primary },
  cancelBig: {
    marginTop: spacing.xxl,
    backgroundColor: colors.success,
    borderRadius: radius.lg,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xxl,
    width: '100%',
    alignItems: 'center',
  },
  cancelBigText: { fontSize: 20, fontWeight: '900', color: '#04281C', letterSpacing: 0.8 },
  countdownFoot: { ...type.small, color: colors.textFaint, marginTop: spacing.lg, textAlign: 'center' },
});
