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
};

const darkColors: typeof lightColors = {
  page: '#0B0B0B',
  surface: '#2A2A2A',
  header: '#111111',
  listSurface: '#0B0B0B',
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
};

function makeUi(colors: typeof lightColors) {
  return StyleSheet.create({
    body: { fontSize: 15, lineHeight: 22, color: colors.ink },
    muted: { fontSize: 13, lineHeight: 18, color: colors.muted },
    title: { fontSize: 18, fontWeight: '700', color: colors.ink },
    label: { fontSize: 14, fontWeight: '700', color: colors.ink },
    card: { backgroundColor: colors.surface, borderRadius: 14, padding: 12, gap: 8 },
    systemCard: { width: '94%', maxWidth: 600, alignSelf: 'center' },
    chip: {
      overflow: 'hidden', borderRadius: 12, backgroundColor: colors.pale, color: colors.ink,
      fontSize: 12, lineHeight: 16, paddingHorizontal: 8, paddingVertical: 2,
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
