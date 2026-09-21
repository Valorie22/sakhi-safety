/**
 * Sakhi's visual language.
 *
 * The palette is warm and unmistakably feminine - deep plum, rose, blush - but
 * the layout rules underneath it are those of an emergency tool, not a consumer
 * app: enormous touch targets, one dominant action per screen, and state you can
 * read at arm's length while your hands are shaking.
 *
 * Accessibility rule applied throughout: level and status are NEVER carried by
 * colour alone. Every coloured chip also carries its word ("LEVEL 2 - HIGH"),
 * because roughly one in twelve people cannot separate the red from the amber.
 */

export const colors = {
  // Deep plum, not pure black: softer under a thumb at 3am, still high contrast.
  bg: '#160910',
  bgElevated: '#22101A',
  surface: '#2C1522',
  surfaceAlt: '#3A1D2D',
  border: '#4A2739',
  borderStrong: '#6B3A52',

  // Rose is the brand and the SOS colour - the single loudest thing on screen.
  primary: '#FF2D6F',
  primaryDeep: '#C9134E',
  primarySoft: '#FF7AA5',
  primaryWash: '#3A1524',

  blush: '#FFB8D2',
  lilac: '#C9A7F5',

  text: '#FFF2F7',
  textMuted: '#D3AEC0',
  textFaint: '#9C7789',

  success: '#3FD9A0',
  warning: '#FFA94D',
  danger: '#FF3B5C',
  info: '#7CC4FF',

  white: '#FFFFFF',
  overlay: 'rgba(11,4,8,0.88)',
} as const;

/** Level styling. `label` is part of the contract, not decoration. */
export const levels = {
  1: {
    label: 'LEVEL 1 · SOS',
    short: 'L1',
    color: colors.primarySoft,
    bg: '#3A1524',
    description: 'Police and your circle alerted, live location shared.',
  },
  2: {
    label: 'LEVEL 2 · HIGH',
    short: 'L2',
    color: colors.warning,
    bg: '#3A2412',
    description: 'Everything in Level 1, plus ambient audio recorded as evidence.',
  },
  3: {
    label: 'LEVEL 3 · CRITICAL',
    short: 'L3',
    color: colors.danger,
    bg: '#421018',
    description: 'Top priority. Stations re-alerted and your circle told it escalated.',
  },
} as const;

export type LevelKey = keyof typeof levels;

export const statusLabels: Record<string, string> = {
  active: 'Waiting for an officer',
  claimed: 'Officer assigned',
  responding: 'Officer on the way',
  on_scene: 'Officer on scene',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

export const statusColors: Record<string, string> = {
  active: colors.warning,
  claimed: colors.info,
  responding: colors.lilac,
  on_scene: colors.success,
  resolved: colors.success,
  cancelled: colors.textFaint,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const type = {
  hero: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -0.5 },
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '500' as const },
  small: { fontSize: 14, fontWeight: '500' as const },
  // Used for codes, labels and chips; tracking makes short caps legible.
  label: { fontSize: 12, fontWeight: '800' as const, letterSpacing: 1.1 },
} as const;

/** Minimum touch target. Nothing interactive is allowed to be smaller. */
export const HIT_SIZE = 52;
