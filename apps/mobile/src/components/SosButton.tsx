import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, spacing, type } from '../theme';

/**
 * The dominant element of the home screen.
 *
 * Press-and-hold rather than tap: a single tap in a pocket or handbag is the
 * most likely way to raise a false alarm, and a false alarm sends police to a
 * real address. The hold is short (1.2s) and the ring fills as it goes, so it
 * never feels like a delay when it matters.
 */
export function SosButton({
  onTrigger,
  disabled,
  holdMs = 1200,
  label = 'HOLD FOR SOS',
}: {
  onTrigger: () => void;
  disabled?: boolean;
  holdMs?: number;
  label?: string;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // A slow idle pulse: the control reads as live without being a distraction.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.045, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const reset = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (tickTimer.current) clearInterval(tickTimer.current);
    holdTimer.current = null;
    tickTimer.current = null;
    Animated.timing(progress, { toValue: 0, duration: 180, useNativeDriver: false }).start();
  };

  const onPressIn = () => {
    if (disabled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Animated.timing(progress, {
      toValue: 1,
      duration: holdMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    // A heartbeat of haptics while held, so the hold is felt, not just seen.
    tickTimer.current = setInterval(() => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, 300);

    holdTimer.current = setTimeout(() => {
      reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onTrigger();
    }, holdMs);
  };

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={s.wrap}>
      <Animated.View style={{ transform: [{ scale: pulse }] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Emergency SOS. Press and hold to alert police and your safety circle."
          accessibilityHint={`Hold for ${(holdMs / 1000).toFixed(1)} seconds`}
          accessibilityState={{ disabled: Boolean(disabled) }}
          onPressIn={onPressIn}
          onPressOut={reset}
          disabled={disabled}
          style={({ pressed }) => [s.button, pressed && s.buttonPressed, disabled && s.buttonDisabled]}
        >
          <Text style={s.sos}>SOS</Text>
          <Text style={s.label}>{label}</Text>
        </Pressable>
      </Animated.View>

      <View style={s.track} accessibilityElementsHidden>
        <Animated.View style={[s.fill, { width }]} />
      </View>
    </View>
  );
}

const SIZE = 236;

const s = StyleSheet.create({
  wrap: { alignItems: 'center', marginVertical: spacing.xl },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 8,
    borderColor: colors.primaryDeep,
    // A visible glow so the control reads as the loudest thing on the screen.
    shadowColor: colors.primary,
    shadowOpacity: 0.55,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 0 },
    elevation: 14,
  },
  buttonPressed: { backgroundColor: colors.primaryDeep },
  buttonDisabled: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  sos: { fontSize: 62, fontWeight: '900', color: colors.white, letterSpacing: 3 },
  label: { ...type.label, color: '#FFD9E6', marginTop: spacing.xs },
  track: {
    width: SIZE,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    marginTop: spacing.lg,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.blush, borderRadius: radius.pill },
});
