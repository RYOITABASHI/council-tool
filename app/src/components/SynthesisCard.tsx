import { StyleSheet, Text, View } from 'react-native';
import type { PacketEntry } from '../types';
import { colors, ui } from './styles';

export function SynthesisCard({ entry }: { entry: PacketEntry<'synthesis'> }) {
  const body = entry.packet.body;
  const groups = [
    { label: '合意点', items: body.agreements },
    { label: '少数意見', items: body.minority_opinions.map(item => `${item.seat_id}：${item.opinion}`) },
    { label: '判断が変わる条件', items: body.reversal_conditions.map(
      item => `${item.claim} → ${item.condition}（${item.source_seat}）`,
    ) },
    { label: '申告された不足', items: body.declared_missing_records.map(
      item => `${item.seat_id}：${item.note}（${item.packet_id}）`,
    ) },
  ];

  return (
    <View style={[ui.card, styles.pinned]}>
      <Text accessibilityRole="header" style={ui.title}>統合結果</Text>
      {!!body.recommendation && (
        <View>
          <Text style={ui.label}>推奨</Text>
          <Text selectable style={ui.body}>{body.recommendation}</Text>
        </View>
      )}
      {groups.filter(group => group.items.length > 0).map(({ label, items }) => (
        <View key={label}>
          <Text style={ui.label}>{label}</Text>
          {items.map((item, index) => <Text selectable key={index} style={ui.body}>• {item}</Text>)}
        </View>
      ))}
      {!!body.reception_summary && (
        <View>
          <Text style={ui.label}>受理状況</Text>
          <Text selectable style={ui.body}>{body.reception_summary}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pinned: { backgroundColor: colors.pale, borderWidth: 1, borderColor: colors.border },
});
