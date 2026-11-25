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
  seatIds: readonly string[]; variant?: DisplayStyle;
  /** Thread style: a reply under the round's first post (drawn the same; kept for the caller's intent). */
  reply?: boolean;
  /**
   * Line style: the first bubble of a run from one speaker. It carries the avatar, the name and the
   * tail; the run's later bubbles hang under it without them (LINE's grouping). Defaults to true.
   */
  groupStart?: boolean;
};

/** Speaker shown for the owner's own posts (notes) in the thread style. */
export const ownSpeaker = 'あなた';

/**
 * A note is the owner's own post (a mention sent from the composer), unless the facade attributes
 * it to the chair (B3). Notes without attribution (older data) keep the old reading: own posts.
 */
export function isOwnPost(entry: MessageEntry): boolean {
  return entry.packet.header.kind === 'note' && entry.origin?.kind !== 'chair';
}

/** B3: a note posted by the chair (drawn as another speaker's post, with a small 議長 tag). */
export function isChairNote(entry: MessageEntry): boolean {
  return entry.packet.header.kind === 'note' && entry.origin?.kind === 'chair';
}

/** B3: the 「@席 へ」 label of a note with an addressee (display only; the stored text is untouched). */
export function addresseeLabel(entry: MessageEntry): string | undefined {
  const { addressee } = entry;
  return entry.packet.header.kind === 'note' && typeof addressee === 'string' && addressee
    ? `@${addressee} へ` : undefined;
}

export const chairTag = '議長';

export function PacketBubble({
  entry, isSuperseded, onPress, seatIds, variant = 'line', groupStart = true,
}: Props) {
  const { colors, ui } = useTheme();
  const { packet, packet_state: status } = entry;
  const own = isOwnPost(entry);
  const chair = isChairNote(entry);
  const toLabel = addresseeLabel(entry);
  const seat = packet.header.seat_id ?? 'システム';
  const body = packet.body;
  // An own post names its addressee as a leading mention (the composer removes the typed `@…`).
  const addressee = own && packet.header.seat_id !== null && seatIds.includes(packet.header.seat_id)
    ? `@${packet.header.seat_id} ` : '';
  const lead = statementLead(addressee + ('text' in body ? body.text : body.body));
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
  const { width } = useWindowDimensions();
  // LINE's geometry, applied to the bubble itself (not its wrapper; the tail sits outside the bubble).
  // The frame is the meeting list (the screen, up to the list's 800dp cap). Others: the bubble's left
  // edge sits at the avatar-side margin (list inset 10 + avatar 40 + gap 8 = 58) and its right edge
  // reaches at most 85% of the frame. Own: the mirror — the right edge sits at the list inset plus
  // the tail's room (10 + 6 = 16) and the left edge reaches at most 15% of the frame. At the narrowest
  // 320dp layout the others' bubble leaves 186dp of text, above the 174dp narrowestLineCharacters assumes.
  const frame = Math.min(width, listMaxWidth);
  const bubbleMax = own
    ? Math.max(160, frame - ownEdgeInset - Math.round(frame * 0.15))
    : Math.max(160, Math.round(frame * 0.85) - avatarSideMargin);

  if (variant === 'slack') {
    // Slack mobile message: rounded-square avatar, bold name with the time on the same line, flat body
    // whose left edge sits 12dp right of the avatar.
    const speaker = own ? ownSpeaker : seat;
    const details = hasDetails && <Text style={[styles.slackDetails, { color: colors.mention }]}>詳細</Text>;
    // Own rows keep "あなた" and the avatar; the addressee label follows on the speaker line.
    return (
      <Pressable accessibilityRole="button" accessibilityHint="発言の詳細を開く" onPress={onPress}
        style={({ pressed }) => [styles.slackRow, pressed && { backgroundColor: colors.pressed },
          isSuperseded && styles.superseded]}>
        {/* Slack mobile draws replies with the same 38dp rounded-square avatar as top-level posts. */}
        <SeatAvatar seat={speaker} size={38} shape="rounded" />
        <View style={styles.column}>
          <Text style={styles.slackMeta}>
            <Text style={[styles.slackName, { color: colors.ink }]}>{speaker}</Text>
            {chair && <Text style={styles.slackTime}>{'  '}<Text style={[styles.tag, { backgroundColor: colors.pale, color: colors.ink }]}>{` ${chairTag} `}</Text></Text>}
            {!!toLabel && <Text style={[styles.slackTime, { color: colors.mention }]}>{'  '}{toLabel}</Text>}
            {!!time && <Text style={[styles.slackTime, { color: colors.meta }]}>{'  '}{time}</Text>}
            {received && <Text style={[styles.slackTime, { color: colors.meta }]}>{'  '}既読</Text>}
          </Text>
          <MentionText text={leadText} seatIds={seatIds} style={[ui.body, styles.slackBody]} numberOfLines={leadLines}
            onTextLayout={onLeadLayout} />
          {details}
        </View>
      </Pressable>
    );
  }

  // Time (and 既読) outside the bubble, bottom-aligned and stacked: right of others' bubbles, left of
  // one's own. The column takes the row's spare width and its labels stretch across it, so "既読" / the
  // time never sit in a box cut to their exact measured width.
  const receipt = (received || !!time) && (
    <View style={[styles.receipt, own && styles.ownReceipt]}>
      {received && <Text numberOfLines={1} style={[styles.timestamp, own && styles.right, { color: colors.meta }]}>既読</Text>}
      {!!time && <Text numberOfLines={1} style={[styles.timestamp, own && styles.right, { color: colors.meta }]}>{time}</Text>}
    </View>
  );
  const fill = own ? colors.ownBubble : colors.bubble;
  const ink = own ? colors.ownInk : colors.bubbleInk;
  const bubble = (
    <View style={[styles.bubbleWrap, own && styles.ownWrap]}>
      {/* LINE's tail: a small notch at the speaker's top corner, on a run's first bubble only. */}
      {groupStart && <View style={[own ? styles.ownTail : styles.tail, { borderTopColor: fill }]} />}
      <View style={[styles.bubble, { backgroundColor: fill, maxWidth: bubbleMax },
        groupStart && (own ? styles.ownCorner : styles.otherCorner)]}>
        <MentionText text={leadText} seatIds={seatIds} style={[ui.body, styles.bubbleText, { color: ink }]}
          numberOfLines={leadLines} onTextLayout={onLeadLayout} />
        {hasDetails && (
          <Text style={[styles.details, { color: own ? colors.ownInk : colors.accentText }, own && styles.ownDetails]}>
            詳細
          </Text>
        )}
      </View>
    </View>
  );

  if (own) {
    const row = (
      <View style={styles.ownRow}>
        {receipt}
        {bubble}
      </View>
    );
    return (
      <Pressable accessibilityRole="button" accessibilityHint="発言の詳細を開く" onPress={onPress}
        style={[toLabel ? styles.ownColumn : styles.ownRow, isSuperseded && styles.superseded]}>
        {toLabel ? (
          <>
            {/* B3: the addressee sits above the bubble, right-aligned like the bubble itself. */}
            <Text numberOfLines={1} style={[styles.seat, styles.right, styles.ownLabel, { color: colors.meta }]}>{toLabel}</Text>
            {row}
          </>
        ) : (
          <>
            {receipt}
            {bubble}
          </>
        )}
      </Pressable>
    );
  }

  return (
    <Pressable accessibilityRole="button" accessibilityHint="発言の詳細を開く" onPress={onPress}
      // A run's later bubbles drop the visible name; the label keeps the speaker for screen readers.
      accessibilityLabel={groupStart ? undefined
        : [seat, chair ? chairTag : '', toLabel ?? '', leadText, received ? '既読' : '', time].filter(Boolean).join(' ')}
      style={[styles.row, isSuperseded && styles.superseded]}>
      {groupStart ? <SeatAvatar seat={seat} size={40} /> : <View style={styles.avatarSpace} />}
      <View style={styles.column}>
        {groupStart && (
          <Text numberOfLines={1} style={[styles.seat, { color: colors.meta }]}>
            {seat}
            {chair && <Text>{'  '}<Text style={[styles.tag, { backgroundColor: colors.pale, color: colors.ink }]}>{` ${chairTag} `}</Text></Text>}
            {!!toLabel && <Text>{'  '}{toLabel}</Text>}
          </Text>
        )}
        <View style={styles.bubbleLine}>
          {bubble}
          {receipt}
        </View>
      </View>
    </Pressable>
  );
}

const tailSize = 10;
/** How far the tail sticks out past the bubble's edge. */
const tailOverhang = tailSize - 4;
/** meeting.tsx `styles.list`: maxWidth 800, paddingHorizontal 10. */
const listMaxWidth = 800;
const listInset = 10;
/** Others' bubble left edge: list inset + avatar 40 + gap 8. */
const avatarSideMargin = listInset + 40 + 8;
/** Own bubble right edge: list inset + the tail's overhang (the wrapper's right padding). */
const ownEdgeInset = listInset + tailOverhang;

const styles = StyleSheet.create({
  // Line style: avatar 40, then 8dp to the bubble column.
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingRight: 4 },
  avatarSpace: { width: 40 },
  column: { flex: 1, minWidth: 0, gap: 4 },
  // Name above the bubble: about 11dp, grey, aligned with the bubble's left edge.
  seat: { fontSize: 11, lineHeight: lineHeightFor(11) },
  bubbleLine: { flexDirection: 'row', alignItems: 'flex-end', gap: 5 },
  bubbleWrap: { flexShrink: 1 },
  // Others' bubbles start at the column's edge (58dp); their tail overhangs into the avatar gap.
  // Own bubbles keep the tail inside the wrapper's right padding.
  ownWrap: { paddingRight: tailOverhang },
  // Small notch at the speaker's top corner, like LINE's bubble tail.
  tail: {
    position: 'absolute', left: -tailOverhang, top: 0, width: 0, height: 0,
    borderTopWidth: tailSize, borderLeftWidth: tailSize, borderLeftColor: 'transparent',
  },
  ownTail: {
    position: 'absolute', right: 0, top: 0, width: 0, height: 0,
    borderTopWidth: tailSize, borderRightWidth: tailSize, borderRightColor: 'transparent',
  },
  // LINE bubble: corner about 19dp, padding 14 × 10.
  bubble: { borderRadius: 19, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  otherCorner: { borderTopLeftRadius: 8 },
  ownCorner: { borderTopRightRadius: 8 },
  bubbleText: { fontSize: 15.5, lineHeight: bodyLineHeightFor(15.5, 'line') },
  details: { fontSize: 12, lineHeight: lineHeightFor(12) },
  ownDetails: { textDecorationLine: 'underline' },
  // No left padding: the own bubble's 15% bound (bubbleMax) leaves the receipt column its room.
  ownRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'flex-end', gap: 5 },
  // B3: an own post with an addressee stacks the label over the usual row.
  ownColumn: { gap: 2 },
  // Aligned with the bubble's right edge (inside the tail's room).
  ownLabel: { paddingRight: tailOverhang },
  receipt: { flexGrow: 1, flexShrink: 0, alignItems: 'stretch', paddingBottom: 1 },
  ownReceipt: { flexGrow: 1 },
  right: { textAlign: 'right' },
  timestamp: { fontSize: 10.5, lineHeight: lineHeightFor(10.5), fontVariant: ['tabular-nums'] },
  // Thread style (Slack mobile).
  slackRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 6 },
  slackMeta: { lineHeight: lineHeightFor(15) },
  // Slack's speaker line: the name bold, in the body colour, at 15dp; the time grey at 12dp.
  slackName: { fontSize: 15, lineHeight: lineHeightFor(15), fontWeight: '700' },
  slackTime: { fontSize: 12, lineHeight: lineHeightFor(12), fontVariant: ['tabular-nums'] },
  slackBody: { fontSize: 16, lineHeight: bodyLineHeightFor(16, 'slack') },
  slackDetails: { fontSize: 13, lineHeight: lineHeightFor(13) },
  superseded: { opacity: 0.68 },
  // B3: the small 議長 tag after a chair note's speaker name (a nested text run on the pale chip colour).
  tag: { fontWeight: '600' },
});
