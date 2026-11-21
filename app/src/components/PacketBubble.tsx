import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PacketEntry, MissingRecord } from '../types';
import { isPacketKind } from '../types';
import { colors, formatTime, ui } from './styles';

type Props = {
  entry: PacketEntry<'answer' | 'critique' | 'flash' | 'note' | 'gate_decision'>;
  supersededBy?: string;
  isSuperseded: boolean;
};

const labels = { answer: '回答', critique: '批評', flash: '速報', note: 'メモ', gate_decision: 'ゲート' };
const missingLabels: Record<MissingRecord, string> = {
  claims: '主張', statement: '主張文', reversal_condition: '判断が変わる条件',
};

function avatarColor(seat: string): string {
  let hash = 0;
  for (const letter of seat) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 55%, 86%)`;
}

export function PacketBubble({ entry, supersededBy, isSuperseded }: Props) {
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

  const content = (
    <>
      <View style={styles.metadata}>
        <View style={[styles.avatar, { backgroundColor: avatarColor(seat) }]}>
          <Text style={ui.label}>{Array.from(seat)[0]?.toUpperCase()}</Text>
        </View>
        <Text style={styles.seat}>{seat}</Text>
        <Text style={ui.muted}>{labels[kind]}</Text>
        <Text style={ui.muted}>{formatTime(created_at)}</Text>
      </View>
      {isSuperseded && (
        <Text style={ui.muted}>
          差し替え済み → 新しい版があります
        </Text>
      )}
      {(!isSuperseded || expanded) && (
        <>
          <Text selectable style={ui.body}>{text}</Text>
          {isPacketKind(entry, 'flash') && <Text style={ui.muted}>根拠：{entry.packet.body.basis}</Text>}
          {claims?.map((claim, index) => (
            <View key={index} style={styles.claim}>
              {!!claim.statement?.trim() && <Text style={ui.body}>• {claim.statement}</Text>}
              {!!claim.reversal_condition?.trim() &&
                <Text style={ui.muted}>判断が変わる条件：{claim.reversal_condition}</Text>}
            </View>
          ))}
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
        </>
      )}
    </>
  );

  return isSuperseded ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityHint={expanded ? '旧版を閉じます' : '旧版の本文を開きます'}
      onPress={() => setExpanded(value => !value)}
      style={[ui.card, styles.superseded]}
    >
      {content}
      {expanded && supersededBy && <Text style={ui.muted}>新しい版のID：{supersededBy}</Text>}
    </Pressable>
  ) : <View style={ui.card}>{content}</View>;
}

const styles = StyleSheet.create({
  metadata: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  seat: { flexGrow: 1, flexShrink: 1, color: colors.ink, fontWeight: '700' },
  claim: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 10 },
  superseded: { opacity: 0.68 },
});
