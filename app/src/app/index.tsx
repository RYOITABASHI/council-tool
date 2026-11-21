import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FacadeError, facadeErrorMessages, fetchMeetings } from '../api';
import type { FacadeErrorKind } from '../api';
import { formatTime, useTheme } from '../components/styles';
import { loadFixtureMeetings } from '../fixtures';
import { loadSettings } from '../storage';
import type { MeetingState, MeetingSummary } from '../types';

const badges: Record<MeetingState, { label: string; tone: 'accentText' | 'amber' | 'red' | 'blue' | 'violet' }> = {
  APPROVED: { label: '承認済み', tone: 'accentText' },
  AWAITING_APPROVAL: { label: '承認待ち', tone: 'amber' },
  REJECTED: { label: '却下', tone: 'red' },
  OPEN: { label: '進行中', tone: 'blue' },
  CREATED: { label: '進行中', tone: 'blue' },
  GATE: { label: 'ゲート', tone: 'violet' },
  SYNTHESIZING: { label: '統合中', tone: 'blue' },
  BARRIER: { label: 'バリア', tone: 'amber' },
};
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
  return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()}`;
}

type Source = 'facade' | 'fixture';
type SessionList = { source: Source; meetings: MeetingSummary[] };

function SessionRow({ meeting, source }: { meeting: MeetingSummary; source: Source }) {
  const { colors, ui } = useTheme();
  const badge = Object.hasOwn(badges, meeting.meeting_state) ? badges[meeting.meeting_state] : undefined;
  const timestamp = meetingDate(meeting.updated_at || meeting.created_at);
  const avatars = meeting.seat_ids.slice(0, 4);
  const seatPreview = meeting.seat_ids.join('・');
  return (
    <Pressable accessibilityRole="button"
      onPress={() => router.push({ pathname: '/meeting', params: { source, meetingId: meeting.meeting_id } })}
      style={({ pressed }) => [styles.row, {
        backgroundColor: pressed ? colors.pressed : colors.listSurface,
        borderBottomColor: colors.border,
      }]}>
      <View style={styles.avatars} aria-hidden>
        {avatars.map((id, index) => (
          <View key={id} style={[
            styles.avatar,
            avatars.length === 1 ? styles.singleAvatar : {
              left: avatars.length === 3 && index === 2 ? 10 : (index % 2) * 20,
              top: avatars.length === 2 ? 10 : Math.floor(index / 2) * 20,
            },
            { backgroundColor: avatarColor(id), borderColor: colors.listSurface },
          ]}>
            <Text style={[ui.label, { color: colors.avatarInk }, avatars.length > 1 && styles.stackedInitial]}>
              {Array.from(id)[0]?.toUpperCase()}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.details}>
        <View style={styles.heading}>
          <Text numberOfLines={1} style={[ui.body, styles.topic]}>{meeting.topic}</Text>
          {!!timestamp && <Text style={[ui.muted, styles.timestamp]}>{timestamp}</Text>}
        </View>
        <Text numberOfLines={1} style={ui.muted}>
          <Text style={badge && { color: colors[badge.tone] }}>{badge?.label ?? meeting.meeting_state}</Text>
          {seatPreview && `  ${seatPreview}`}
        </Text>
      </View>
    </Pressable>
  );
}

export default function SessionsScreen() {
  const { colors, ui } = useTheme();
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
      <View style={[styles.status, { backgroundColor: colors.listSurface }]}>
        <Text accessibilityLiveRegion="polite" style={[ui.body, styles.error, { color: colors.red }]}>{facadeErrorMessages[error]}</Text>
        <Pressable accessibilityRole="button" style={[ui.button, ui.primary]} onPress={retry}>
          <Text style={ui.primaryText}>再試行</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={ui.button} onPress={() => setUseSamples(true)}>
          <Text style={ui.label}>サンプル会議一覧を見る</Text>
        </Pressable>
      </View>
    );
  }

  if (!list) return <ActivityIndicator color={colors.accent} accessibilityLabel="読み込み中" style={styles.status} />;

  return (
    <FlatList
      style={{ backgroundColor: colors.listSurface }}
      data={list.meetings}
      keyExtractor={item => item.meeting_id}
      renderItem={({ item }) => <SessionRow meeting={item} source={list.source} />}
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
  );
}

const styles = StyleSheet.create({
  list: { width: '100%', maxWidth: 800, alignSelf: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatars: { width: 44, height: 44 },
  avatar: {
    position: 'absolute', width: 24, height: 24, borderRadius: 12, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  singleAvatar: { width: 44, height: 44, borderRadius: 22 },
  stackedInitial: { fontSize: 11 },
  details: { flex: 1 },
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  topic: { flex: 1, fontWeight: '600', lineHeight: 20 },
  timestamp: { fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'], textAlign: 'right' },
  note: { textAlign: 'center', padding: 16 },
  status: { alignItems: 'center', padding: 20, gap: 12 },
  error: { textAlign: 'center' },
});
