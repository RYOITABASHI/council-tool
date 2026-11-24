import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './styles';

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
          <Text accessibilityRole="header" numberOfLines={1}
            style={[large ? styles.largeTitle : styles.title, styles.shrink, { color: colors.ink }]}>{title}</Text>
          {count !== undefined && (
            <Text style={[large ? styles.largeTitle : styles.title, { color: colors.ink }]}>({count})</Text>
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

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  back: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  chevron: { fontSize: 34, lineHeight: 38, fontWeight: '300', marginTop: -4 },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0, paddingRight: 4 },
  titleInset: { paddingLeft: 12 },
  shrink: { flexShrink: 1 },
  title: { fontSize: 17, fontWeight: '600' },
  largeTitle: { fontSize: 22, fontWeight: '700' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { fontSize: 22 },
  dim: { opacity: 0.45 },
});
