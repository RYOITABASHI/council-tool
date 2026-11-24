import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MessageEntry } from '../model';
import type { DisplayStyle } from '../storage';
import { MentionText } from './MentionText';
import { SeatAvatar } from './SeatAvatar';
import { statementLead } from './statementLead';
import { formatTime, useTheme } from './styles';

type Props = {
  entry: MessageEntry; isSuperseded: boolean; onPress: () => void;
  seatIds: readonly string[]; variant?: DisplayStyle; reply?: boolean;
};

export function PacketBubble({ entry, isSuperseded, onPress, seatIds, variant = 'line', reply = false }: Props) {
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
  const details = hasDetails && <Text style={[ui.muted, styles.details, { color: colors.accentText }]}>詳細</Text>;

  if (variant === 'slack') {
    // Slack message: name + time share the first line, rounded-square avatar, flat body.
    return (
      <Pressable accessibilityRole="button" accessibilityHint="発言の詳細を開く" onPress={onPress}
        style={({ pressed }) => [styles.slackRow, pressed && { backgroundColor: colors.pressed },
          isSuperseded && styles.superseded]}>
        <SeatAvatar seat={seat} size={reply ? 28 : 38} shape="rounded" />
        <View style={styles.column}>
          <Text style={styles.slackMeta}>
            <Text style={[ui.label, styles.slackName]}>{seat}</Text>
            {!!time && <Text style={[ui.muted, styles.timestamp]}>{'  '}{time}</Text>}
            {received && <Text style={[ui.muted, styles.timestamp]}>{'  '}既読</Text>}
          </Text>
          <MentionText text={lead.text} seatIds={seatIds} style={ui.body} />
          {details}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable accessibilityRole="button" accessibilityHint="発言の詳細を開く" onPress={onPress}
      style={[styles.row, isSuperseded && styles.superseded]}>
      <SeatAvatar seat={seat} size={40} />
      <View style={styles.column}>
        <Text style={[ui.muted, styles.seat]}>{seat}</Text>
        <View style={styles.bubbleLine}>
          <View style={styles.bubbleWrap}>
            <View style={[styles.tail, { borderTopColor: colors.bubble }]} />
            <View style={[styles.bubble, { backgroundColor: colors.bubble }]}>
              <MentionText text={lead.text} seatIds={seatIds} style={[ui.body, styles.bubbleText]} />
              {details}
            </View>
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
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingRight: 8 },
  column: { flex: 1, minWidth: 0, gap: 3 },
  seat: { fontSize: 12, lineHeight: 15, paddingLeft: 6 },
  bubbleLine: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  bubbleWrap: { maxWidth: '84%', flexShrink: 1, paddingLeft: 5 },
  // Small notch at the speaker's top corner, like LINE's bubble tail.
  tail: {
    position: 'absolute', left: 0, top: 0, width: 0, height: 0,
    borderTopWidth: 12, borderLeftWidth: 12, borderLeftColor: 'transparent',
  },
  bubble: { borderRadius: 19, borderTopLeftRadius: 9, paddingHorizontal: 13, paddingVertical: 9, gap: 4 },
  bubbleText: { fontSize: 15.5, lineHeight: 22 },
  details: { fontSize: 12 },
  receipt: { alignItems: 'flex-start', flexShrink: 0, paddingBottom: 1 },
  timestamp: { fontSize: 10.5, lineHeight: 13, fontVariant: ['tabular-nums'] },
  slackRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 5, paddingHorizontal: 4, borderRadius: 6 },
  slackMeta: { lineHeight: 20 },
  slackName: { fontSize: 15 },
  superseded: { opacity: 0.68 },
});
