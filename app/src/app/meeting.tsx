import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl,
  ScrollView, SectionList, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeFacadeError, FacadeError, fetchMeeting, fetchRunner, postApprove, postMention } from '../api';
import { AttestRow } from '../components/AttestRow';
import { GateCard } from '../components/GateCard';
import { PacketBubble } from '../components/PacketBubble';
import { RoundHeader } from '../components/RoundHeader';
import { StateBanner } from '../components/StateBanner';
import { SynthesisCard } from '../components/SynthesisCard';
import { useTheme } from '../components/styles';
import { loadFixtureMeeting } from '../fixtures';
import { buildTimeline, receptionRowsForRound, supersededInfo, topicOf } from '../model';
import type { TimelineItem } from '../model';
import { loadSettings, saveSettings } from '../storage';
import type { DisplayStyle } from '../storage';
import type { ApproveDecision, MeetingData, Round, RoundState, RunnerState } from '../types';

const approvalLabels: Record<ApproveDecision, string> = { approve: '承認する', reject: '却下する' };

type Connection = { facadeUrl: string; token: string; id: string };
type LoadedMeeting = { data: MeetingData; runner?: RunnerState; connection?: Connection };
type RefreshRequest = { silent: boolean; done: Promise<void> };

type ListItem = Exclude<TimelineItem, { type: 'synthesis' }>;
type RoundItem = Extract<ListItem, { type: 'roundHeader' }>;
type MeetingSection = {
  key: string;
  header?: RoundItem;
  title?: string;
  data: ListItem[];
};

function makeSections(items: ListItem[]): MeetingSection[] {
  const prelude: MeetingSection = { key: 'prelude', data: [] };
  const sections = [prelude];
  let section = prelude;

  for (const item of items) {
    if (item.type === 'roundHeader') {
      section = { key: item.round, header: item, data: [] };
      sections.push(section);
    } else if (item.type === 'agenda') {
      prelude.title = 'アジェンダ';
      prelude.data.push(item);
    } else if (item.type !== 'timeout') {
      section.data.push(item);
    }
  }

  return sections.filter(section => section.header || section.data.length > 0);
}

function itemKey(item: ListItem): string {
  if (item.type === 'roundHeader') return item.round;
  if (item.type === 'timeout') return item.type;
  return item.entry.packet.header.packet_id;
}

function TimeoutNotice() {
  const { ui } = useTheme();
  return <Text style={[ui.chip, ui.warning, styles.message]}>会議が制限時間を超過しました</Text>;
}

function MeetingContent({ data, displayStyle, refreshing, refresh }: {
  data: MeetingData; displayStyle: DisplayStyle; refreshing: boolean; refresh: () => void;
}) {
  const { colors, ui } = useTheme();
  const { state, packets } = data;
  const { items, synthesis, sections, versions } = useMemo(() => {
    const timeline = buildTimeline(state, packets);
    const items = timeline.filter(item => item.type !== 'synthesis');
    return {
      items,
      synthesis: timeline.find(item => item.type === 'synthesis'),
      sections: makeSections(items),
      versions: supersededInfo(packets),
    };
  }, [state, packets]);

  function roundHeader(round: Round, phase: RoundState['phase']) {
    return <RoundHeader round={round} phase={phase} rows={receptionRowsForRound(state, round)} />;
  }

  function renderItem({ item }: { item: ListItem }) {
    switch (item.type) {
      case 'agenda':
        return (
          <View style={[ui.card, ui.systemCard, styles.agenda, { backgroundColor: colors.system }]}>
            {displayStyle === 'line' && (
              <Text accessibilityRole="header" style={[ui.label, styles.agendaLabel]}>アジェンダ</Text>
            )}
            <Text selectable style={[ui.body, styles.agendaTopic]}>{item.entry.packet.body.topic}</Text>
            {item.entry.packet.body.shared_materials.map((material, index) => (
              <Text selectable key={index} style={ui.muted}>{material}</Text>
            ))}
          </View>
        );
      case 'roundHeader': return roundHeader(item.round, item.phase);
      case 'attest': return <AttestRow entry={item.entry} />;
      case 'gate': return <GateCard entry={item.entry} />;
      case 'timeout': return <TimeoutNotice />;
      case 'packet': {
        const id = item.entry.packet.header.packet_id;
        return (
          <PacketBubble entry={item.entry}
            splitParagraphs={displayStyle === 'line'}
            isSuperseded={versions.supersededIds.has(id)}
            supersededBy={versions.supersededBy.get(id)}
          />
        );
      }
    }
  }

  const footer = (
    <View style={styles.footer}>
      {displayStyle === 'slack' && state.timeout_exceeded && <TimeoutNotice />}
      {synthesis && <SynthesisCard entry={synthesis.entry} />}
    </View>
  );
  const listProps = {
    contentContainerStyle: styles.list,
    keyboardShouldPersistTaps: 'handled' as const,
    keyExtractor: itemKey,
    renderItem,
    refreshControl: (
      <RefreshControl refreshing={refreshing} onRefresh={refresh}
        colors={[colors.accentText]} tintColor={colors.accentText} progressBackgroundColor={colors.surface} />
    ),
    ListHeaderComponent: packets.new_packets.length === 0
      ? <Text style={[ui.muted, styles.message]}>まだ発言がありません</Text>
      : undefined,
    ListFooterComponent: footer,
    ItemSeparatorComponent: ItemSeparator,
  };

  return displayStyle === 'line' ? <FlatList {...listProps} data={items} /> : (
    <SectionList<ListItem, MeetingSection>
      {...listProps}
      sections={sections}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => section.header
        ? roundHeader(section.header.round, section.header.phase)
        : section.title ? <Text accessibilityRole="header" style={[ui.label, styles.agendaLabel]}>{section.title}</Text>
          : null}
    />
  );
}

function ItemSeparator() {
  return <View style={styles.separator} />;
}

function RunnerIndicator({ runner }: { runner?: RunnerState }) {
  const { colors, ui } = useTheme();
  if (runner?.phase !== 'running' && runner?.phase !== 'error') return null;
  return (
    <View style={styles.runner} accessibilityLiveRegion="polite">
      <Text style={[
        ui.muted,
        runner.phase === 'error' && { color: colors.red },
      ]}>{runner.phase === 'error' ? 'エラー' : '実行中'}</Text>
      {runner.phase === 'error' && runner.detail !== null && <Text style={ui.muted}>{runner.detail}</Text>}
    </View>
  );
}

function MeetingView({ fixture, meetingId }: { fixture: boolean; meetingId?: string }) {
  const { colors, ui } = useTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [meeting, setMeeting] = useState<LoadedMeeting>();
  const [displayStyle, setDisplayStyle] = useState<DisplayStyle>('line');
  const [connectionConfigured, setConnectionConfigured] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const [addressee, setAddressee] = useState<string>();
  const [text, setText] = useState('');
  const active = useRef(false);
  const inFlight = useRef<RefreshRequest | null>(null);
  const writing = useRef(false);
  const firstFocus = useRef(true);
  const saveAttempt = useRef(0);
  const focused = useIsFocused();

  const { data, runner, connection } = meeting ?? {};
  const state = data?.state;
  const phase = state?.meeting_state;
  const terminal = phase === 'APPROVED' || phase === 'REJECTED';
  const canPoll = !fixture && !!state && !terminal;
  const canApprove = !!connection && phase === 'AWAITING_APPROVAL';
  const canMention = !!connection && !!state && !terminal &&
    phase !== 'CREATED' && phase !== 'OPEN' &&
    !state.round_states.some(round => round.phase === 'open') &&
    (runner?.phase === 'idle' || runner?.phase === 'done' || runner?.phase === 'error' ||
      runner?.phase === 'awaiting_approval');
  const seatId = state?.seats.some(seat => seat.seat_id === addressee) ? addressee : undefined;

  const refresh = useCallback((silent = false) => {
    const pending = inFlight.current;
    if (writing.current || (pending && (silent || !pending.silent))) return;
    if (!silent) {
      setLoading(true);
      setError(undefined);
    }
    if (pending) {
      pending.silent = false;
      return;
    }

    async function load() {
      try {
        let result: LoadedMeeting;
        if (fixture) {
          const sample = meetingId ? loadFixtureMeeting(meetingId) : null;
          if (!sample) throw new FacadeError('not_found');
          result = { data: sample };
        } else {
          const { facadeUrl, token, meetingId: savedId } = await loadSettings();
          if (inFlight.current === request) setConnectionConfigured(!!facadeUrl.trim());
          if (!facadeUrl.trim()) throw new FacadeError('unreachable');
          const id = meetingId ?? savedId;
          if (!id) throw new FacadeError('not_found');
          const [remote, runnerResult] = await Promise.allSettled([
            fetchMeeting(facadeUrl, token, id),
            fetchRunner(facadeUrl, token, id),
          ]);
          if (remote.status === 'rejected') {
            if (runnerResult.status === 'rejected' && inFlight.current === request && !writing.current) {
              setMeeting(current => current?.runner ? { ...current, runner: undefined } : current);
            }
            throw remote.reason;
          }
          result = {
            data: remote.value,
            runner: runnerResult.status === 'fulfilled' ? runnerResult.value : undefined,
            connection: { facadeUrl, token, id },
          };
        }
        if (inFlight.current === request && !writing.current) {
          setMeeting(result);
          setError(undefined);
        }
      } catch (cause) {
        if (inFlight.current !== request || writing.current || request.silent) return;
        if (cause instanceof FacadeError && (cause.kind === 'unauthorized' || cause.kind === 'not_found')) {
          setMeeting(undefined);
        }
        setError(fixture && !(cause instanceof FacadeError)
          ? 'サンプル会議の読み込みに失敗しました'
          : describeFacadeError(cause));
      }
    }

    const request: RefreshRequest = {
      silent,
      done: Promise.resolve().then(load).finally(() => {
        if (inFlight.current === request) {
          inFlight.current = null;
          if (!request.silent) setLoading(false);
        }
      }),
    };
    inFlight.current = request;
  }, [fixture, meetingId]);

  useEffect(() => {
    active.current = true;
    refresh();
    return () => {
      active.current = false;
      firstFocus.current = true;
      inFlight.current = null;
    };
  }, [refresh]);

  useFocusEffect(useCallback(() => {
    let current = true;
    void loadSettings().then(settings => {
      if (current) {
        setConnectionConfigured(!!settings.facadeUrl.trim());
        setDisplayStyle(settings.displayStyle);
        setSettingsReady(true);
      }
    });
    if (!firstFocus.current && !fixture && !terminal) refresh(true);
    firstFocus.current = false;
    return () => { current = false; };
  }, [fixture, refresh, terminal]));

  useEffect(() => {
    if (!focused || !canPoll) return;
    const timer = setInterval(() => refresh(true), 5_000);
    return () => clearInterval(timer);
  }, [canPoll, focused, refresh]);

  async function write(action: (target: Connection) => Promise<void>) {
    if (!connection || writing.current || !active.current) return;
    writing.current = true;
    setWriteBusy(true);
    setWriteError(undefined);
    let refreshAfterWrite = false;
    try {
      const settings = await loadSettings();
      if (!active.current) return;
      if (settings.facadeUrl !== connection.facadeUrl || settings.token !== connection.token ||
          (meetingId ?? settings.meetingId) !== connection.id) {
        setWriteError('接続設定が変更されました。会議を更新してください');
      } else {
        await action(connection);
      }
      refreshAfterWrite = true;
      // Let any older read finish before starting the post-write refresh.
      await inFlight.current?.done;
    } catch (cause) {
      if (active.current) setWriteError(describeFacadeError(cause));
    } finally {
      writing.current = false;
      if (active.current) {
        setWriteBusy(false);
        if (refreshAfterWrite) refresh(true);
      }
    }
  }

  function confirmApproval(decision: ApproveDecision) {
    const label = approvalLabels[decision];
    Alert.alert(label, decision === 'approve' ? 'この会議を承認しますか？' : 'この会議を却下しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: label,
        style: decision === 'reject' ? 'destructive' : 'default',
        onPress: () => void write(async ({ facadeUrl, token, id }) => {
          const nextState = await postApprove(facadeUrl, token, id, decision);
          if (active.current) setMeeting(current => current && {
            ...current, runner: undefined, data: { ...current.data, state: nextState },
          });
        }),
      },
    ], { cancelable: true });
  }

  const canSend = canMention && seatId !== undefined && !!text.trim() && !writeBusy;
  function sendMention() {
    if (!canSend || seatId === undefined) return;
    void write(async ({ facadeUrl, token, id }) => {
      const nextRunner = await postMention(facadeUrl, token, id, { seat_id: seatId, text: text.trim() });
      if (active.current) {
        setMeeting(current => current && { ...current, runner: nextRunner });
        setText('');
        setAddressee(undefined);
      }
    });
  }

  function chooseStyle(value: DisplayStyle) {
    setDisplayStyle(value);
    setSaveFailed(false);
    const attempt = ++saveAttempt.current;
    void saveSettings({ displayStyle: value }).catch(() => {
      if (active.current && saveAttempt.current === attempt) setSaveFailed(true);
    });
  }

  const nextStyle = displayStyle === 'line' ? 'slack' : 'line';
  const refreshDisabled = loading || writeBusy;
  const postingReason = fixture ? 'サンプル会議のため投稿できません'
    : terminal ? 'この会議は終了しています'
    : !connectionConfigured ? '設定で接続すると投稿できます'
    : '会議の進行中は投稿できません';
  const update = () => refresh();
  const errorStyle = [ui.body, styles.error, { color: colors.red }];
  const writeFeedback = writeError && <Text accessibilityLiveRegion="polite" style={errorStyle}>{writeError}</Text>;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={!fixture && Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{
        title: (data && topicOf(data.packets)) || '会議',
        headerTitleStyle: { fontSize: 16 },
        headerRight: () => (
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button"
              accessibilityLabel={nextStyle === 'line' ? 'ライン風に切り替え' : 'スレッド風に切り替え'}
              disabled={!settingsReady} accessibilityState={{ disabled: !settingsReady }}
              onPress={() => chooseStyle(nextStyle)} style={[styles.headerButton, !settingsReady && ui.disabled]}>
              <Text style={[styles.headerIcon, { color: colors.ink }]}>⇄</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="更新"
              disabled={refreshDisabled} accessibilityState={{ disabled: refreshDisabled }}
              onPress={update} style={[styles.headerButton, refreshDisabled && ui.disabled]}>
              <Text style={[styles.headerIcon, { color: colors.ink }]}>↻</Text>
            </Pressable>
          </View>
        ),
      }} />
      {(data || saveFailed) && (
        <View style={[styles.header, { backgroundColor: colors.header, borderBottomColor: colors.border }]}>
          {data && (
            <>
              <StateBanner state={data.state.meeting_state} canApprove={canApprove} />
              {(runner?.phase === 'error' || (runner?.phase === 'running' && phase !== 'OPEN')) &&
                <RunnerIndicator runner={runner} />}
            </>
          )}
          {canApprove && (
            <View style={styles.controls}>
              <Pressable accessibilityRole="button" disabled={writeBusy} onPress={() => confirmApproval('approve')}
                style={[ui.button, ui.primary, writeBusy && ui.disabled]}>
                <Text style={ui.primaryText}>{approvalLabels.approve}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={writeBusy} onPress={() => confirmApproval('reject')}
                style={[ui.button, { backgroundColor: colors.redBackground }, writeBusy && ui.disabled]}>
                <Text style={[ui.label, { color: colors.red }]}>{approvalLabels.reject}</Text>
              </Pressable>
            </View>
          )}
          {saveFailed && <Text accessibilityLiveRegion="polite" style={ui.muted}>表示設定を保存できませんでした</Text>}
        </View>
      )}
      {error && (
        <View style={styles.status}>
          <Text accessibilityLiveRegion="polite" style={errorStyle}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={update} style={ui.button}>
            <Text style={ui.label}>再試行</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.screen}>
        {data ? <MeetingContent data={data} displayStyle={displayStyle} refreshing={loading} refresh={update} />
          : loading && <ActivityIndicator style={styles.status} color={colors.accent} accessibilityLabel="読み込み中" />}
      </View>
      <SafeAreaView edges={['bottom']} style={[styles.composer, {
        backgroundColor: colors.header, borderTopColor: colors.border,
      }]}>
        <View style={styles.composerContent}>
          {canMention && (
            <ScrollView horizontal keyboardShouldPersistTaps="handled"
              style={styles.seatScroll} contentContainerStyle={styles.seatRow}>
              {state.seats.map(({ seat_id }) => {
                const selected = seat_id === seatId;
                return (
                  <Pressable key={seat_id} accessibilityRole="button" accessibilityLabel={seat_id}
                    accessibilityState={{ selected, disabled: writeBusy }} disabled={writeBusy}
                    onPress={() => setAddressee(seat_id)} style={[ui.button, styles.seat, selected && ui.primary]}>
                    <View style={[styles.avatar, { backgroundColor: colors.surface }]} aria-hidden>
                      <Text style={ui.label}>{Array.from(seat_id)[0]?.toUpperCase()}</Text>
                    </View>
                    <Text style={selected ? ui.primaryText : ui.label}>{seat_id}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {canMention && seatId === undefined && (
            <Text style={ui.muted}>宛先のエージェントを選んでください（＠メンション）。宛先なしの投稿はできません</Text>
          )}
          {writeFeedback}
          <View style={styles.messageRow}>
            {canMention ? (
              <TextInput accessibilityLabel="メンションの内容"
                style={[ui.input, styles.mentionInput, seatId === undefined && ui.disabled]}
                value={text} onChangeText={setText} editable={seatId !== undefined && !writeBusy} multiline />
            ) : (
              <View style={[ui.input, styles.mentionInput, styles.disabledInput, { backgroundColor: colors.pressed }]}>
                <Text numberOfLines={1} adjustsFontSizeToFit style={ui.muted}>{postingReason}</Text>
              </View>
            )}
            <Pressable accessibilityRole="button" disabled={!canSend}
              accessibilityState={{ disabled: !canSend }} onPress={sendMention}
              style={[styles.send, !canSend && ui.disabled]}>
              <Text style={[ui.label, { color: canMention ? colors.accentText : colors.muted }]}>送信</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

export default function MeetingScreen() {
  const { source, meetingId } = useLocalSearchParams<{ source?: string; meetingId?: string }>();
  return <MeetingView key={JSON.stringify([source, meetingId])} fixture={source === 'fixture'} meetingId={meetingId} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 6, paddingHorizontal: 12, paddingVertical: 8,
  },
  headerActions: { flexDirection: 'row' },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerIcon: { fontSize: 22 },
  runner: { alignItems: 'flex-start', gap: 4 },
  controls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  list: { width: '100%', maxWidth: 800, alignSelf: 'center', padding: 10, paddingBottom: 24 },
  agenda: { borderRadius: 16, paddingVertical: 8, gap: 4 },
  agendaLabel: { fontSize: 13, textAlign: 'center', marginVertical: 2 },
  agendaTopic: { fontSize: 14, lineHeight: 20 },
  separator: { height: 6 },
  footer: { gap: 8, marginTop: 8 },
  message: { alignSelf: 'center', textAlign: 'center', marginVertical: 8 },
  status: { padding: 14, gap: 8, alignItems: 'center' },
  error: { textAlign: 'center' },
  composer: { borderTopWidth: StyleSheet.hairlineWidth },
  composerContent: { width: '100%', maxWidth: 800, alignSelf: 'center', padding: 10, gap: 6 },
  seatScroll: { flexGrow: 0 },
  seatRow: { gap: 8 },
  seat: { flexDirection: 'row', gap: 6, borderRadius: 24 },
  avatar: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
  },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  mentionInput: { flex: 1, minHeight: 44, maxHeight: 100, borderRadius: 24, paddingVertical: 8 },
  disabledInput: { justifyContent: 'center' },
  send: { minWidth: 48, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
