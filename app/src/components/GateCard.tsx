import { StyleSheet, Text, View } from 'react-native';
import type { PacketEntry } from '../types';
import { useTheme } from './styles';

export function GateCard({ entry }: { entry: PacketEntry<'gate_decision'> }) {
  const { colors, ui } = useTheme();
  const { result, rationale, resolved_points, unresolved_points, next_round_scope } = entry.packet.body;
  const groups = [
    { label: '解消点', items: resolved_points },
    { label: '未解消点', items: unresolved_points },
    { label: '次ラウンド範囲', items: next_round_scope },
  ];

  return (
    <View style={[ui.card, ui.systemCard, styles.gate, { borderLeftColor: colors.accent }]}>
      <Text accessibilityRole="header" style={ui.title}>
        議長ゲート：{result === 'pass' ? '通過' : '差し戻し'}
      </Text>
      {!!rationale && <Text selectable style={ui.body}>{rationale}</Text>}
      {groups.filter(group => group.items.length > 0).map(({ label, items }) => (
        <View key={label}>
          <Text style={ui.label}>{label}</Text>
          {items.map((item, index) => <Text key={index} style={ui.body}>• {item}</Text>)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gate: { borderLeftWidth: 3 },
});
