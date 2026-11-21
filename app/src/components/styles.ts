import { StyleSheet } from 'react-native';

export const colors = {
  page: '#F1F5F4',
  white: '#FFFFFF',
  ink: '#17312B',
  muted: '#4F655F',
  border: '#CCDAD4',
  teal: '#126450',
  pale: '#E0F0EA',
  amber: '#744B14',
  amberBackground: '#FFF1D5',
  red: '#902F39',
  redBackground: '#FBE5E8',
};

export const ui = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 13, lineHeight: 20, color: colors.muted },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink },
  label: { fontSize: 14, fontWeight: '700', color: colors.ink },
  card: { backgroundColor: colors.white, borderRadius: 14, padding: 14, gap: 8 },
  chip: { overflow: 'hidden', borderRadius: 9, backgroundColor: colors.pale, color: colors.ink,
    fontSize: 12, lineHeight: 18, paddingHorizontal: 8, paddingVertical: 3 },
  warning: { backgroundColor: colors.amberBackground, color: colors.amber },
  danger: { backgroundColor: colors.redBackground, color: colors.red },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { justifyContent: 'center', alignItems: 'center', minHeight: 44, paddingHorizontal: 12,
    paddingVertical: 8, borderRadius: 10, backgroundColor: colors.pale },
  primary: { backgroundColor: colors.teal },
  primaryText: { color: colors.white, fontWeight: '700' },
});

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
}
