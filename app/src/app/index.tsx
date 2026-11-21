import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { FacadeError, facadeErrorMessages, fetchMeetings } from '../api';
import type { FacadeErrorKind } from '../api';
import { colors, formatTime, ui } from '../components/styles';
import { loadFixtureMeetings } from '../fixtures';
import { loadSettings } from '../storage';
import type { MeetingState, MeetingSummary } from '../types';

const badges: Record<MeetingState, { label: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'violet' }> = {
  APPROVED: { label: '承認済み', tone: 'green' },
  AWAITING_APPROVAL: { label: '承認待ち', tone: 'amber' },
  REJECTED: { label: '却下', tone: 'red' },
  OPEN: { label: '進行中', tone: 'blue' },
  CREATED: { label: '進行中', tone: 'blue' },
  GATE: { label: 'ゲート', tone: 'violet' },
  SYNTHESIZING: { label: '統合中', tone: 'blue' },
  BARRIER: { label: 'バリア', tone: 'amber' },
};
const tones = StyleSheet.create({
  green: { backgroundColor: colors.pale, color: colors.teal },
  amber: ui.warning,
  red: ui.danger,
  blue: { backgroundColor: '#E3EFFD', color: '#21538A' },
  violet: { backgroundColor: '#EFE8F9', color: '#654386' },
});
const avatarColors = ['#D2EDE2', '#F6DECE', '#E7DEF8', '#DCEAFB', '#F6E3F0', '#F8ECC9'];

function avatarColor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return avatarColors[hash % avatarColors.length];
}

function meetingDate(value: string): string {
  const time = formatTime(value);
  if (!time) return '';
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

type Source = 'facade' | 'fixture';
type SessionList = { source: Source; meetings: MeetingSummary[] };

function SessionRow({ meeting, source }: { meeting: MeetingSummary; source: Source }) {
  const badge = Object.hasOwn(badges, meeting.meeting_state) ? badges[meeting.meeting_state] : undefined;
  const timestamp = meetingDate(meeting.updated_at || meeting.created_at);
  return (
    <Pressable accessibilityRole="button"
      onPress={() => router.push({ pathname: '/meeting', params: { source, meetingId: meeting.meeting_id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.avatars} aria-hidden>
        {meeting.seat_ids.slice(0, 4).map((id, index) => (
          <View key={id} style={[styles.avatar, index > 0 && styles.overlap, { backgroundColor: avatarColor(id) }]}>
            <Text style={ui.label}>{Array.from(id)[0]?.toUpperCase()}</Text>
          </View>
        ))}
      </View>
      <View style={styles.details}>
        <Text numberOfLines={2} style={styles.topic}>{meeting.topic}</Text>
        <View style={styles.metadata}>
          <Text style={[ui.chip, badge && tones[badge.tone]]}>{badge?.label ?? meeting.meeting_state}</Text>
          {!!timestamp && <Text style={ui.muted}>{timestamp}</Text>}
        </View>
      </View>
      <Text aria-hidden style={styles.chevron}>›</Text>
    </Pressable>
  );
}

export default function SessionsScreen() {
  const [list, setList] = useState<SessionList>();
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
        if (focused) setList({ source, meetings });
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

  if (error) {
    return (
      <View style={styles.status}>
        <Text accessibilityLiveRegion="polite" style={styles.error}>{facadeErrorMessages[error]}</Text>
        <Pressable accessibilityRole="button" style={[ui.button, ui.primary]} onPress={retry}>
          <Text style={ui.primaryText}>再試行</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={ui.button} onPress={() => setUseSamples(true)}>
          <Text style={ui.label}>サンプル会議一覧を見る</Text>
        </Pressable>
      </View>
    );
  }

  if (!list) return <ActivityIndicator color={colors.teal} accessibilityLabel="読み込み中" style={styles.status} />;

  return (
    <FlatList
      data={list.meetings}
      keyExtractor={item => item.meeting_id}
      renderItem={({ item }) => <SessionRow meeting={item} source={list.source} />}
      contentContainerStyle={styles.list}
      refreshing={list.source === 'facade' && loading}
      onRefresh={() => { if (list.source === 'facade' && !loading) retry(); }}
      ListEmptyComponent={<Text style={styles.note}>セッションがありません</Text>}
      ListFooterComponent={<Text style={styles.note}>会議IDで直接開く場合は設定画面から。</Text>}
    />
  );
}

const styles = StyleSheet.create({
  list: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingVertical: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 12,
    backgroundColor: colors.white, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  pressed: { backgroundColor: colors.pale },
  avatars: { width: 81, flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: colors.white,
    alignItems: 'center', justifyContent: 'center',
  },
  overlap: { marginLeft: -13 },
  details: { flex: 1, gap: 6 },
  topic: { ...ui.body, fontWeight: '600' },
  metadata: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chevron: { color: colors.muted, fontSize: 23 },
  note: { ...ui.muted, textAlign: 'center', padding: 16 },
  status: { alignItems: 'center', padding: 20, gap: 12 },
  error: { ...ui.body, color: colors.red, textAlign: 'center' },
});
