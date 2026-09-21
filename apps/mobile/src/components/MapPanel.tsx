import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';

export interface MapPoint {
  lat: number;
  lng: number;
  label?: string;
  kind?: 'person' | 'station';
}

/**
 * Map rendering, with an honest fallback.
 *
 * react-native-maps needs a Google Maps API key on Android and a development
 * build to work fully. Rather than crashing, or worse, showing an empty grey
 * rectangle that looks like a map with nothing on it, this loads the native
 * module defensively and falls back to a plain coordinate readout that says
 * what it is. A responder misreading a blank map as "she isn't moving" is a
 * failure mode worth engineering against.
 */
let MapView: any = null;
let Marker: any = null;
let Circle: any = null;
let Polyline: any = null;
let mapsAvailable = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const maps = require('react-native-maps');
  MapView = maps.default;
  Marker = maps.Marker;
  Circle = maps.Circle;
  Polyline = maps.Polyline;
  mapsAvailable = Boolean(MapView);
} catch {
  mapsAvailable = false;
}

export function MapPanel({
  points,
  trail,
  radiusMeters,
  height = 260,
}: {
  points: MapPoint[];
  trail?: Array<{ lat: number; lng: number }>;
  radiusMeters?: number;
  height?: number;
}) {
  const primary = points[0];

  if (!primary) {
    return (
      <View style={[s.fallback, { height }]}>
        <Text style={s.fallbackTitle}>No position yet</Text>
        <Text style={s.fallbackHint}>Waiting for the first GPS fix.</Text>
      </View>
    );
  }

  if (!mapsAvailable) {
    return (
      <View style={[s.fallback, { height }]}>
        <Text style={s.fallbackLabel}>LAST KNOWN POSITION</Text>
        <Text style={s.coords}>
          {primary.lat.toFixed(5)}, {primary.lng.toFixed(5)}
        </Text>
        {points.slice(1).map((p, i) => (
          <Text key={i} style={s.fallbackHint}>
            {p.label ?? 'Point'}: {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
          </Text>
        ))}
        <Text style={s.fallbackNote}>
          Map tiles need a development build with a Google Maps key. Coordinates above are live.
        </Text>
      </View>
    );
  }

  return (
    <View style={[s.mapWrap, { height }]}>
      <MapView
        style={{ flex: 1 }}
        initialRegion={{
          latitude: primary.lat,
          longitude: primary.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
        region={{
          latitude: primary.lat,
          longitude: primary.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        {trail && trail.length > 1 ? (
          <Polyline
            coordinates={trail.map((t) => ({ latitude: t.lat, longitude: t.lng }))}
            strokeColor={colors.primarySoft}
            strokeWidth={4}
          />
        ) : null}

        {radiusMeters ? (
          <Circle
            center={{ latitude: primary.lat, longitude: primary.lng }}
            radius={radiusMeters}
            strokeColor={colors.primary}
            fillColor="rgba(255,45,111,0.12)"
          />
        ) : null}

        {points.map((p, i) => (
          <Marker
            key={i}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            title={p.label ?? (p.kind === 'station' ? 'Police station' : 'Current position')}
            pinColor={p.kind === 'station' ? '#7CC4FF' : colors.primary}
          />
        ))}
      </MapView>
    </View>
  );
}

const s = StyleSheet.create({
  mapWrap: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  fallback: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: spacing.lg,
    marginBottom: spacing.md,
    justifyContent: 'center',
  },
  fallbackLabel: { ...type.label, color: colors.textFaint, marginBottom: spacing.sm },
  fallbackTitle: { ...type.heading, color: colors.textMuted },
  coords: { fontSize: 26, fontWeight: '800', color: colors.text, letterSpacing: 0.5 },
  fallbackHint: { ...type.small, color: colors.textMuted, marginTop: spacing.xs },
  fallbackNote: { ...type.small, color: colors.textFaint, marginTop: spacing.md, lineHeight: 19 },
});
