import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeFacadeError, FacadeError, fetchMeeting } from '../api';
import { reasonLabel, receptionLabels } from '../components/RoundHeader';
import { SeatAvatar } from '../components/SeatAvatar';
import { formatTime, useTheme } from '../components/styles';
import { loadFixtureMeeting } from '../fixtures';
import { receptionRowsForRound, supersededInfo } from '../model';
import { loadSettings } from '../storage';
import { isPacketKind } from '../types';
import type { MeetingData, MissingRecord, PacketBodies, PacketEntry, PacketKind, Round } from '../types';

const kindLabels: Record<PacketKind, string> = {
  agenda: 'アジェンダ', answer: '回答', critique: '批評', flash: '速報', note: 'メモ',
  gate_decision: 'ゲート判定', attest: '照合', synthesis: '統合結果',
};

const missingLabels: Record<MissingRecord, string> = {
  claims: '主張', statement: '主張文', reversal_condition: '判断が変わる条件',
};

function DetailSection({ label, items }: { label: string; items: string[] }) {
  const { ui } = useTheme();
  if (!items.length) return null;
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={ui.label}>{label}</Text>
      {items.map((item, index) => <Text selectable key={index} style={ui.body}>{item}</Text>)}
    </View>
  );
}

function SynthesisLog({ body }: { body: PacketBodies['synthesis'] }) {
  return (
    <>
      <DetailSection label="推奨" items={body.recommendation ? [body.recommendation] : []} />
      <DetailSection label="受理の概要" items={body.reception_summary ? [body.reception_summary] : []} />
      <DetailSection label="合意点" items={body.agreements} />
      <DetailSection label="少数意見" items={body.minority_opinions.map(item => `${item.seat_id}：${item.opinion}`)} />
      <DetailSection label="未検証" items={(body.unverified_items ?? []).map(item =>
        typeof item === 'string' ? item : JSON.stringify(item),
      )} />
      <DetailSection label="申告された不足" items={body.declared_missing_records.map(
        item => `${item.seat_id}：${item.note}（${item.packet_id}）`,
      )} />
      <DetailSection label="判断が変わる条件" items={body.reversal_conditions.map(
        item => `${item.claim} → ${item.condition}（${item.source_seat}）`,
      )} />
      <DetailSection label="引用資料" items={body.cited_materials.map(item => item.material_ref)} />
    </>
  );
}

function PacketLog({ data, entry }: { data: MeetingData; entry: PacketEntry }) {
  const { colors, ui } = useTheme();
  const { packet, packet_state: status, missing_records: missing } = entry;
  const { round, kind, created_at, packet_id, packet_sha } = packet.header;
  const seat = packet.header.seat_id ?? (kind === 'synthesis' ? '議長' : 'システム');
  const { supersededBy, supersededIds } = supersededInfo(data.packets);
  const predecessor = packet.header.supersedes ?? data.packets.superseded.find(
    pair => pair.new_packet_id === packet_id,
  )?.old_packet_id;
  const successor = supersededBy.get(packet_id);
  const receptionRound = round ?? data.state.reception_table.reduce<Round | undefined>((latest, row) =>
    !latest || Number(row.round.slice(1)) > Number(latest.slice(1)) ? row.round : latest, undefined);
  const rows = receptionRound ? receptionRowsForRound(data.state, receptionRound) : [];
  const body = packet.body;
  const statement = 'text' in body ? body.text : 'body' in body ? body.body : '';
  const claims = ('claims' in body ? body.claims : undefined)?.filter(
    claim => claim.statement?.trim() || claim.reversal_condition?.trim(),
  );
  const unverified = status.verification === 'unverified' || status.reception === 'transcribed_pending_attest';
  const showVerification = status.verification === 'verified' || unverified ||
    status.reception === 'invalidated' || missing.length > 0;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.log}>
        <View style={styles.seatRow}>
          <SeatAvatar seat={seat} />
          <View style={styles.seatInfo}>
            <Text style={ui.title}>{seat}</Text>
            <Text style={ui.muted}>{[round, kindLabels[kind], formatTime(created_at)].filter(Boolean).join(' ・ ')}</Text>
          </View>
        </View>
        {rows.length > 0 && (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={ui.label}>受理状況{!round && `（${receptionRound}）`}</Text>
            {rows.map(row => (
              <View key={row.seat_id} style={[styles.receptionRow, { borderBottomColor: colors.border }]}>
                <Text style={[ui.body, styles.seatInfo]}>{row.seat_id}</Text>
                <Text numberOfLines={1} style={ui.chip}>{receptionLabels[row.state]}</Text>
                {!!row.reason?.code && <Text style={ui.muted}>{reasonLabel(row.reason.code)}</Text>}
              </View>
            ))}
          </View>
        )}
        {isPacketKind(entry, 'synthesis') ? <SynthesisLog body={entry.packet.body} /> : (
          <>
            {!!statement && <Text selectable style={[ui.body, styles.statement]}>{statement}</Text>}
            {'basis' in body && !!body.basis && <DetailSection label="根拠" items={[body.basis]} />}
            {!!claims?.length && (
              <View style={styles.section}>
                <Text accessibilityRole="header" style={ui.label}>主張</Text>
                {claims.map((claim, index) => (
                  <View key={index} style={[styles.claim, { borderLeftColor: colors.border }]}>
                    {!!claim.statement?.trim() && <Text selectable style={ui.body}>{claim.statement}</Text>}
                    {!!claim.reversal_condition?.trim() &&
                      <Text selectable style={ui.muted}>判断が変わる条件：{claim.reversal_condition}</Text>}
                  </View>
                ))}
              </View>
            )}
          </>
        )}
        {showVerification && (
          <View style={ui.wrap}>
            {status.verification === 'verified' && <Text style={ui.chip}>照合済み</Text>}
            {unverified && <Text style={[ui.chip, ui.warning]}>未検証</Text>}
            {status.reception === 'invalidated' && <Text style={[ui.chip, ui.danger]}>無効化</Text>}
            {missing.length > 0 && (
              <Text style={[ui.chip, ui.warning]}>不足：{missing.map(item => missingLabels[item]).join(' / ')}</Text>
            )}
          </View>
        )}
        {!isPacketKind(entry, 'synthesis') && (
          <DetailSection label="申告された不足" items={entry.declared_missing_records.map(
            item => `${item.seat_id}：${item.note}（${item.packet_id}）`,
          )} />
        )}
        <View style={[styles.section, styles.metadata, { borderTopColor: colors.border }]}>
          <Text selectable style={ui.muted}>packet_id：{packet_id}</Text>
          <Text selectable style={ui.muted}>packet_sha：{packet_sha}</Text>
          {!!predecessor && <Text selectable style={ui.muted}>差し替え元：{predecessor}</Text>}
          {supersededIds.has(packet_id) && (
            <Text selectable style={ui.muted}>差し替え済み{successor ? `：${successor}` : ''}</Text>
          )}
        </View>
      </SafeAreaView>
    </ScrollView>
  );
}

type PacketParams = { meetingId?: string; packetId?: string; source?: string };

function PacketView({ meetingId, packetId, source }: PacketParams) {
  const { colors, ui } = useTheme();
  const [result, setResult] = useState<{ data: MeetingData; entry: PacketEntry } | { error: string }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        if (!meetingId || !packetId) throw new FacadeError('not_found');
        let data: MeetingData | null;
        if (source === 'fixture') {
          data = loadFixtureMeeting(meetingId);
        } else {
          const { facadeUrl, token } = await loadSettings();
          if (!facadeUrl.trim()) throw new FacadeError('unreachable');
          data = await fetchMeeting(facadeUrl, token, meetingId);
        }

        const entry = data?.packets.new_packets.find(item => item.packet.header.packet_id === packetId);
        if (!data || !entry) throw new FacadeError('not_found');
        if (active) setResult({ data, entry });
      } catch (cause) {
        const message = cause instanceof FacadeError && cause.kind === 'not_found'
          ? '発言が見つかりません' : describeFacadeError(cause);
        if (active) setResult({ error: message });
      }
    }

    void load();
    return () => { active = false; };
  }, [meetingId, packetId, source, attempt]);

  if (!result) return <ActivityIndicator color={colors.accent} style={styles.feedback} accessibilityLabel="読み込み中" />;
  if ('error' in result) {
    return (
      <View style={styles.feedback}>
        <Text accessibilityLiveRegion="polite" style={[ui.body, { color: colors.red }]}>{result.error}</Text>
        <Pressable accessibilityRole="button" style={ui.button} onPress={() => {
          setResult(undefined);
          setAttempt(value => value + 1);
        }}>
          <Text style={[ui.label, ui.buttonText]}>再試行</Text>
        </Pressable>
      </View>
    );
  }
  return <PacketLog {...result} />;
}

export default function PacketScreen() {
  const { meetingId, packetId, source } = useLocalSearchParams<PacketParams>();
  return <PacketView key={JSON.stringify([source, meetingId, packetId])}
    meetingId={meetingId} packetId={packetId} source={source} />;
}

const styles = StyleSheet.create({
  scroll: { alignItems: 'center' },
  log: { width: '100%', maxWidth: 680, paddingHorizontal: 16, paddingVertical: 20, gap: 20 },
  seatRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  seatInfo: { flex: 1 },
  section: { gap: 8 },
  receptionRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8,
    paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statement: { fontSize: 16, lineHeight: 25 },
  claim: { borderLeftWidth: 2, paddingLeft: 8, gap: 4 },
  metadata: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  feedback: { alignItems: 'center', padding: 20, gap: 12 },
});
