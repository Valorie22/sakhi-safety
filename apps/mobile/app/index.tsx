import { Redirect } from 'expo-router';
import { useAuth } from '../src/auth';
import { Loading } from '../src/components/ui';

/** Entry point: sends each role to its own surface. */
export default function Index() {
  const { session, profile, loading } = useAuth();

  if (loading) return <Loading label="Checking your session" />;
  if (!session) return <Redirect href="/(auth)/sign-in" />;
  if (profile?.role === 'police') return <Redirect href="/(police)/queue" />;
  if (profile?.role === 'admin') return <Redirect href="/admin" />;
  return <Redirect href="/(app)" />;
}
