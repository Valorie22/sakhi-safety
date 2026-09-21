import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Body, Button, Card, ErrorNote, Field, H2, Row, Screen } from '../../src/components/ui';
import { useShakeDetector } from '../../src/hooks/useShakeDetector';
import { colors, levels, radius, spacing, type } from '../../src/theme';

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={s.toggleRow}>
      <View style={{ flex: 1, paddingRight: spacing.md }}>
        <Text style={s.toggleLabel}>{label}</Text>
        {hint ? <Text style={s.toggleHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.surfaceAlt, true: colors.primaryDeep }}
        thumbColor={value ? colors.primary : colors.textFaint}
        accessibilityLabel={label}
      />
    </View>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Number(n.toFixed(2))));
  return (
    <View style={s.stepper}>
      <Text style={s.toggleLabel}>{label}</Text>
      <Row style={{ marginTop: spacing.sm }}>
        <Button title="−" variant="secondary" onPress={() => onChange(clamp(value - step))} style={{ width: 64 }} />
        <Text style={s.stepperValue}>
          {value}
          {suffix ?? ''}
        </Text>
        <Button title="+" variant="secondary" onPress={() => onChange(clamp(value + step))} style={{ width: 64 }} />
      </Row>
    </View>
  );
}

export default function Settings() {
  const { profile, settings, signOut, refresh, setSettings } = useAuth();
  const [local, setLocal] = useState(settings);
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setLocal(settings), [settings]);
  useEffect(() => {
    setFullName(profile?.full_name ?? '');
    setPhone(profile?.phone ?? '');
  }, [profile]);

  // Mirrors the live detector so the screen reports what is really happening.
  const shake = useShakeDetector(
    {
      enabled: Boolean(local?.shake_enabled),
      threshold: local?.shake_threshold ?? 2.7,
      countRequired: local?.shake_count_required ?? 3,
      windowMs: local?.shake_window_ms ?? 2000,
      cooldownMs: local?.shake_cooldown_ms ?? 15000,
    },
    () => Alert.alert('Shake detected', 'That shake would have raised an alert on the home screen.'),
  );

  if (!local) return <Screen><Body>Loading your settings…</Body></Screen>;

  const patch = (next: Partial<typeof local>) => setLocal({ ...local, ...next });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateProfile({ fullName: fullName.trim(), phone: phone.trim() });
      const res = await api.updateSettings({
        sosButtonEnabled: local.sos_button_enabled,
        shakeEnabled: local.shake_enabled,
        shakeThreshold: local.shake_threshold,
        shakeCountRequired: local.shake_count_required,
        shakeWindowMs: local.shake_window_ms,
        shakeCooldownMs: local.shake_cooldown_ms,
        timerEnabled: local.timer_enabled,
        timerDefaultSeconds: local.timer_default_seconds,
        defaultLevel: local.default_level,
        audioOptIn: local.audio_opt_in,
      });
      setSettings(res.settings);
      await refresh();
      Alert.alert('Saved', 'Your safety settings are up to date.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      {error ? <ErrorNote message={error} /> : null}

      <H2>You</H2>
      <Card>
        <Field label="Name" value={fullName} onChangeText={setFullName} />
        <Field
          label="Phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          hint="Shown to the officer who takes your case."
        />
        <Text style={s.readonly}>{profile?.email}</Text>
      </Card>

      <H2>Triggers</H2>

      <Card>
        <Toggle
          label="SOS button"
          hint="The large button on the home screen. Hold it for just over a second."
          value={local.sos_button_enabled}
          onChange={(v) => patch({ sos_button_enabled: v })}
        />
      </Card>

      <Card>
        <Toggle
          label="Shake to alert"
          hint="Shake the phone hard when you cannot look at the screen."
          value={local.shake_enabled}
          onChange={(v) => patch({ shake_enabled: v })}
        />

        {/* Honesty about when this really works matters more than the toggle. */}
        <View style={[s.statusStrip, { borderColor: shake.active ? colors.success : colors.warning }]}>
          <Text style={[s.statusStripText, { color: shake.active ? colors.success : colors.warning }]}>
            {shake.active ? 'Watching now' : 'Not watching'}
          </Text>
          <Text style={s.statusStripHint}>{shake.reason}</Text>
          <Text style={s.statusStripHint}>
            Shake detection only runs while Sakhi is open on screen. It cannot watch the sensor when the app is
            closed or in the background, so do not rely on it while your phone is in a bag.
          </Text>
        </View>

        {local.shake_enabled ? (
          <>
            <Stepper
              label="Shakes required"
              value={local.shake_count_required}
              min={2}
              max={10}
              step={1}
              onChange={(v) => patch({ shake_count_required: v })}
            />
            <Stepper
              label="Within"
              value={local.shake_window_ms / 1000}
              min={0.5}
              max={10}
              step={0.5}
              suffix="s"
              onChange={(v) => patch({ shake_window_ms: Math.round(v * 1000) })}
            />
            <Stepper
              label="Sensitivity threshold"
              value={local.shake_threshold}
              min={1.2}
              max={6}
              step={0.1}
              suffix="g"
              onChange={(v) => patch({ shake_threshold: v })}
            />
            <Text style={s.hint}>
              Lower is more sensitive. Below about 2g, ordinary walking can set it off.
            </Text>
            <Stepper
              label="Cooldown after a trigger"
              value={local.shake_cooldown_ms / 1000}
              min={0}
              max={300}
              step={5}
              suffix="s"
              onChange={(v) => patch({ shake_cooldown_ms: Math.round(v * 1000) })}
            />
          </>
        ) : null}
      </Card>

      <Card>
        <Toggle
          label="Countdown timer"
          hint="Start a countdown before a walk you are unsure about."
          value={local.timer_enabled}
          onChange={(v) => patch({ timer_enabled: v })}
        />
        {local.timer_enabled ? (
          <Stepper
            label="Default duration"
            value={local.timer_default_seconds}
            min={5}
            max={600}
            step={5}
            suffix="s"
            onChange={(v) => patch({ timer_default_seconds: v })}
          />
        ) : null}
      </Card>

      <H2>Alert level</H2>
      <Card>
        <Body muted>Which level a trigger starts at. You can raise it during an emergency.</Body>
        <View style={{ height: spacing.md }} />
        {([1, 2, 3] as const).map((value) => {
          const meta = levels[value];
          const selected = local.default_level === value;
          return (
            <Button
              key={value}
              title={meta.label}
              variant={selected ? 'primary' : 'secondary'}
              onPress={() => patch({ default_level: value })}
            />
          );
        })}
        <Text style={s.hint}>{levels[local.default_level as 1 | 2 | 3].description}</Text>
      </Card>

      <Card>
        <Toggle
          label="Record audio at Level 2 and above"
          hint="Ambient audio is uploaded to private storage. Only officers at a dispatched station can open it, and every access is logged."
          value={local.audio_opt_in}
          onChange={(v) => patch({ audio_opt_in: v })}
        />
      </Card>

      <Button title="Save settings" onPress={save} loading={saving} />

      <H2>What Sakhi cannot do</H2>
      <Card>
        <Body muted>
          Sakhi needs an internet connection to reach a police station. With no signal, an alert you trigger is
          saved on this phone and sent the moment a connection returns — but it does not reach anyone in the
          meantime. If you have no signal and you are in danger, call 112 directly.
        </Body>
      </Card>

      <Button title="Sign out" variant="ghost" onPress={() => void signOut()} />
    </Screen>
  );
}

const s = StyleSheet.create({
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  toggleLabel: { ...type.body, color: colors.text, fontWeight: '700' },
  toggleHint: { ...type.small, color: colors.textMuted, marginTop: 2, lineHeight: 19 },
  stepper: { marginTop: spacing.lg },
  stepperValue: {
    flex: 1,
    textAlign: 'center',
    ...type.title,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  hint: { ...type.small, color: colors.textFaint, marginTop: spacing.sm, lineHeight: 19 },
  readonly: { ...type.small, color: colors.textFaint },
  statusStrip: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    backgroundColor: colors.bgElevated,
  },
  statusStripText: { ...type.label },
  statusStripHint: { ...type.small, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 19 },
});
