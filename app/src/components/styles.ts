import { StyleSheet, useColorScheme } from 'react-native';

const lightColors = {
  page: '#F1F5F4',
  surface: '#FFFFFF',
  header: '#FFFFFF',
  listSurface: '#FFFFFF',
  ink: '#17312B',
  muted: '#4F655F',
  border: '#CCDAD4',
  accent: '#00813A',
  accentText: '#007733',
  onAccent: '#FFFFFF',
  pale: '#E0F0EA',
  pressed: '#EBF3EE',
  system: '#E5EFEB',
  avatarInk: '#17312B',
  amber: '#744B14',
  amberBackground: '#FFF1D5',
  red: '#902F39',
  redBackground: '#FBE5E8',
  blue: '#21538A',
  violet: '#654386',
  // LINE-style chat surfaces
  chatBg: '#EEF1F0',
  bubble: '#FFFFFF',
  ownBubble: '#8DE385',
  ownInk: '#0B0B0B',
  pill: 'rgba(0, 0, 0, 0.32)',
  pillInk: '#FFFFFF',
  inputBg: '#EEF1F0',
  announce: '#FFFFFF',
  mention: '#1D5FD1',
  mentionBackground: '#E1EBFB',
  rail: '#CCDAD4',
};

const darkColors: typeof lightColors = {
  page: '#0B0B0B',
  surface: '#2A2A2A',
  header: '#111111',
  listSurface: '#111111',
  ink: '#F2F2F2',
  muted: '#9A9A9A',
  border: '#2E2E2E',
  accent: '#00843C',
  accentText: '#42DF80',
  onAccent: '#FFFFFF',
  pale: '#242F28',
  pressed: '#1B1B1B',
  system: '#1D1D1D',
  avatarInk: '#17312B',
  amber: '#FFD392',
  amberBackground: '#40301B',
  red: '#FFADB5',
  redBackground: '#44262B',
  blue: '#9CC9FF',
  violet: '#D7BAF7',
  chatBg: '#1E1E1E',
  bubble: '#2C2C2C',
  ownBubble: '#8DE385',
  ownInk: '#0B0B0B',
  pill: '#2C2C2C',
  pillInk: '#E6E6E6',
  inputBg: '#262626',
  announce: '#2A2A2A',
  mention: '#7FA8FF',
  mentionBackground: '#22304A',
  rail: '#3A3A3A',
};

/**
 * Line height for a font size. CJK fallback fonts (Noto Sans CJK) need about 1.45em of
 * ascent + descent; a lineHeight below that clips glyphs vertically on Android. Proportional,
 * so it scales with the system font size instead of fixing a pixel height.
 */
export function lineHeightFor(fontSize: number): number {
  return Math.ceil(fontSize * 1.5);
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
