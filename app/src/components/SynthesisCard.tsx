import { Pressable, StyleSheet, Text } from 'react-native';
import type { PacketEntry } from '../types';
import { statementLead } from './statementLead';
import { useTheme } from './styles';

export function SynthesisCard({ entry, onPress }: { entry: PacketEntry<'synthesis'>; onPress: () => void }) {
  const { colors, ui } = useTheme();
  const body = entry.packet.body;
  const summary = statementLead(body.recommendation?.trim() || body.reception_summary).text;

  return (
    <Pressable accessibilityRole="button" accessibilityHint="統合結果の詳細を開く" onPress={onPress}
      style={[ui.card, ui.systemCard, styles.pinned, { backgroundColor: colors.pale, borderColor: colors.accent }]}>
      <Text style={ui.title}>統合結果</Text>
      {!!summary && <Text style={ui.body}>{summary}</Text>}
      <Text style={[ui.muted, { color: colors.accentText }]}>詳細</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pinned: { borderWidth: 1, padding: 14 },
});
