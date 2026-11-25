import { createContext, useContext } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import type { DisplayStyle } from '../storage';

/*
 * Two colour systems, one per display style (visual bundle, 2026-11-25): the line style follows LINE's
 * neutral near-black (no blue cast), the thread style Slack's blue-tinted dark (#1A1D21). Each has a
 * light version after the same app's light theme. Token roles are shared, so every component reads
 * the same keys and only the active palette changes. Screens outside a meeting (session list,
 * compose, settings, detail) use the line palette, LINE's talk list being their reference.
 */
const lineLight = {
  page: '#FFFFFF',
  surface: '#FFFFFF',
  header: '#FFFFFF',
  listSurface: '#FFFFFF',
  ink: '#111111',
  muted: '#6B6B6B',
  border: '#E3E3E3',
  accent: '#00813A',
  accentText: '#007733',
  onAccent: '#FFFFFF',
  pale: '#E4F3E8',
  pressed: '#F0F0F0',
  system: '#EFEFEF',
  /** Initials on the saturated seat-avatar fills. */
  avatarInk: '#FFFFFF',
  amber: '#744B14',
  amberBackground: '#FFF1D5',
  red: '#902F39',
  redBackground: '#FBE5E8',
  blue: '#21538A',
  violet: '#654386',
  // Chat surfaces
  chatBg: '#FFFFFF',
  /** Other speakers' bubbles (line) and the bubble text colour on them. */
  bubble: '#EFEFEF',
  bubbleInk: '#111111',
  /** The owner's own bubbles (line): pale green with dark text. */
  ownBubble: '#A9E88F',
  ownInk: '#0B0B0B',
  /** Small out-of-bubble metadata: time, 既読, speaker names. */
  meta: '#7A7A7A',
  /** Centered round / date pill. */
  pill: '#E6E6E6',
  pillInk: '#3A3A3A',
  /** Composer bar and its input field. */
  composerBar: '#FFFFFF',
  inputBg: '#F1F1F1',
  announce: '#F3F5F8',
  announceIcon: '#2F7CF6',
  mention: '#1D5FD1',
  mentionBackground: '#E1EBFB',
  rail: '#DCDCDC',
};

const lineDark: typeof lineLight = {
  page: '#121212',
  surface: '#232323',
  header: '#121212',
  listSurface: '#121212',
  ink: '#EDEDED',
  muted: '#9B9B9B',
  border: '#2A2A2A',
  accent: '#00843C',
  accentText: '#42DF80',
  onAccent: '#FFFFFF',
  pale: '#1F2E24',
  pressed: '#1E1E1E',
  system: '#222222',
  avatarInk: '#FFFFFF',
  amber: '#FFD392',
  amberBackground: '#40301B',
  red: '#FFADB5',
  redBackground: '#44262B',
  blue: '#9CC9FF',
  violet: '#D7BAF7',
  chatBg: '#121212',
  bubble: '#2E2E2E',
  bubbleInk: '#FFFFFF',
  ownBubble: '#A9E88F',
  ownInk: '#0B0B0B',
  meta: '#8E8E8E',
  pill: '#262626',
  pillInk: '#E6E6E6',
  composerBar: '#121212',
  inputBg: '#2A2A2A',
  announce: '#2B323C',
  announceIcon: '#4C8DF6',
  mention: '#7FA8FF',
  mentionBackground: '#24324A',
  rail: '#333333',
};

const slackLight: typeof lineLight = {
  ...lineLight,
  page: '#FFFFFF',
  surface: '#FFFFFF',
  header: '#FFFFFF',
  listSurface: '#FFFFFF',
  ink: '#1D1C1D',
  muted: '#616061',
  border: '#DDDDDD',
  accent: '#007A5A',
  accentText: '#007A5A',
  pale: '#E3F1EC',
  pressed: '#F4F4F4',
  system: '#F2F2F2',
  chatBg: '#FFFFFF',
  bubble: '#FFFFFF',
  bubbleInk: '#1D1C1D',
  meta: '#616061',
  pill: '#FFFFFF',
  pillInk: '#1D1C1D',
  composerBar: '#FFFFFF',
  inputBg: '#FFFFFF',
  announce: '#F4F4F4',
  announceIcon: '#1264A3',
  /** Slack mention: link blue on a pale blue chip. */
  mention: '#1264A3',
  mentionBackground: '#E8F5FA',
  rail: '#DDDDDD',
};

const slackDark: typeof lineLight = {
  ...lineDark,
  page: '#1A1D21',
  surface: '#222529',
  header: '#1A1D21',
  listSurface: '#1A1D21',
  ink: '#E8E8E8',
  muted: '#ABABAD',
  border: '#35373B',
  accent: '#007A5A',
  accentText: '#2BAC76',
  pale: '#1D3A31',
  pressed: '#222529',
  system: '#222529',
  chatBg: '#1A1D21',
  bubble: '#1A1D21',
  bubbleInk: '#E8E8E8',
  meta: '#ABABAD',
  /** Date divider pill and reaction-style chips: dark grey. */
  pill: '#2C2F33',
  pillInk: '#E8E8E8',
  composerBar: '#222529',
  inputBg: '#222529',
  announce: '#222529',
  announceIcon: '#1D9BD1',
  /** Slack mobile mention: deep blue chip, light-blue text. */
  mention: '#5DB7EC',
  mentionBackground: '#173A58',
  rail: '#35373B',
};

export type ThemeColors = typeof lineLight;

/**
 * Line height for a font size. CJK fallback fonts (Noto Sans CJK) need about 1.45em of
 * ascent + descent; a lineHeight below that clips glyphs vertically on Android. Proportional,
 * so it scales with the system font size instead of fixing a pixel height.
 */
export function lineHeightFor(fontSize: number): number {
  return Math.ceil(fontSize * 1.5);
}

/**
 * Line height for statement bodies. LINE's bubbles read at about 1.35–1.4, but B1 (no half-clipped
 * CJK lines) wins: the line style stays at lineHeightFor's 1.5, above the 1.45 floor kept until a
 * device screenshot proves a tighter value safe. Slack's mobile body is looser (about 1.6).
 * Proportional, and never below lineHeightFor.
 */
export function bodyLineHeightFor(fontSize: number, variant: DisplayStyle = 'line'): number {
  return Math.max(lineHeightFor(fontSize), Math.ceil(fontSize * (variant === 'slack' ? 1.6 : 1.5)));
}

function makeUi(colors: ThemeColors) {
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

function makeTheme(colors: ThemeColors) {
  return { colors, ui: makeUi(colors) };
}

const themes = {
  line: { light: makeTheme(lineLight), dark: makeTheme(lineDark) },
  slack: { light: makeTheme(slackLight), dark: makeTheme(slackDark) },
} as const;

/** The display style whose colour system the subtree draws in (the meeting screen sets it). */
const ThemeStyleContext = createContext<DisplayStyle>('line');
export const ThemeStyleProvider = ThemeStyleContext.Provider;

/** The active theme: the given style, else the surrounding ThemeStyleProvider's, in the system scheme. */
export function useTheme(variant?: DisplayStyle) {
  const contextStyle = useContext(ThemeStyleContext);
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return themes[variant ?? contextStyle][scheme];
}

export function useThemeColors(variant?: DisplayStyle) {
  return useTheme(variant).colors;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
}
