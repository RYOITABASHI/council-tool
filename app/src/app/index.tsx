import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View,
} from 'react-native';
import { FacadeError, facadeErrorMessages, fetchMeeting, fetchMeetings } from '../api';
import type { FacadeErrorKind } from '../api';
import { ChatHeader, HeaderIcon } from '../components/ChatHeader';
import { seatColor, seatInitials } from '../components/SeatAvatar';
import { statementLead } from '../components/statementLead';
import { formatTime, lineHeightFor, useTheme } from '../components/styles';
import { loadFixtureMeeting, loadFixtureMeetings } from '../fixtures';
import { loadSettings } from '../storage';
import { isPacketKind } from '../types';
import type { MeetingData, MeetingState, MeetingSummary } from '../types';

type Tone = 'accentText' | 'amber' | 'red' | 'blue' | 'violet';
const badges: Record<MeetingState, { label: string; tone: Tone }> = {
  APPROVED: { label: '承認済み', tone: 'accentText' },
  AWAITING_APPROVAL: { label: '承認待ち', tone: 'amber' },
  REJECTED: { label: '却下', tone: 'red' },
  OPEN: { label: '進行中', tone: 'blue' },
  CREATED: { label: '進行中', tone: 'blue' },
  GATE: { label: 'ゲート', tone: 'violet' },
  SYNTHESIZING: { label: '統合中', tone: 'blue' },
  BARRIER: { label: 'バリア', tone: 'amber' },
};

// Slack-like channel sections: what needs the owner first, then live work, then the archive.
type Group = 'awaiting' | 'active' | 'done';
const groupTitles: Record<Group, string> = { awaiting: '承認待ち', active: '進行中', done: '完了' };
function groupOf(state: MeetingState): Group {
  if (state === 'AWAITING_APPROVAL') return 'awaiting';
  if (state === 'APPROVED' || state === 'REJECTED') return 'done';
  return 'active';
}

function meetingDate(value: string): string {
  const time = formatTime(value);
  if (!time) return '';
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()}`;
}

function timeOf(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

type Preview = { seat?: string; text: string };

/** The latest current statement in a meeting, for the LINE-style second line. */
function latestPreview({ packets }: MeetingData): Preview | undefined {
  let latest: { at: number; preview: Preview } | undefined;
  for (const entry of packets.new_packets) {
    if (entry.packet_state.version !== 'current') continue;
    const { header } = entry.packet;
    let preview: Preview | undefined;
    if (isPacketKind(entry, 'answer') || isPacketKind(entry, 'critique') || isPacketKind(entry, 'flash')) {
      preview = { seat: entry.packet.header.seat_id ?? undefined, text: entry.packet.body.body };
    } else if (isPacketKind(entry, 'note')) {
      preview = { text: entry.packet.body.text };
    } else if (isPacketKind(entry, 'synthesis')) {
      const body = entry.packet.body;
      preview = { seat: '統合結果', text: body.recommendation?.trim() || body.reception_summary };
    }
    if (!preview) continue;
    const at = timeOf(header.created_at);
    if (!latest || at >= latest.at) latest = { at, preview };
  }
  if (!latest) return undefined;
  const text = statementLead(latest.preview.text).text.replace(/\s+/g, ' ').trim();
  return text ? { ...latest.preview, text } : undefined;
}

type Source = 'facade' | 'fixture';
type SessionList = { source: Source; meetings: MeetingSummary[] };
type Previews = Record<string, Preview | undefined>;
type Section = { key: Group; title: string; data: MeetingSummary[] };


function GroupAvatar({ seatIds }: { seatIds: string[] }) {
  const { colors } = useTheme();
  const seats = seatIds.slice(0, 4);
  // LINE renders a member collage inside one circle when a group has no picture.
  const columns = seats.length <= 1 ? [seats] : seats.length === 2 ? [[seats[0]], [seats[1]]]
    : seats.length === 3 ? [[seats[0]], [seats[1], seats[2]]] : [[seats[0], seats[2]], [seats[1], seats[3]]];
  const size = seats.length <= 1 ? 22 : seats.length === 2 ? 17 : 14;
  return (
    <View style={[styles.avatar, { backgroundColor: colors.pale }]} aria-hidden>
      {columns.map((column, x) => (
        <View key={x} style={[styles.avatarColumn, x > 0 && { borderLeftColor: colors.listSurface, borderLeftWidth: 1 }]}>
          {column.map((id, y) => {
            const initials = seatInitials(id);
            // Two-character initials (codex-a → Ca) get a smaller face so they fit a quarter cell.
            const fontSize = Array.from(initials).length > 1 ? Math.round(size * 0.8) : size;
            return (
              <View key={id} style={[styles.avatarCell, { backgroundColor: seatColor(id) },
                y > 0 && { borderTopColor: colors.listSurface, borderTopWidth: 1 }]}>
                <Text numberOfLines={1} style={[styles.avatarInitial, { color: colors.avatarInk, fontSize }]}>
                  {initials}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function StatePill({ state }: { state: MeetingState }) {
  const { colors } = useTheme();
  const badge = Object.hasOwn(badges, state) ? badges[state] : undefined;
  const background = badge?.tone === 'amber' ? colors.amberBackground
    : badge?.tone === 'red' ? colors.redBackground : colors.pale;
  return (
    <Text numberOfLines={1}
      style={[styles.pill, { backgroundColor: background, color: badge ? colors[badge.tone] : colors.muted }]}>
      {badge?.label ?? state}
    </Text>
  );
}

function SessionRow({ meeting, source, preview }: { meeting: MeetingSummary; source: Source; preview?: Preview }) {
  const { colors, ui } = useTheme();
  const timestamp = meetingDate(meeting.updated_at || meeting.created_at);
  const seatPreview = meeting.seat_ids.join('・');
  return (
    <Pressable accessibilityRole="button"
      onPress={() => router.push({ pathname: '/meeting', params: { source, meetingId: meeting.meeting_id } })}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : colors.listSurface }]}>
      <GroupAvatar seatIds={meeting.seat_ids} />
      <View style={styles.details}>
        {/* Title (with its seat count) and preview fill the row and end in "…" when too long. */}
        <Text numberOfLines={1} style={[ui.body, styles.topic]}>
          {meeting.topic}
          {meeting.seat_ids.length > 1 && <Text>{` (${meeting.seat_ids.length})`}</Text>}
        </Text>
        <Text numberOfLines={1} style={[ui.muted, styles.preview]}>
          {preview ? `${preview.seat ? `${preview.seat}：` : ''}${preview.text}` : seatPreview}
        </Text>
      </View>
      {/* Time over state, LINE-style. The column is as wide as its wider item and the time stretches
          across it, so the time is never boxed to its exact measured width. */}
      <View style={styles.side}>
        {!!timestamp && <Text numberOfLines={1} style={[ui.muted, styles.timestamp]}>{timestamp}</Text>}
        <StatePill state={meeting.meeting_state} />
      </View>
    </Pressable>
  );
}

function sectionsOf(meetings: MeetingSummary[]): Section[] {
  const sorted = [...meetings].sort((a, b) =>
    timeOf(b.updated_at || b.created_at) - timeOf(a.updated_at || a.created_at));
  return (['awaiting', 'active', 'done'] as const)
    .map(key => ({ key, title: groupTitles[key], data: sorted.filter(item => groupOf(item.meeting_state) === key) }))
    .filter(section => section.data.length > 0);
}

export default function SessionsScreen() {
  const { colors, ui } = useTheme();
  const [list, setList] = useState<SessionList>();
  const [previews, setPreviews] = useState<Previews>({});
  const [error, setError] = useState<FacadeErrorKind>();
  const [loading, setLoading] = useState(true);
  const [useSamples, setUseSamples] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useFocusEffect(useCallback(() => {
    let focused = true;
    setLoading(true);
    setError(undefined);

    async function load() {
      try {
        const { facadeUrl, token } = await loadSettings();
        if (!focused) return;
        const source = !useSamples && facadeUrl.trim() ? 'facade' : 'fixture';
        const meetings = source === 'facade'
          ? await fetchMeetings(facadeUrl, token)
          : loadFixtureMeetings();
        if (!focused) return;
        setList({ source, meetings });
        if (source === 'fixture') {
          const next: Previews = {};
          for (const { meeting_id: id } of meetings) {
            const data = loadFixtureMeeting(id);
            next[id] = data ? latestPreview(data) : undefined;
          }
          setPreviews(next);
        } else {
          // Best-effort previews from the existing meeting read; on failure the
          // row falls back to its seat list (any stale preview is cleared).
          for (const { meeting_id: id } of meetings) {
            void fetchMeeting(facadeUrl, token, id).then(data => {
              if (focused) setPreviews(current => ({ ...current, [id]: latestPreview(data) }));
            }, () => {
              if (focused) setPreviews(current => ({ ...current, [id]: undefined }));
            });
          }
        }
      } catch (cause) {
        if (focused) {
          setList(undefined);
          setError(cause instanceof FacadeError ? cause.kind : 'http');
        }
      } finally {
        if (focused) setLoading(false);
      }
    }

    void load();
    return () => { focused = false; };
  }, [attempt, useSamples]));

  function retry() {
    setAttempt(value => value + 1);
  }

  const header = (
    <ChatHeader title="セッション" large backgroundColor={colors.listSurface}>
      <HeaderIcon glyph="＋" label="新規セッション" onPress={() => router.push('/compose')} />
      <HeaderIcon glyph="⚙" label="設定" onPress={() => router.push('/settings')} />
    </ChatHeader>
  );

  if (error) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.listSurface }]}>
        {header}
        <View style={styles.status}>
          <Text accessibilityLiveRegion="polite" style={[ui.body, styles.error, { color: colors.red }]}>{facadeErrorMessages[error]}</Text>
          <Pressable accessibilityRole="button" style={[ui.button, ui.primary]} onPress={retry}>
            <Text style={[ui.primaryText, ui.buttonText]}>再試行</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={ui.button} onPress={() => setUseSamples(true)}>
            <Text style={[ui.label, ui.buttonText]}>サンプル会議一覧を見る</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.listSurface }]}>
      {header}
      {!list ? <ActivityIndicator color={colors.accent} accessibilityLabel="読み込み中" style={styles.status} /> : (
        <SectionList
          style={{ backgroundColor: colors.listSurface }}
          sections={sectionsOf(list.meetings)}
          keyExtractor={item => item.meeting_id}
          renderItem={({ item }) => <SessionRow meeting={item} source={list.source} preview={previews[item.meeting_id]} />}
          renderSectionHeader={({ section }) => (
            <Text accessibilityRole="header" style={[ui.muted, styles.sectionTitle, { backgroundColor: colors.listSurface }]}>
              {section.title}  {section.data.length}
            </Text>
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={list.source === 'facade' && loading}
              onRefresh={() => { if (list.source === 'facade' && !loading) retry(); }}
              colors={[colors.accentText]} tintColor={colors.accentText} progressBackgroundColor={colors.surface}
            />
          }
          ListEmptyComponent={<Text style={[ui.muted, styles.note]}>セッションがありません</Text>}
          ListFooterComponent={<Text style={[ui.muted, styles.note]}>会議IDで直接開く場合は設定画面から。</Text>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '600', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 15, paddingVertical: 13, paddingHorizontal: 18 },
  avatar: { width: 52, height: 52, borderRadius: 26, overflow: 'hidden', flexDirection: 'row' },
  avatarColumn: { flex: 1 },
  avatarCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Stretches across its cell, so the initials are never boxed to their exact measured width.
  avatarInitial: { alignSelf: 'stretch', textAlign: 'center', fontWeight: '800', includeFontPadding: false },
  details: { flex: 1, minWidth: 0, gap: 3 },
  side: { flexShrink: 0, alignItems: 'stretch', gap: 5 },
  topic: { fontSize: 16, fontWeight: '600', lineHeight: lineHeightFor(16) },
  timestamp: { fontSize: 11.5, lineHeight: lineHeightFor(11.5), fontVariant: ['tabular-nums'], textAlign: 'right' },
  preview: { fontSize: 13.5, lineHeight: lineHeightFor(13.5) },
  pill: {
    textAlign: 'center',
    overflow: 'hidden', borderRadius: 10, fontSize: 10.5, lineHeight: lineHeightFor(10.5), fontWeight: '600',
    paddingHorizontal: 7, paddingVertical: 2,
  },
  note: { textAlign: 'center', padding: 16 },
  status: { alignItems: 'center', padding: 20, gap: 12 },
  error: { textAlign: 'center' },
});
