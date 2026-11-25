import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PacketEntry } from '../types';
import { lineHeightFor, useTheme } from './styles';

/** The agenda shown as LINE's pinned announcement bar: one line under the header, tap to expand. */
export function AgendaAnnouncement({ entry }: { entry: PacketEntry<'agenda'> }) {
  const { colors, ui } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { topic, shared_materials: materials } = entry.packet.body;

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`アジェンダ：${topic}`}
      accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
      style={[styles.bar, { backgroundColor: colors.announce, shadowColor: '#000' }]}>
      <Text style={[styles.icon, { color: colors.mention }]} aria-hidden>📢</Text>
      <View style={styles.text}>
        {/* Separate keyed texts so the native view is rebuilt on toggle: reusing the one-line
            view across the switch could keep its old one-line height and clip the expanded topic. */}
        {expanded ? (
          <Text key="full" selectable style={[ui.body, styles.topic]}>{topic}</Text>
        ) : (
          <Text key="line" numberOfLines={1} style={[ui.body, styles.topic]}>{topic}</Text>
        )}
        {expanded && materials.map((material, index) => (
          <Text selectable key={index} style={ui.muted}>{material}</Text>
        ))}
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]} aria-hidden>{expanded ? '︿' : '﹀'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginHorizontal: 8, marginTop: 6,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    elevation: 2, shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  icon: { fontSize: 17, lineHeight: lineHeightFor(14.5) },
  text: { flex: 1, minWidth: 0, gap: 4 },
  topic: { fontSize: 14.5, lineHeight: lineHeightFor(14.5), fontWeight: '600' },
  chevron: { fontSize: 14, lineHeight: lineHeightFor(14.5) },
});
