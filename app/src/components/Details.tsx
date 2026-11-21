import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from './styles';

export function Details({ children }: { children: ReactNode }) {
  const { colors, ui } = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="詳細"
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.toggle}>
        <Text style={[ui.muted, { color: colors.accentText }]}>詳細 {expanded ? '⌃' : '⌄'}</Text>
      </Pressable>
      {expanded && children}
    </>
  );
}

const styles = StyleSheet.create({
  toggle: { alignSelf: 'flex-start', minWidth: 44, minHeight: 44, justifyContent: 'center' },
});
