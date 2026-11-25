import { useState } from 'react';
import type { TextLayoutEvent } from 'react-native';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { MessageEntry } from '../model';
import type { DisplayStyle } from '../storage';
import { MentionText } from './MentionText';
import { SeatAvatar } from './SeatAvatar';
import { layoutWasCut, leadLines, mayExceedLines, narrowestPerLine, statementLead } from './statementLead';
import { bodyLineHeightFor, formatTime, lineHeightFor, useTheme } from './styles';

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
  // A lead that stops before the statement does (later paragraphs dropped) ends in "…" too, so the
  // omission shows in the bubble itself and not only through the detail link.
  const leadText = lead.hasMore && !lead.text.endsWith('…') ? `${lead.text} …` : lead.text;
  // The lead is cut at whole lines (numberOfLines, "…" at the end); a lead that is or may be cut
  // always offers the detail link, whose meaning (open the full statement) is unchanged. Two checks:
  // a pessimistic estimate at the narrowest width and current font scale (right from the first
  // frame), and the measured layout, which catches any width or font the estimate misses. The
  // measurement is remembered for the text it was taken on, so a changed lead is measured afresh.
  const { fontScale } = useWindowDimensions();
  const [cutLead, setCutLead] = useState<string | null>(null);
  const onLeadLayout = (event: TextLayoutEvent) => {
    const cut = layoutWasCut(event.nativeEvent.lines.length);
    setCutLead(current => cut ? leadText : current === leadText ? null : current);
  };
  const leadIsCut = cutLead === leadText || mayExceedLines(leadText, leadLines, narrowestPerLine(fontScale));
  const hasDetails = lead.hasMore || leadIsCut || ('claims' in body && body.claims?.some(
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
            <Text style={[styles.slackName, { color: colors.ink }]}>{seat}</Text>
            {!!time && <Text style={[ui.muted, styles.timestamp]}>{'  '}{time}</Text>}
            {received && <Text style={[ui.muted, styles.timestamp]}>{'  '}既読</Text>}
          </Text>
          <MentionText text={leadText} seatIds={seatIds} style={[ui.body, styles.slackBody]} numberOfLines={leadLines}
            onTextLayout={onLeadLayout} />
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
              <MentionText text={leadText} seatIds={seatIds} style={[ui.body, styles.bubbleText]} numberOfLines={leadLines}
            onTextLayout={onLeadLayout} />
              {details}
            </View>
          </View>
          {(received || !!time) && (
            <View style={styles.receipt}>
              {received && <Text numberOfLines={1} style={[ui.muted, styles.timestamp]}>既読</Text>}
              {!!time && <Text numberOfLines={1} style={[ui.muted, styles.timestamp]}>{time}</Text>}
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
  seat: { fontSize: 12, lineHeight: lineHeightFor(12), paddingLeft: 6 },
  bubbleLine: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  bubbleWrap: { maxWidth: '84%', flexShrink: 1, paddingLeft: 5 },
  // Small notch at the speaker's top corner, like LINE's bubble tail.
  tail: {
    position: 'absolute', left: 0, top: 0, width: 0, height: 0,
    borderTopWidth: 12, borderLeftWidth: 12, borderLeftColor: 'transparent',
  },
  bubble: { borderRadius: 19, borderTopLeftRadius: 9, paddingHorizontal: 13, paddingVertical: 9, gap: 4 },
  bubbleText: { fontSize: 15.5, lineHeight: bodyLineHeightFor(15.5) },
  details: { fontSize: 12 },
  // The receipt column takes the row's spare width beside the bubble (the bubble is capped at 84%),
  // and its labels stretch across it, so "既読" / the time never sit in a box cut to their exact
  // measured width — a hair of extra rendered width would otherwise wrap their last glyph away.
  receipt: { flexGrow: 1, flexShrink: 0, alignItems: 'stretch', paddingBottom: 1 },
  timestamp: { fontSize: 10.5, lineHeight: lineHeightFor(10.5), fontVariant: ['tabular-nums'] },
  slackRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 5, paddingHorizontal: 4, borderRadius: 6 },
  slackMeta: { lineHeight: lineHeightFor(15) },
  // Slack's speaker line: the name bold, in the body colour, at body size.
  slackName: { fontSize: 15, lineHeight: lineHeightFor(15), fontWeight: '700' },
  slackBody: { fontSize: 15, lineHeight: bodyLineHeightFor(15) },
  superseded: { opacity: 0.68 },
});
