import React, { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Body, Button, Card, ErrorNote, Field, H2, Row, Screen } from '../../src/components/ui';
import { colors, radius, spacing, type } from '../../src/theme';

/**
 * Admin console: stations and officer accounts.
 *
 * This surface is reachable only by an account whose SERVER-side profile row
 * says role = 'admin'. There is no way to become an admin from inside the app -
 * the role is set by a seed script or by hand in the database.
 */
export default function Admin() {
  const { profile, signOut } = useAuth();

  const [stations, setStations] = useState<any[]>([]);
  const [officers, setOfficers] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'stations' | 'officers'>('stations');

  const load = useCallback(async () => {
    try {
      const [st, off] = await Promise.all([api.adminStations(), api.adminOfficers()]);
      setStations(st.stations);
      setOfficers(off.officers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      <Text style={s.title}>Administration</Text>
      <Body muted>{profile?.email}</Body>

      {error ? <ErrorNote message={error} /> : null}

      <Row style={{ marginTop: spacing.lg }}>
        <Button
          title={`Stations (${stations.length})`}
          variant={tab === 'stations' ? 'primary' : 'secondary'}
          onPress={() => setTab('stations')}
          style={{ flex: 1 }}
        />
        <Button
          title={`Officers (${officers.length})`}
          variant={tab === 'officers' ? 'primary' : 'secondary'}
          onPress={() => setTab('officers')}
          style={{ flex: 1 }}
        />
      </Row>

      {tab === 'stations' ? (
        <StationsTab stations={stations} onChanged={load} setError={setError} />
      ) : (
        <OfficersTab officers={officers} stations={stations} onChanged={load} setError={setError} />
      )}

      <Button title="Sign out" variant="ghost" onPress={() => void signOut()} style={{ marginTop: spacing.xl }} />
    </Screen>
  );
}

function StationsTab({
  stations,
  onChanged,
  setError,
}: {
  stations: any[];
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radiusM, setRadiusM] = useState('3000');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setError(null);
    const latitude = Number(lat);
    const longitude = Number(lng);
    const coverage = Number(radiusM);

    if (!name.trim()) return setError('Give the station a name.');
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return setError('Latitude must be between -90 and 90.');
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return setError('Longitude must be between -180 and 180.');
    if (!Number.isFinite(coverage) || coverage <= 0) return setError('Coverage radius must be a positive number of metres.');

    setBusy(true);
    try {
      await api.createStation({
        name: name.trim(),
        lat: latitude,
        lng: longitude,
        coverageRadiusMeters: coverage,
        phone: phone.trim() || undefined,
      });
      setName('');
      setLat('');
      setLng('');
      setPhone('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the station');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <H2>New station</H2>
      <Card>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Bandra Police Station" />
        <Row>
          <View style={{ flex: 1 }}>
            <Field label="Latitude" value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" placeholder="19.0760" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Longitude" value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" placeholder="72.8777" />
          </View>
        </Row>
        <Field
          label="Coverage radius (metres)"
          value={radiusM}
          onChangeText={setRadiusM}
          keyboardType="number-pad"
          hint="Every station whose circle contains an emergency is dispatched, so overlapping coverage is expected and fine."
        />
        <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Optional" />
        <Button title="Create station" onPress={create} loading={busy} />
      </Card>

      <H2>Stations</H2>
      {stations.map((station) => (
        <Card key={station.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={s.code}>{station.station_code}</Text>
              <Text style={s.name}>{station.name}</Text>
              <Text style={s.meta}>
                {station.lat?.toFixed(4)}, {station.lng?.toFixed(4)} · {(station.coverage_radius_meters / 1000).toFixed(1)} km radius
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[s.meta, { color: station.is_active ? colors.success : colors.textFaint }]}>
                {station.is_active ? 'ACTIVE' : 'INACTIVE'}
              </Text>
              <Switch
                value={station.is_active}
                onValueChange={async (next) => {
                  await api.updateStation(station.id, { isActive: next }).catch(() => {});
                  await onChanged();
                }}
                trackColor={{ false: colors.surfaceAlt, true: colors.primaryDeep }}
                thumbColor={station.is_active ? colors.primary : colors.textFaint}
              />
            </View>
          </Row>
        </Card>
      ))}
    </View>
  );
}

function OfficersTab({
  officers,
  stations,
  onChanged,
  setError,
}: {
  officers: any[];
  stations: any[];
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [badge, setBadge] = useState('');
  const [password, setPassword] = useState('');
  const [stationId, setStationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setError(null);
    if (!stationId) return setError('Choose the station this officer belongs to.');
    if (password.length < 10) return setError('Use at least 10 characters for the initial password.');

    setBusy(true);
    try {
      await api.createOfficer({
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        stationId,
        badgeNumber: badge.trim(),
      });
      Alert.alert(
        'Officer created',
        `${email.trim()} can now sign in. Ask them to change this password on first use.`,
      );
      setEmail('');
      setFullName('');
      setBadge('');
      setPassword('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the officer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <H2>New officer</H2>
      <Card>
        <Body muted>
          This is the only way a police account can come into existence. Officers cannot sign themselves up.
        </Body>
        <View style={{ height: spacing.md }} />

        <Field label="Full name" value={fullName} onChangeText={setFullName} />
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <Field label="Badge number" value={badge} onChangeText={setBadge} autoCapitalize="characters" />
        <Field
          label="Initial password"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          hint="Hand this to the officer over a trusted channel and have them change it."
        />

        <Text style={s.pickerLabel}>STATION</Text>
        {stations.map((station) => (
          <Button
            key={station.id}
            title={`${station.station_code} · ${station.name}`}
            variant={stationId === station.id ? 'primary' : 'secondary'}
            onPress={() => setStationId(station.id)}
          />
        ))}

        <Button title="Create officer" onPress={create} loading={busy} style={{ marginTop: spacing.md }} />
      </Card>

      <H2>Officers</H2>
      {officers.map((officer) => (
        <Card key={officer.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{officer.profile?.full_name ?? 'Officer'}</Text>
              <Text style={s.meta}>
                Badge {officer.badge_number} · {officer.station?.station_code}
              </Text>
              <Text style={s.meta}>{officer.profile?.email}</Text>
            </View>
            <Switch
              value={officer.is_active}
              onValueChange={async (next) => {
                await api.updateOfficer(officer.id, { isActive: next }).catch(() => {});
                await onChanged();
              }}
              trackColor={{ false: colors.surfaceAlt, true: colors.primaryDeep }}
              thumbColor={officer.is_active ? colors.primary : colors.textFaint}
            />
          </Row>
        </Card>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  title: { ...type.hero, color: colors.text },
  code: { ...type.label, color: colors.primary, fontSize: 13 },
  name: { ...type.heading, color: colors.text },
  meta: { ...type.small, color: colors.textMuted, marginTop: 2 },
  pickerLabel: { ...type.label, color: colors.textMuted, marginTop: spacing.md, marginBottom: spacing.sm },
});
