import React, { useEffect } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { colors, spacing } from '../../src/theme';

/** Text glyphs keep the bundle free of an icon font for this build. */
function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{glyph}</Text>;
}

export default function AppLayout() {
  const { session, profile } = useAuth();
  const router = useRouter();

  // Register this device for push once, after sign-in.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    (async () => {
      if (!Device.isDevice) return; // Simulators cannot receive push.

      const existing = await Notifications.getPermissionsAsync();
      let granted = existing.granted;
      if (!granted) {
        const asked = await Notifications.requestPermissionsAsync();
        granted = asked.granted;
      }
      if (!granted || cancelled) return;

      try {
        const token = await Notifications.getExpoPushTokenAsync();
        if (!cancelled) await api.registerPushToken(token.data);
      } catch {
        // No project id configured, or offline. The in-app notification centre
        // still works; push is an enhancement, not the record of record.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  // Tapping a push about an emergency opens that emergency.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { emergencyId?: string };
      if (data?.emergencyId) router.push(`/emergency/${data.emergencyId}`);
    });
    return () => sub.remove();
  }, [router]);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
          height: 68,
          paddingBottom: spacing.sm,
          paddingTop: spacing.sm,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Sakhi',
          tabBarLabel: 'SOS',
          tabBarIcon: ({ color }) => <TabIcon glyph="◉" color={color} />,
        }}
      />
      <Tabs.Screen
        name="circle"
        options={{
          title: 'Safety circle',
          tabBarLabel: 'Circle',
          tabBarIcon: ({ color }) => <TabIcon glyph="♥" color={color} />,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts for you',
          tabBarLabel: 'Alerts',
          tabBarIcon: ({ color }) => <TabIcon glyph="◆" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: profile?.full_name ? profile.full_name : 'Safety settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} />,
        }}
      />
    </Tabs>
  );
}
