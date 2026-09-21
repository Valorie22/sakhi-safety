import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '../../src/auth';
import { Body, Button, ErrorNote, Field, H1, Screen } from '../../src/components/ui';
import { colors, spacing, type } from '../../src/theme';

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
  noteTitle: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  noteBody: { ...type.small, color: colors.textFaint, lineHeight: 20 },
});
