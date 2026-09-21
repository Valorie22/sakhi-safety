import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/auth';
import { Body, Button, Card, ErrorNote, Field, H1, Screen } from '../../src/components/ui';
import { spacing } from '../../src/theme';

export default function SignUp() {
  const { signUp } = useAuth();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);

    if (fullName.trim().length < 2) return setError('Please enter your name.');
    if (password.length < 8) return setError('Use at least 8 characters for your password.');
    if (password !== confirm) return setError('The two passwords do not match.');

    setBusy(true);
    try {
      await signUp({ email, password, fullName: fullName.trim(), phone: phone.trim() || undefined });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen style={{ paddingTop: spacing.xxl * 2 }}>
        <H1>Almost there</H1>
        <Card>
          <Body>
            Your account has been created. If your project has email confirmation switched on, open the link
            we sent to {email} before signing in.
          </Body>
        </Card>
        <Button title="Go to sign in" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <Screen style={{ paddingTop: spacing.xxl }}>
        <H1>Create your account</H1>
        <Body muted>
          Your email address is how the people you trust will find you when they add you to their circle.
        </Body>

        <View style={{ height: spacing.xl }} />

        {error ? <ErrorNote message={error} /> : null}

        <Field label="Full name" value={fullName} onChangeText={setFullName} placeholder="Your name" autoComplete="name" />
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          placeholder="you@example.com"
        />
        <Field
          label="Phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="Optional, shown to responders"
          hint="Given to the officer who takes your case, so they can reach you."
        />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
        <Field label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" />

        <Button title="Create account" onPress={submit} loading={busy} />
        <Button title="I already have an account" variant="ghost" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    </KeyboardAvoidingView>
  );
}

