import { StyleSheet, Text, View } from 'react-native';
import type { PacketEntry } from '../types';
import { Details } from './Details';
import { useTheme } from './styles';

function SynthesisItems({ label, items }: { label: string; items: string[] }) {
  const { ui } = useTheme();
  if (items.length === 0) return null;
  return (
    <View>
      <Text style={ui.label}>{label}</Text>
      {items.map((item, index) => <Text selectable key={index} style={ui.body}>• {item}</Text>)}
    </View>
  );
}

export function SynthesisCard({ entry }: { entry: PacketEntry<'synthesis'> }) {
  const { colors, ui } = useTheme();
  const body = entry.packet.body;
  const summary = body.recommendation?.trim() ? body.recommendation : body.reception_summary;
  const unverified = (body.unverified_items ?? []).flatMap(item => {
    if (!item || typeof item !== 'object' || !('seat_id' in item) || !('packet_id' in item) ||
        typeof item.seat_id !== 'string' || typeof item.packet_id !== 'string') return [];
    return [`${item.seat_id}（${item.packet_id}）`];
  });
  const reversals = body.reversal_conditions.map(
    item => `${item.claim} → ${item.condition}（${item.source_seat}）`,
  );
  const reception = body.reception_summary !== summary ? body.reception_summary : '';

  return (
    <View style={[ui.card, ui.systemCard, styles.pinned, { backgroundColor: colors.pale, borderColor: colors.accent }]}>
      <Text accessibilityRole="header" style={ui.title}>統合結果</Text>
      {!!summary && <Text selectable style={ui.body}>{summary}</Text>}
      <SynthesisItems label="少数意見" items={body.minority_opinions.map(item => `${item.seat_id}：${item.opinion}`)} />
      <SynthesisItems label="未検証" items={unverified} />
      <SynthesisItems label="申告された不足" items={body.declared_missing_records.map(
        item => `${item.seat_id}：${item.note}（${item.packet_id}）`,
      )} />
      {(body.agreements.length > 0 || reversals.length > 0 || !!reception) && (
        <Details>
          <SynthesisItems label="合意点" items={body.agreements} />
          <SynthesisItems label="判断が変わる条件" items={reversals} />
          {!!reception && (
            <View>
              <Text style={ui.label}>受理状況</Text>
              <Text selectable style={ui.body}>{reception}</Text>
            </View>
          )}
        </Details>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pinned: { borderWidth: 1, padding: 14 },
});
