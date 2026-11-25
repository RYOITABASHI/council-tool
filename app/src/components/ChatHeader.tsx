import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lineHeightFor, useTheme } from './styles';

/** LINE-style thin header: optional back chevron, one-line title with member count, quiet icon actions. */
export function ChatHeader({ title, count, onBack, backgroundColor, large = false, children }: {
  title: string; count?: number; onBack?: () => void; backgroundColor: string; large?: boolean;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, {
      paddingTop: insets.top, backgroundColor, borderBottomColor: colors.border,
    }]}>
      <View style={styles.row}>
        {onBack && (
          <Pressable accessibilityRole="button" accessibilityLabel="戻る" onPress={onBack} hitSlop={6}
            style={styles.back}>
            <Text style={[styles.chevron, { color: colors.ink }]}>‹</Text>
          </Pressable>
        )}
        <View style={[styles.titleRow, !onBack && styles.titleInset]}>
          {/* The title fills the row, so a short title always has spare width and an overlong one ends
              in "…" instead of silently losing its tail; the seat count follows as a "3席" chip. */}
          <Text accessibilityRole="header" numberOfLines={1}
            accessibilityLabel={count !== undefined ? `${title}（${count}席）` : title}
            style={[large ? styles.largeTitle : styles.title, styles.fill, { color: colors.ink }]}>
            {title}
          </Text>
          {count !== undefined && (
            <View style={[styles.countChip, { backgroundColor: colors.pill }]} aria-hidden>
              <Text numberOfLines={1} style={[styles.countText, { color: colors.pillInk }]}>{count}席</Text>
            </View>
          )}
        </View>
        {children && <View style={styles.actions}>{children}</View>}
      </View>
    </View>
  );
}

export function HeaderIcon({ glyph, label, onPress, disabled = false }: {
  glyph: string; label: string; onPress: () => void; disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
      style={({ pressed }) => [styles.icon, (disabled || pressed) && styles.dim]}>
      <Text style={[styles.iconGlyph, { color: colors.ink }]}>{glyph}</Text>
    </Pressable>
  );
}

/** A header button that reads as its current value (e.g. the display style), with a label to tap. */
export function HeaderPill({ text, label, hint, onPress, disabled = false }: {
  text: string; label: string; hint?: string; onPress: () => void; disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
      disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} hitSlop={4}
      style={({ pressed }) => [styles.pillButton, { borderColor: colors.border, backgroundColor: colors.surface },
        (disabled || pressed) && styles.dim]}>
      <Text numberOfLines={1} style={[styles.pillText, { color: colors.ink }]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  back: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  chevron: { fontSize: 34, lineHeight: 38, fontWeight: '300', marginTop: -4 },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0, paddingRight: 4 },
  titleInset: { paddingLeft: 12 },
  fill: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '600' },
  largeTitle: { fontSize: 22, fontWeight: '700' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { fontSize: 22 },
  dim: { opacity: 0.45 },
  countChip: { flexShrink: 0, marginLeft: 6, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, minWidth: 40 },
  // Stretched across the chip (with a minimum width), so the label is never boxed to an exact fit.
  countText: { alignSelf: 'stretch', textAlign: 'center', fontSize: 12, lineHeight: lineHeightFor(12), fontWeight: '600' },
  pillButton: {
    minWidth: 72, height: 32, marginHorizontal: 4, paddingHorizontal: 10, borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'stretch', justifyContent: 'center',
  },
  pillText: { textAlign: 'center', fontSize: 13, lineHeight: lineHeightFor(13), fontWeight: '600' },
});
