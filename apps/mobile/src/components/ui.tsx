import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { colors, levels, radius, spacing, statusColors, statusLabels, type, HIT_SIZE } from '../theme';

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
}) {
  if (!scroll) return <View style={[s.screen, style]}>{children}</View>;
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[{ padding: spacing.lg, paddingBottom: spacing.xxl * 2 }, style]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={s.h1}>{children}</Text>;
}

export function H2({ children }: { children: React.ReactNode }) {
  return <Text style={s.h2}>{children}</Text>;
}

export function Body({ children, muted, style }: { children: React.ReactNode; muted?: boolean; style?: any }) {
  return <Text style={[s.body, muted && { color: colors.textMuted }, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(isDisabled), busy: Boolean(loading) }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        s.btn,
        variant === 'primary' && s.btnPrimary,
        variant === 'secondary' && s.btnSecondary,
        variant === 'ghost' && s.btnGhost,
        variant === 'danger' && s.btnDanger,
        pressed && { opacity: 0.82, transform: [{ scale: 0.99 }] },
        isDisabled && { opacity: 0.45 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'ghost' ? colors.primary : colors.white} />
      ) : (
        <Text style={[s.btnText, variant === 'ghost' && { color: colors.primarySoft }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textFaint}
        style={s.input}
        accessibilityLabel={label}
        {...props}
      />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Level indicator. The word is always present alongside the colour - a chip
 * that is only "red" tells a colourblind officer nothing.
 */
export function LevelBadge({ level, compact }: { level: number; compact?: boolean }) {
  const meta = levels[(level as 1 | 2 | 3) in levels ? (level as 1 | 2 | 3) : 1];
  return (
    <View style={[s.badge, { backgroundColor: meta.bg, borderColor: meta.color }]}>
      <Text style={[s.badgeText, { color: meta.color }]}>{compact ? meta.short : meta.label}</Text>
    </View>
  );
}

export function StatusPill({ status }: { status: string }) {
  const color = statusColors[status] ?? colors.textMuted;
  return (
    <View style={[s.badge, { backgroundColor: colors.surfaceAlt, borderColor: color }]}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={[s.badgeText, { color }]}>{statusLabels[status] ?? status}</Text>
    </View>
  );
}

/**
 * Connectivity indicator. Deliberately explicit: during an emergency she needs
 * to know whether her location is actually reaching anyone.
 */
export function ConnectivityBar({
  online,
  queued,
  lastSentAt,
  staleAfterSeconds = 60,
}: {
  online: boolean;
  queued: number;
  lastSentAt: number | null;
  staleAfterSeconds?: number;
}) {
  const stale = lastSentAt !== null && Date.now() - lastSentAt > staleAfterSeconds * 1000;

  let tone: string = colors.success;
  let label = 'Location is reaching responders';

  if (!online) {
    tone = colors.danger;
    label = queued > 0
      ? `No connection · ${queued} update${queued === 1 ? '' : 's'} waiting to send`
      : 'No connection · updates will send when signal returns';
  } else if (queued > 0) {
    tone = colors.warning;
    label = `Catching up · ${queued} update${queued === 1 ? '' : 's'} still to send`;
  } else if (stale) {
    tone = colors.warning;
    label = 'Last update was a while ago';
  } else if (lastSentAt === null) {
    tone = colors.warning;
    label = 'Waiting for the first location fix';
  }

  return (
    <View style={[s.connBar, { borderColor: tone, backgroundColor: colors.surface }]}>
      <View style={[s.dot, { backgroundColor: tone }]} />
      <Text style={[s.connText, { color: tone }]}>{label}</Text>
    </View>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={s.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <View style={s.loading}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={[s.body, { marginTop: spacing.md, color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <View style={s.errorNote}>
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, style]}>{children}</View>;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  h1: { ...type.hero, color: colors.text, marginBottom: spacing.sm },
  h2: { ...type.heading, color: colors.text, marginBottom: spacing.sm, marginTop: spacing.lg },
  body: { ...type.body, color: colors.text, lineHeight: 23 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  btn: {
    minHeight: HIT_SIZE,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  btnPrimary: { backgroundColor: colors.primary },
  btnSecondary: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong },
  btnGhost: { backgroundColor: 'transparent' },
  btnDanger: { backgroundColor: colors.danger },
  btnText: { ...type.body, fontWeight: '800', color: colors.white, fontSize: 17 },
  fieldLabel: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm, textTransform: 'uppercase' },
  input: {
    minHeight: HIT_SIZE,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    color: colors.text,
    fontSize: 17,
  },
  hint: { ...type.small, color: colors.textFaint, marginTop: spacing.sm, lineHeight: 19 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  badgeText: { ...type.label },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  connText: { ...type.small, fontWeight: '700', flex: 1 },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyTitle: { ...type.heading, color: colors.textMuted, textAlign: 'center' },
  emptyHint: { ...type.small, color: colors.textFaint, textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },
  loading: { padding: spacing.xxl, alignItems: 'center' },
  errorNote: {
    backgroundColor: '#3A1018',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { ...type.small, color: '#FFB3C0', lineHeight: 20 },
});
