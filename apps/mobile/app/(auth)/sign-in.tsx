import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '../../src/auth';
import { Body, Button, ErrorNote, Field, H1, Screen } from '../../src/components/ui';
import { colors, spacing, type } from '../../src/theme';

export default function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
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
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          placeholder="Your password"
        />

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
