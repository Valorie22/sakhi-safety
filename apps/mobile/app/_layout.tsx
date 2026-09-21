import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { AuthProvider, useAuth } from '../src/auth';
import { Loading } from '../src/components/ui';
import { colors } from '../src/theme';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

function Gate() {
  const { session, profile, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const group = segments[0];
    const inAuth = group === '(auth)';

    if (!session) {
      if (!inAuth) router.replace('/(auth)/sign-in');
      return;
    }

    // Signed in. Route by the role the SERVER reports, never by client state.
    if (inAuth || group === undefined) {
      if (profile?.role === 'police') router.replace('/(police)/queue');
      else if (profile?.role === 'admin') router.replace('/admin');
      else router.replace('/(app)');
    }
  }, [session, profile, loading, segments, router]);

  if (loading) return <Loading label="Checking your session" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
      <Stack.Screen name="(police)" options={{ headerShown: false }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
      <Stack.Screen
        name="emergency/[id]"
        options={{
          // The active-emergency screen owns the whole display: no back button,
          // no tab bar, nothing to wander off into while help is on the way.
          headerShown: false,
          gestureEnabled: false,
          animation: 'fade',
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    if (Platform.OS === 'android') {
      // A dedicated high-importance channel so an SOS can break through DND.
      void Notifications.setNotificationChannelAsync('emergency', {
        name: 'Emergency alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 400, 200, 400],
        lightColor: colors.primary,
        bypassDnd: true,
      });
      void Notifications.setNotificationChannelAsync('default', {
        name: 'General',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
