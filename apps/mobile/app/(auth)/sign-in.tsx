import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '../../src/auth';
import { Body, Button, ErrorNote, Field, H1, Screen } from '../../src/components/ui';
import { colors, radius, spacing, type } from '../../src/theme';

/** Seeded demo identities. Only ever rendered behind __DEV__. */
const DEMO_PASSWORD = 'Demo!pass1';
const DEMO_ACCOUNTS = [
  { email: 'alice@example.com', role: 'User - triggers the SOS' },
  { email: 'bob@example.com', role: "User - Alice's trusted contact" },
  { email: 'off1@example.com', role: 'Police - STN-1001, badge B-101' },
  { email: 'off2@example.com', role: 'Police - STN-1001, badge B-102' },
  { email: 'admin@example.com', role: 'Admin - stations and officers' },
] as const;

export default function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not sign in';

      // A phone keyboard routinely appends a space after predictive text, and
      // the server can only answer "invalid credentials" - which sends people
      // hunting for the wrong problem. Say what it usually is.
      if (/invalid login credentials/i.test(message) && password !== password.trim()) {
        setError(
          'That did not match. Your password has a space at the start or end — ' +
            'tap Show to check.',
        );
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <Screen style={{ paddingTop: spacing.xxl * 2 }}>
        <View style={s.brand}>
          <Text style={s.mark}>सखी</Text>
          <H1>Sakhi</H1>
          <Body muted>
            A friend who raises the alarm when you cannot. Police and the people you trust, in one press.
          </Body>
        </View>

        {error ? <ErrorNote message={error} /> : null}

        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
          textContentType="emailAddress"
        />

        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          // Autocorrect on a password field is only ever destructive: it cannot
          // know the word, and it is what silently appends the trailing space.
          autoCorrect={false}
          spellCheck={false}
          autoComplete="current-password"
          textContentType="password"
          placeholder="Your password"
        />

        <Pressable
          onPress={() => setReveal((v) => !v)}
          accessibilityRole="switch"
          accessibilityState={{ checked: reveal }}
          accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
          style={s.reveal}
          hitSlop={12}
        >
          <Text style={s.revealText}>{reveal ? 'Hide password' : 'Show password'}</Text>
        </Pressable>

        <Button title="Sign in" onPress={submit} loading={busy} />

        <Link href="/(auth)/sign-up" asChild>
          <Button title="Create an account" variant="ghost" onPress={() => {}} />
        </Link>

        {/*
          Development only. __DEV__ is false in any release build, so these never
          ship. Typing a password on a phone keyboard is its own source of
          failure - predictive text, the symbol keyboard, a stray space - and
          while demoing that noise is indistinguishable from a real bug.
        */}
        {__DEV__ ? (
          <View style={s.demo}>
            <Text style={s.demoTitle}>DEMO ACCOUNTS (DEV BUILD ONLY)</Text>
            <Text style={s.demoHint}>Tap one to fill the form, then press Sign in.</Text>
            {DEMO_ACCOUNTS.map((account) => (
              <Pressable
                key={account.email}
                onPress={() => {
                  setEmail(account.email);
                  setPassword(DEMO_PASSWORD);
                  setError(null);
                }}
                style={({ pressed }) => [s.demoRow, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel={`Fill in the ${account.role} demo account`}
              >
                <Text style={s.demoEmail}>{account.email}</Text>
                <Text style={s.demoRole}>{account.role}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={s.note}>
          <Text style={s.noteTitle}>Officers and administrators</Text>
          <Text style={s.noteBody}>
            Police accounts are issued by an administrator and signed into here with the credentials you were
            given. There is no police sign-up, by design.
          </Text>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  brand: { marginBottom: spacing.xl },
  reveal: { alignSelf: 'flex-end', marginTop: -spacing.sm, marginBottom: spacing.lg, padding: spacing.sm },
  revealText: { ...type.small, color: colors.primarySoft, fontWeight: '700' },
  mark: { fontSize: 40, color: colors.primarySoft, fontWeight: '700', marginBottom: spacing.xs },
  note: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  demo: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
  },
  demoTitle: { ...type.label, color: colors.lilac, marginBottom: spacing.xs },
  demoHint: { ...type.small, color: colors.textFaint, marginBottom: spacing.md },
  demoRow: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  demoEmail: { ...type.body, color: colors.text, fontWeight: '700' },
  demoRole: { ...type.small, color: colors.textMuted, marginTop: 1 },
  noteTitle: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  noteBody: { ...type.small, color: colors.textFaint, lineHeight: 20 },
});
