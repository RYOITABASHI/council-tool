import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PacketEntry, MissingRecord } from '../types';
import { isPacketKind } from '../types';
import { Details } from './Details';
import { formatTime, useTheme } from './styles';

type Props = {
  entry: PacketEntry<'answer' | 'critique' | 'flash' | 'note' | 'gate_decision'>;
  supersededBy?: string;
  isSuperseded: boolean;
  splitParagraphs: boolean;
};

const missingLabels: Record<MissingRecord, string> = {
  claims: '主張', statement: '主張文', reversal_condition: '判断が変わる条件',
};

function avatarColor(seat: string): string {
  let hash = 0;
  for (const letter of seat) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 55%, 86%)`;
}

export function PacketBubble({ entry, supersededBy, isSuperseded, splitParagraphs }: Props) {
  const { colors, ui } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { packet, packet_state: status, missing_records: missing } = entry;
  const { kind, created_at } = packet.header;
  const seat = packet.header.seat_id ?? (kind === 'gate_decision' ? '議長' : 'システム');
  const body = packet.body;
  const text = 'text' in body ? body.text : 'rationale' in body ? body.rationale : body.body;
  const claims = ('claims' in body ? body.claims : undefined)?.filter(
    claim => claim.statement?.trim() || claim.reversal_condition?.trim(),
  );
  const unverified = status.reception === 'transcribed_pending_attest' || status.verification === 'unverified';
  const received = status.reception === 'received';
  const time = formatTime(created_at);

  const visible = !isSuperseded || expanded;
  const basis = isPacketKind(entry, 'flash') ? entry.packet.body.basis : undefined;
  const paragraphs = visible && splitParagraphs
    ? text.split(/\r?\n(?:[^\S\r\n]*\r?\n)+/).filter(paragraph => paragraph.trim())
    : [];
  const segments = paragraphs.length > 1 ? paragraphs : [text];

  const packetDetails = (
    <>
      {isSuperseded && (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
          accessibilityLabel="差し替え済みの発言"
          onPress={() => setExpanded(value => !value)} style={styles.supersededToggle}>
          <Text style={ui.muted}>差し替え済み {expanded ? '⌃' : '⌄'}</Text>
        </Pressable>
      )}
      {visible && (
        <>
          {(status.verification === 'verified' || unverified || status.reception === 'invalidated' ||
            missing.length > 0) && (
            <View style={ui.wrap}>
              {status.verification === 'verified' && <Text style={ui.chip}>照合済み</Text>}
              {unverified && <Text style={[ui.chip, ui.warning]}>未検証（確認待ち）</Text>}
              {status.reception === 'invalidated' && <Text style={[ui.chip, ui.danger]}>無効化</Text>}
              {missing.length > 0 &&
                <Text style={[ui.chip, ui.warning]}>不足：{missing.map(item => missingLabels[item]).join(' / ')}</Text>}
            </View>
          )}
          {isSuperseded && supersededBy && <Text style={ui.muted}>新しい版のID：{supersededBy}</Text>}
          {(!!claims?.length || !!basis) && (
            <Details>
              {!!basis && <Text style={ui.muted}>根拠：{basis}</Text>}
              {claims?.map((claim, index) => (
                <View key={index} style={[styles.claim, { borderLeftColor: colors.border }]}>
                  {!!claim.statement?.trim() && <Text style={ui.body}>• {claim.statement}</Text>}
                  {!!claim.reversal_condition?.trim() &&
                    <Text style={ui.muted}>判断が変わる条件：{claim.reversal_condition}</Text>}
                </View>
              ))}
            </Details>
          )}
        </>
      )}
    </>
  );

  const content = (
    <>
      <View style={[styles.avatar, { backgroundColor: avatarColor(seat) }]} aria-hidden>
        <Text style={[ui.label, { color: colors.avatarInk }]}>{Array.from(seat)[0]?.toUpperCase()}</Text>
      </View>
      <View style={styles.column}>
        <Text style={[ui.muted, styles.seat]}>{seat}</Text>
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <View key={index} style={styles.bubbleLine}>
              <View style={[ui.card, styles.bubble]}>
                {visible && <Text selectable style={ui.body}>{segment}</Text>}
                {last && packetDetails}
              </View>
              {last && (received || !!time) && (
                <View style={styles.receipt}>
                  {received && <Text style={[ui.muted, styles.timestamp]}>既読</Text>}
                  {!!time && <Text style={[ui.muted, styles.timestamp]}>{time}</Text>}
                </View>
              )}
            </View>
          );
        })}
      </View>
    </>
  );

  return <View style={[styles.row, isSuperseded && styles.superseded]}>{content}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  column: { flex: 1, minWidth: 0, gap: 2 },
  seat: { fontSize: 12, lineHeight: 16, paddingLeft: 2 },
  bubbleLine: { flexDirection: 'row', alignItems: 'flex-end', gap: 5 },
  bubble: { maxWidth: '88%', flexShrink: 1, borderRadius: 16, borderTopLeftRadius: 3, padding: 10, gap: 4 },
  supersededToggle: { gap: 4, minHeight: 44, justifyContent: 'center' },
  receipt: { alignItems: 'flex-start', flexShrink: 0 },
  timestamp: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
  claim: { borderLeftWidth: 2, paddingLeft: 8 },
  superseded: { opacity: 0.68 },
});
