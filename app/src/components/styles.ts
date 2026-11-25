import { StyleSheet, useColorScheme } from 'react-native';

// Both themes lean toward a cool, blue-grey slate (Slack's #1A1D21 dark, LINE's slate announcement
// bar) instead of a neutral grey; token roles are unchanged.
const lightColors = {
  page: '#F1F3F6',
  surface: '#FFFFFF',
  header: '#FFFFFF',
  listSurface: '#FFFFFF',
  ink: '#1B232C',
  muted: '#55606D',
  border: '#D3D9E1',
  accent: '#00813A',
  accentText: '#007733',
  onAccent: '#FFFFFF',
  pale: '#E0F0EA',
  pressed: '#ECEFF4',
  system: '#E6EAF0',
  /** Initials on the saturated seat-avatar fills. */
  avatarInk: '#FFFFFF',
  amber: '#744B14',
  amberBackground: '#FFF1D5',
  red: '#902F39',
  redBackground: '#FBE5E8',
  blue: '#21538A',
  violet: '#654386',
  // LINE-style chat surfaces
  chatBg: '#E9EDF2',
  bubble: '#FFFFFF',
  ownBubble: '#8DE385',
  ownInk: '#0B0B0B',
  pill: 'rgba(30, 41, 59, 0.6)',
  pillInk: '#FFFFFF',
  inputBg: '#EDF0F4',
  announce: '#F6F8FB',
  mention: '#1D5FD1',
  mentionBackground: '#E1EBFB',
  rail: '#CDD4DD',
};

const darkColors: typeof lightColors = {
  page: '#121418',
  surface: '#272B33',
  header: '#16181C',
  listSurface: '#16181C',
  ink: '#EEF0F3',
  muted: '#AEB5C0',
  border: '#2F343D',
  accent: '#00843C',
  accentText: '#42DF80',
  onAccent: '#FFFFFF',
  pale: '#213029',
  pressed: '#22262D',
  system: '#22262C',
  avatarInk: '#FFFFFF',
  amber: '#FFD392',
  amberBackground: '#40301B',
  red: '#FFADB5',
  redBackground: '#44262B',
  blue: '#9CC9FF',
  violet: '#D7BAF7',
  chatBg: '#1A1D21',
  bubble: '#30353E',
  ownBubble: '#8DE385',
  ownInk: '#0B0B0B',
  pill: '#2E343D',
  pillInk: '#E3E7ED',
  inputBg: '#262A31',
  announce: '#2D3542',
  mention: '#7FA8FF',
  mentionBackground: '#22304A',
  rail: '#3A404A',
};

/**
 * Line height for a font size. CJK fallback fonts (Noto Sans CJK) need about 1.45em of
 * ascent + descent; a lineHeight below that clips glyphs vertically on Android. Proportional,
 * so it scales with the system font size instead of fixing a pixel height.
 */
export function lineHeightFor(fontSize: number): number {
  return Math.ceil(fontSize * 1.5);
}

/**
 * Line height for statement bodies (bubbles and thread posts): one step looser than lineHeightFor,
 * closer to the reading rhythm of LINE / Slack. Still proportional, and never below lineHeightFor.
 */
export function bodyLineHeightFor(fontSize: number): number {
  return Math.ceil(fontSize * 1.65);
}

function makeUi(colors: typeof lightColors) {
  return StyleSheet.create({
    body: { fontSize: 15, lineHeight: lineHeightFor(15), color: colors.ink },
    muted: { fontSize: 13, lineHeight: lineHeightFor(13), color: colors.muted },
    title: { fontSize: 18, fontWeight: '700', color: colors.ink },
    label: { fontSize: 14, fontWeight: '700', color: colors.ink },
    card: { backgroundColor: colors.surface, borderRadius: 14, padding: 12, gap: 8 },
    systemCard: { width: '94%', maxWidth: 600, alignSelf: 'center' },
    chip: {
      overflow: 'hidden', borderRadius: 12, backgroundColor: colors.pale, color: colors.ink,
      fontSize: 12, lineHeight: lineHeightFor(12), paddingHorizontal: 8, paddingVertical: 2,
    },
    warning: { backgroundColor: colors.amberBackground, color: colors.amber },
    danger: { backgroundColor: colors.redBackground, color: colors.red },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    button: {
      justifyContent: 'center', alignItems: 'center', minHeight: 44, paddingHorizontal: 12,
      paddingVertical: 8, borderRadius: 10, backgroundColor: colors.pale,
    },
    input: {
      minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.surface,
    },
    // A button label spans the button's full width, so a label that renders a hair wider than it
    // measured still fits on its line instead of wrapping its last glyph out of view.
    buttonText: { alignSelf: 'stretch', textAlign: 'center' },
    disabled: { opacity: 0.55 },
    primary: { backgroundColor: colors.accent },
    primaryText: { color: colors.onAccent, fontWeight: '700' },
  });
}

const lightTheme = { colors: lightColors, ui: makeUi(lightColors) };
const darkTheme = { colors: darkColors, ui: makeUi(darkColors) };

export function useTheme() {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

export function useThemeColors() {
  return useTheme().colors;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
}
