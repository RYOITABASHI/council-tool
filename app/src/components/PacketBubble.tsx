import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MessageEntry } from '../model';
import { SeatAvatar } from './SeatAvatar';
import { statementLead } from './statementLead';
import { formatTime, useTheme } from './styles';

type Props = { entry: MessageEntry; isSuperseded: boolean; onPress: () => void };

export function PacketBubble({ entry, isSuperseded, onPress }: Props) {
  const { colors, ui } = useTheme();
  const { packet, packet_state: status } = entry;
  const seat = packet.header.seat_id ?? 'システム';
  const body = packet.body;
  const lead = statementLead('text' in body ? body.text : body.body);
  const hasDetails = lead.hasMore || ('claims' in body && body.claims?.some(
    claim => claim.statement?.trim() || claim.reversal_condition?.trim(),
  )) || ('basis' in body && !!body.basis.trim());
  const received = status.reception === 'received';
  const time = formatTime(packet.header.created_at);

  return (
    <Pressable accessibilityRole="button" accessibilityHint="発言の詳細を開く" onPress={onPress}
      style={[styles.row, isSuperseded && styles.superseded]}>
      <SeatAvatar seat={seat} />
      <View style={styles.column}>
        <Text style={[ui.muted, styles.seat]}>{seat}</Text>
        <View style={styles.bubbleLine}>
          <View style={[ui.card, styles.bubble]}>
            <Text style={ui.body}>{lead.text}</Text>
            {hasDetails && <Text style={[ui.muted, { color: colors.accentText }]}>詳細</Text>}
          </View>
          {(received || !!time) && (
            <View style={styles.receipt}>
              {received && <Text style={[ui.muted, styles.timestamp]}>既読</Text>}
              {!!time && <Text style={[ui.muted, styles.timestamp]}>{time}</Text>}
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  column: { flex: 1, minWidth: 0, gap: 2 },
  seat: { fontSize: 12, lineHeight: 16, paddingLeft: 2 },
  bubbleLine: { flexDirection: 'row', alignItems: 'flex-end', gap: 5 },
  bubble: { maxWidth: '88%', flexShrink: 1, borderRadius: 16, borderTopLeftRadius: 3, padding: 10, gap: 4 },
  receipt: { alignItems: 'flex-start', flexShrink: 0 },
  timestamp: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
  superseded: { opacity: 0.68 },
});
