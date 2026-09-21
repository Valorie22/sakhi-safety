import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Body, Card, Empty, H2, LevelBadge, Row, StatusPill } from '../../src/components/ui';
import { useNotificationRealtime } from '../../src/hooks/useRealtime';
import { colors, spacing, type } from '../../src/theme';

const OPEN = ['active', 'claimed', 'responding', 'on_scene'];

/**
 * The family view: alerts raised by people who added this account to their
 * circle. Nothing here is filtered client-side for security - RLS simply does
 * not return emergencies this account has no right to see.
 */
export default function Alerts() {
  const router = useRouter();
  const { profile } = useAuth();

  const [emergencies, setEmergencies] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [watching, notes] = await Promise.all([
      api.watching().catch(() => ({ emergencies: [] })),
      api.notifications().catch(() => ({ notifications: [] })),
    ]);
    setEmergencies(watching.emergencies);
    setNotifications(notes.notifications);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useNotificationRealtime(profile?.id ?? null, () => void load());

  const live = emergencies.filter((e) => OPEN.includes(e.status));
  const past = emergencies.filter((e) => !OPEN.includes(e.status));
  const unread = notifications.filter((n) => !n.read_at);

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
      {live.length > 0 ? (
        <>
          <H2>Happening now</H2>
          {live.map((emergency) => (
            <Pressable key={emergency.id} onPress={() => router.push(`/emergency/${emergency.id}`)}>
              <Card style={{ borderColor: colors.primary, borderWidth: 1.5 }}>
                <Text style={s.name}>{emergency.reporter?.full_name ?? 'Someone in your circle'}</Text>
                <Row style={{ marginTop: spacing.sm, flexWrap: 'wrap' }}>
                  <LevelBadge level={emergency.level} compact />
                  <StatusPill status={emergency.status} />
                </Row>
                <Text style={s.meta}>
                  {emergency.emergency_code} · started {new Date(emergency.created_at).toLocaleTimeString()}
                </Text>
                <Text style={s.open}>Tap to see their live location and the case timeline →</Text>
              </Card>
            </Pressable>
          ))}
        </>
      ) : (
        <Empty
          title="No active alerts"
          hint="If someone who added you to their circle triggers an SOS, it appears here instantly and your phone is notified."
        />
      )}

      {unread.length > 0 ? (
        <>
          <H2>Recent notifications</H2>
          {unread.slice(0, 15).map((note) => (
            <Pressable
              key={note.id}
              onPress={async () => {
                await api.markRead(note.id).catch(() => {});
                if (note.emergency_id) router.push(`/emergency/${note.emergency_id}`);
                else await load();
              }}
            >
              <Card>
                <Text style={s.noteTitle}>{note.title}</Text>
                <Body muted style={{ marginTop: 2 }}>
                  {note.body}
                </Body>
                <Text style={s.meta}>{new Date(note.created_at).toLocaleString()}</Text>
              </Card>
            </Pressable>
          ))}
        </>
      ) : null}

      {past.length > 0 ? (
        <>
          <H2>Earlier</H2>
          {past.slice(0, 20).map((emergency) => (
            <Pressable key={emergency.id} onPress={() => router.push(`/emergency/${emergency.id}`)}>
              <Card>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={s.pastName}>{emergency.reporter?.full_name ?? 'Someone'}</Text>
                  <StatusPill status={emergency.status} />
                </Row>
                <Text style={s.meta}>
                  {emergency.emergency_code} · {new Date(emergency.created_at).toLocaleDateString()}
                </Text>
              </Card>
            </Pressable>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  name: { ...type.title, color: colors.text },
  pastName: { ...type.body, color: colors.textMuted, fontWeight: '700' },
  meta: { ...type.small, color: colors.textFaint, marginTop: spacing.sm },
  open: { ...type.small, color: colors.primarySoft, marginTop: spacing.sm, fontWeight: '700' },
  noteTitle: { ...type.body, color: colors.text, fontWeight: '700' },
});
