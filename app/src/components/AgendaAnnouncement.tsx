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
      <Megaphone color={colors.announceIcon} />
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
      <Text style={[styles.chevron, { color: colors.muted }]} aria-hidden>{expanded ? '︿' : '›'}</Text>
    </Pressable>
  );
}

/**
 * A flat megaphone drawn with plain views (a mouth cone plus a small back block), in one colour, so it
 * never clashes with the bar the way the colour emoji 📢 did. Sized to the topic's first line.
 */
function Megaphone({ color }: { color: string }) {
  return (
    <View style={styles.icon} aria-hidden>
      <View style={[styles.back, { backgroundColor: color }]} />
      <View style={[styles.cone, { borderRightColor: color }]} />
      <View style={[styles.handle, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginHorizontal: 8, marginTop: 6,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    elevation: 2, shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  icon: { width: 20, height: lineHeightFor(14.5), flexDirection: 'row', alignItems: 'center' },
  back: { width: 5, height: 8, borderRadius: 1.5 },
  // A triangle opening to the right: the megaphone's mouth.
  cone: {
    width: 0, height: 0, borderRightWidth: 12, borderTopWidth: 8, borderBottomWidth: 8,
    borderTopColor: 'transparent', borderBottomColor: 'transparent', marginLeft: -1,
  },
  handle: { position: 'absolute', left: 3, top: lineHeightFor(14.5) / 2 + 3, width: 3, height: 5, borderRadius: 1 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  topic: { fontSize: 14.5, lineHeight: lineHeightFor(14.5), fontWeight: '600' },
  // LINE: a chevron on the right of the bar (› while collapsed; ︿ closes the expanded topic).
  chevron: { width: 16, textAlign: 'center', fontSize: 16, lineHeight: lineHeightFor(16), marginTop: -1 },
});
