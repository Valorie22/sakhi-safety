import React, { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../../src/api';
import { Body, Button, Card, ErrorNote, Field, H2, Row, Screen } from '../../src/components/ui';
import { colors, radius, spacing, type } from '../../src/theme';

interface Edge {
  id: string;
  status: string;
  relationship: string | null;
  contact?: { id: string; full_name: string; phone: string | null };
  owner?: { id: string; full_name: string; phone: string | null };
}

const STATUS_COPY: Record<string, string> = {
  pending: 'Waiting for them to accept',
  accepted: 'Active',
  declined: 'Declined',
};

export default function Circle() {
  const [myCircle, setMyCircle] = useState<Edge[]>([]);
  const [protecting, setProtecting] = useState<Edge[]>([]);
  const [email, setEmail] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<{ id: string; fullName: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.contacts();
      setMyCircle(res.myCircle);
      setProtecting(res.protecting);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your circle');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const search = async () => {
    setError(null);
    setFound(null);
    setNotFound(false);
    setSearching(true);
    try {
      const res = await api.searchContact(email.trim());
      if (res.found && res.user) setFound(res.user);
      else setNotFound(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const invite = async () => {
    if (!found) return;
    try {
      await api.requestContact(found.id);
      setFound(null);
      setEmail('');
      await load();
      Alert.alert('Request sent', `${found.fullName} will be asked to accept.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the request');
    }
  };

  const respond = async (id: string, action: 'accept' | 'decline') => {
    try {
      await api.respondContact(id, action);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not respond');
    }
  };

  const remove = (id: string, name: string) => {
    Alert.alert('Remove from your circle?', `${name} will stop receiving your emergency alerts.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await api.removeContact(id).catch(() => {});
          await load();
        },
      },
    ]);
  };

  const incoming = protecting.filter((edge) => edge.status === 'pending');
  const accepted = protecting.filter((edge) => edge.status === 'accepted');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl * 2 }}
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
      {error ? <ErrorNote message={error} /> : null}

      {incoming.length > 0 ? (
        <>
          <H2>Waiting on you</H2>
          {incoming.map((edge) => (
            <Card key={edge.id}>
              <Text style={s.name}>{edge.owner?.full_name ?? 'Someone'}</Text>
              <Body muted style={{ marginTop: spacing.xs }}>
                wants you as an emergency contact. If you accept, you will be alerted when they trigger an SOS
                and you will be able to see their live location during an emergency.
              </Body>
              <Row style={{ marginTop: spacing.md }}>
                <Button title="Accept" onPress={() => void respond(edge.id, 'accept')} style={{ flex: 1 }} />
                <Button
                  title="Decline"
                  variant="secondary"
                  onPress={() => void respond(edge.id, 'decline')}
                  style={{ flex: 1 }}
                />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      <H2>Add someone you trust</H2>
      <Card>
        <Body muted>
          Search by the exact email address they signed up with. They have to accept before they receive
          anything.
        </Body>
        <View style={{ height: spacing.md }} />
        <Field
          label="Their email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="them@example.com"
        />
        <Button title="Search" onPress={search} loading={searching} variant="secondary" />

        {found ? (
          <View style={s.result}>
            <Text style={s.name}>{found.fullName}</Text>
            <Button title="Send request" onPress={invite} style={{ marginTop: spacing.md }} />
          </View>
        ) : null}

        {notFound ? (
          <Text style={s.notFound}>
            No Sakhi account uses that address. Ask them to sign up first — Sakhi can only alert people who
            have an account.
          </Text>
        ) : null}
      </Card>

      <H2>Your safety circle</H2>
      <Body muted>These people are alerted when you trigger an SOS.</Body>
      <View style={{ height: spacing.md }} />

      {myCircle.length === 0 ? (
        <Card>
          <Text style={s.emptyTitle}>Nobody yet</Text>
          <Body muted style={{ marginTop: spacing.xs }}>
            Police will still be dispatched without contacts, but nobody who knows you will be told.
          </Body>
        </Card>
      ) : (
        myCircle.map((edge) => (
          <Card key={edge.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{edge.contact?.full_name ?? 'Contact'}</Text>
                <Text
                  style={[
                    s.status,
                    { color: edge.status === 'accepted' ? colors.success : colors.warning },
                  ]}
                >
                  {STATUS_COPY[edge.status] ?? edge.status}
                </Text>
              </View>
              <Button
                title="Remove"
                variant="ghost"
                onPress={() => remove(edge.id, edge.contact?.full_name ?? 'This contact')}
              />
            </Row>
          </Card>
        ))
      )}

      <H2>You are protecting</H2>
      <Body muted>People whose alerts will reach you.</Body>
      <View style={{ height: spacing.md }} />

      {accepted.length === 0 ? (
        <Card>
          <Text style={s.emptyTitle}>Nobody has added you yet</Text>
        </Card>
      ) : (
        accepted.map((edge) => (
          <Card key={edge.id}>
            <Text style={s.name}>{edge.owner?.full_name ?? 'Someone'}</Text>
            <Text style={[s.status, { color: colors.success }]}>You will receive their alerts</Text>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  name: { ...type.heading, color: colors.text },
  status: { ...type.small, fontWeight: '700', marginTop: 2 },
  emptyTitle: { ...type.body, color: colors.textMuted, fontWeight: '700' },
  result: {
    marginTop: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  notFound: { ...type.small, color: colors.textFaint, marginTop: spacing.md, lineHeight: 20 },
});
