import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl,
  ScrollView, SectionList, StyleSheet, Text, TextInput, View,
} from 'react-native';
import type { TextInputSelectionChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeFacadeError, FacadeError, fetchMeeting, fetchRunner, postApprove, postMention } from '../api';
import { AgendaAnnouncement } from '../components/AgendaAnnouncement';
import { AttestRow } from '../components/AttestRow';
import { ChatHeader, HeaderIcon } from '../components/ChatHeader';
import { GateCard } from '../components/GateCard';
import { PacketBubble } from '../components/PacketBubble';
import { RoundHeader } from '../components/RoundHeader';
import { SeatAvatar } from '../components/SeatAvatar';
import { StateBanner } from '../components/StateBanner';
import { SynthesisCard } from '../components/SynthesisCard';
import { useTheme } from '../components/styles';
import { loadFixtureMeeting } from '../fixtures';
import { buildTimeline, receptionRowsForRound, supersededInfo, topicOf } from '../model';
import type { TimelineItem } from '../model';
import { loadSettings, saveSettings } from '../storage';
import type { DisplayStyle } from '../storage';
import { isPacketKind } from '../types';
import type { ApproveDecision, MeetingData, PacketEntry, Round, RoundState, RunnerState } from '../types';

const approvalLabels: Record<ApproveDecision, string> = { approve: '承認する', reject: '却下する' };

type Connection = { facadeUrl: string; token: string; id: string };
type LoadedMeeting = { data: MeetingData; runner?: RunnerState; connection?: Connection };
type RefreshRequest = { silent: boolean; done: Promise<void> };

type ListItem = Exclude<TimelineItem, { type: 'synthesis' | 'agenda' }>;
type RoundItem = Extract<ListItem, { type: 'roundHeader' }>;
type MeetingSection = {
  key: string;
  header?: RoundItem;
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

function MeetingContent({ data, displayStyle, refreshing, refresh, openPacket }: {
  data: MeetingData; displayStyle: DisplayStyle; refreshing: boolean; refresh: () => void;
  openPacket: (packetId: string) => void;
}) {
  const { colors, ui } = useTheme();
  const { state, packets } = data;
  const seatIds = useMemo(() => state.seats.map(seat => seat.seat_id), [state.seats]);
  const { items, synthesis, sections, versions } = useMemo(() => {
    const timeline = buildTimeline(state, packets);
    const items = timeline.filter((item): item is ListItem => item.type !== 'synthesis' && item.type !== 'agenda');
    return {
      items,
      synthesis: timeline.find(item => item.type === 'synthesis'),
      sections: makeSections(items),
      versions: supersededInfo(packets),
    };
  }, [state, packets]);

  function roundHeader(round: Round, phase: RoundState['phase']) {
    return <RoundHeader round={round} phase={phase} rows={receptionRowsForRound(state, round)} variant={displayStyle} />;
  }

  function renderContent(item: ListItem, reply: boolean) {
    switch (item.type) {
      case 'roundHeader': return roundHeader(item.round, item.phase);
      case 'attest': return <AttestRow entry={item.entry} />;
      case 'gate': return <GateCard entry={item.entry} />;
      case 'timeout': return <TimeoutNotice />;
      case 'packet': {
        const id = item.entry.packet.header.packet_id;
        return (
          <PacketBubble entry={item.entry} seatIds={seatIds} variant={displayStyle} reply={reply}
            isSuperseded={versions.supersededIds.has(id)}
            onPress={() => openPacket(id)}
          />
        );
      }
    }
  }

  function renderItem({ item }: { item: ListItem }) {
    return <View style={styles.lineItem}>{renderContent(item, false)}</View>;
  }

  // Slack threads: the round's first post is the parent; later posts hang off a left rail as replies.
  function renderThreadItem({ item, index, section }: { item: ListItem; index: number; section: MeetingSection }) {
    if (!section.header || index === 0) return <View style={styles.threadItem}>{renderContent(item, false)}</View>;
    return (
      <View style={[styles.reply, { borderLeftColor: colors.rail }]}>
        {renderContent(item, true)}
      </View>
    );
  }

  const footer = (
    <View style={styles.footer}>
      {displayStyle === 'slack' && state.timeout_exceeded && <TimeoutNotice />}
      {synthesis && <SynthesisCard entry={synthesis.entry} onPress={() => openPacket(synthesis.entry.packet.header.packet_id)} />}
    </View>
  );
  const listProps = {
    style: { backgroundColor: colors.chatBg },
    contentContainerStyle: styles.list,
    keyboardShouldPersistTaps: 'handled' as const,
    keyExtractor: itemKey,
    refreshControl: (
      <RefreshControl refreshing={refreshing} onRefresh={refresh}
        colors={[colors.accentText]} tintColor={colors.accentText} progressBackgroundColor={colors.surface} />
    ),
    ListHeaderComponent: packets.new_packets.length === 0
      ? <Text style={[ui.muted, styles.message]}>まだ発言がありません</Text>
      : undefined,
    ListFooterComponent: footer,
  };

  return displayStyle === 'line' ? <FlatList {...listProps} data={items} renderItem={renderItem} /> : (
    <SectionList<ListItem, MeetingSection>
      {...listProps}
      sections={sections}
      renderItem={renderThreadItem}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => section.header
        ? roundHeader(section.header.round, section.header.phase)
        : null}
    />
  );
}

function agendaOf(data: MeetingData): PacketEntry<'agenda'> | undefined {
  return data.packets.new_packets.find((entry): entry is PacketEntry<'agenda'> => isPacketKind(entry, 'agenda'));
}

type MentionQuery = { start: number; end: number; token: string };

/** The `@partial` token right before the cursor, if any (Slack-style mention autocomplete). */
function mentionQuery(text: string, cursor: number): MentionQuery | undefined {
  const before = text.slice(0, cursor);
  const match = /(^|\s)[@＠]([^\s@＠]*)$/.exec(before);
  if (!match) return undefined;
  return { start: before.length - match[2].length - 1, end: cursor, token: match[2] };
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
  const [cursor, setCursor] = useState(0);
  // Moves the native caret to where the removed `@…` fragment began, once; released on the next selection event.
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number }>();
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const seatIds = useMemo(() => state?.seats.map(seat => seat.seat_id) ?? [], [state?.seats]);
  const explicitSeat = addressee !== undefined && seatIds.includes(addressee) ? addressee : undefined;
  // The addressee is only ever an explicit selection (picker or candidate tap), never inferred from the text.
  const seatId = explicitSeat;
  const query = canMention ? mentionQuery(text, Math.min(cursor, text.length)) : undefined;
  const candidates = query
    ? seatIds.filter(id => id.toLowerCase().startsWith(query.token.toLowerCase()))
    : [];

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
        setCursor(0);
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

  function chooseCandidate(seat: string) {
    if (!query) return;
    // Select the seat explicitly and drop the typed `@…` fragment from the body.
    const caret = query.start;
    setText(text.slice(0, query.start) + text.slice(query.end));
    setCursor(caret);
    setForcedSelection({ start: caret, end: caret });
    setAddressee(seat);
  }

  function chooseSeat(seat: string) {
    setAddressee(seat);
    setPickerOpen(false);
  }

  function onSelectionChange(event: TextInputSelectionChangeEvent) {
    setCursor(event.nativeEvent.selection.end);
    if (forcedSelection) setForcedSelection(undefined);
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  const nextStyle = displayStyle === 'line' ? 'slack' : 'line';
  const refreshDisabled = loading || writeBusy;
  const postingReason = fixture ? 'サンプル会議のため投稿できません'
    : terminal ? 'この会議は終了しています'
    : !connectionConfigured ? '設定で接続すると投稿できます'
    : '会議の進行中は投稿できません';
  const update = () => refresh();
  function openPacket(packetId: string) {
    const id = connection?.id ?? meetingId;
    if (!id) return;
    router.push({ pathname: '/packet', params: { meetingId: id, packetId, source: fixture ? 'fixture' : 'facade' } });
  }
  const errorStyle = [ui.body, styles.error, { color: colors.red }];
  const writeFeedback = writeError && <Text accessibilityLiveRegion="polite" style={errorStyle}>{writeError}</Text>;

  const agenda = data && agendaOf(data);
  const hasText = !!text.trim();

  return (
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: colors.chatBg }]}
      behavior={!fixture && Platform.OS === 'ios' ? 'padding' : undefined}>
      <ChatHeader title={(data && topicOf(data.packets)) || '会議'} count={state?.seats.length}
        onBack={goBack} backgroundColor={colors.chatBg}>
        <HeaderIcon glyph="⇄" label={nextStyle === 'line' ? 'ライン風に切り替え' : 'スレッド風に切り替え'}
          disabled={!settingsReady} onPress={() => chooseStyle(nextStyle)} />
        <HeaderIcon glyph="↻" label="更新" disabled={refreshDisabled} onPress={update} />
      </ChatHeader>
      {agenda && <AgendaAnnouncement entry={agenda} />}
      {error && (
        <View style={styles.status}>
          <Text accessibilityLiveRegion="polite" style={errorStyle}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={update} style={ui.button}>
            <Text style={ui.label}>再試行</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.screen}>
        {data ? <MeetingContent data={data} displayStyle={displayStyle} refreshing={loading} refresh={update}
          openPacket={openPacket} />
          : loading && <ActivityIndicator style={styles.status} color={colors.accent} accessibilityLabel="読み込み中" />}
      </View>
      <SafeAreaView edges={['bottom']} style={[styles.composer, { backgroundColor: colors.header }]}>
        {(data || saveFailed) && (
          <View style={[styles.band, { borderBottomColor: colors.border }]}>
            <View style={styles.bandRow}>
              {data && <StateBanner state={data.state.meeting_state} canApprove={canApprove} />}
              {data && (runner?.phase === 'error' || (runner?.phase === 'running' && phase !== 'OPEN')) &&
                <RunnerIndicator runner={runner} />}
              {canApprove && (
                <View style={styles.controls}>
                  <Pressable accessibilityRole="button" disabled={writeBusy} onPress={() => confirmApproval('approve')}
                    style={[ui.button, ui.primary, styles.bandButton, writeBusy && ui.disabled]}>
                    <Text style={ui.primaryText}>{approvalLabels.approve}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={writeBusy} onPress={() => confirmApproval('reject')}
                    style={[ui.button, styles.bandButton, { backgroundColor: colors.redBackground }, writeBusy && ui.disabled]}>
                    <Text style={[ui.label, { color: colors.red }]}>{approvalLabels.reject}</Text>
                  </Pressable>
                </View>
              )}
            </View>
            {saveFailed && <Text accessibilityLiveRegion="polite" style={ui.muted}>表示設定を保存できませんでした</Text>}
          </View>
        )}
        <View style={styles.composerContent}>
          {candidates.length > 0 && (
            <View accessibilityRole="menu" style={[styles.popup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {candidates.map(id => (
                <Pressable key={id} accessibilityRole="menuitem" accessibilityLabel={`宛先 ${id}`}
                  onPress={() => chooseCandidate(id)}
                  style={({ pressed }) => [styles.candidate, pressed && { backgroundColor: colors.pressed }]}>
                  <SeatAvatar seat={id} size={26} shape="rounded" />
                  <Text style={ui.label}>@{id}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {canMention && pickerOpen && (
            <ScrollView horizontal keyboardShouldPersistTaps="handled"
              style={styles.seatScroll} contentContainerStyle={styles.seatRow}>
              {state.seats.map(({ seat_id }) => {
                const selected = seat_id === seatId;
                return (
                  <Pressable key={seat_id} accessibilityRole="button" accessibilityLabel={seat_id}
                    accessibilityState={{ selected, disabled: writeBusy }} disabled={writeBusy}
                    onPress={() => chooseSeat(seat_id)} style={[ui.button, styles.seat, selected && ui.primary]}>
                    <SeatAvatar seat={seat_id} size={24} />
                    <Text style={selected ? ui.primaryText : ui.label}>{seat_id}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {canMention && seatId !== undefined && (
            <View style={styles.addresseeRow}>
              <Text style={[ui.chip, { color: colors.mention, backgroundColor: colors.mentionBackground }]}>
                宛先 @{seatId}
              </Text>
              {explicitSeat !== undefined && (
                <Pressable accessibilityRole="button" accessibilityLabel="宛先を解除" hitSlop={8}
                  onPress={() => setAddressee(undefined)}>
                  <Text style={ui.muted}>✕</Text>
                </Pressable>
              )}
            </View>
          )}
          {canMention && seatId === undefined && hasText && (
            <Text style={ui.muted}>宛先のエージェントを選んでください（＠メンション）。宛先なしの投稿はできません</Text>
          )}
          {writeFeedback}
          <View style={styles.messageRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="宛先を選ぶ"
              accessibilityState={{ disabled: !canMention, expanded: pickerOpen }} disabled={!canMention}
              onPress={() => setPickerOpen(open => !open)}
              style={[styles.action, !canMention && ui.disabled]}>
              <Text style={[styles.actionGlyph, { color: pickerOpen ? colors.accentText : colors.muted }]}>＠</Text>
            </Pressable>
            {canMention ? (
              <TextInput accessibilityLabel="メンションの内容"
                placeholder="＠で宛先を指定してメッセージを入力" placeholderTextColor={colors.muted}
                style={[styles.mentionInput, { backgroundColor: colors.inputBg, color: colors.ink }]}
                value={text} onChangeText={setText} onSelectionChange={onSelectionChange}
                selection={forcedSelection}
                editable={!writeBusy} multiline />
            ) : (
              <View style={[styles.mentionInput, styles.disabledInput, { backgroundColor: colors.inputBg }]}>
                <Text numberOfLines={1} adjustsFontSizeToFit style={ui.muted}>{postingReason}</Text>
              </View>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="送信" disabled={!canSend}
              accessibilityState={{ disabled: !canSend }} onPress={sendMention}
              style={[styles.send, canSend && { backgroundColor: colors.accent }]}>
              <Text style={[styles.sendGlyph, {
                color: canSend ? colors.onAccent : colors.muted,
              }]}>➤</Text>
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
  runner: { alignItems: 'flex-start', gap: 4 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  list: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 10, paddingTop: 4, paddingBottom: 16 },
  lineItem: { paddingVertical: 6 },
  threadItem: { paddingTop: 4 },
  reply: { marginLeft: 22, borderLeftWidth: 2, paddingLeft: 10, paddingVertical: 2 },
  footer: { gap: 8, marginTop: 8 },
  message: { alignSelf: 'center', textAlign: 'center', marginVertical: 8 },
  status: { padding: 14, gap: 8, alignItems: 'center' },
  error: { textAlign: 'center' },
  composer: {},
  band: {
    width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 6, gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bandRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  bandButton: { minHeight: 36, paddingVertical: 4, borderRadius: 18 },
  composerContent: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 6 },
  popup: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 4, overflow: 'hidden' },
  candidate: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 44 },
  addresseeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 48 },
  seatScroll: { flexGrow: 0 },
  seatRow: { gap: 8 },
  seat: { flexDirection: 'row', gap: 6, borderRadius: 24 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  action: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  actionGlyph: { fontSize: 24, fontWeight: '300' },
  mentionInput: {
    flex: 1, minHeight: 44, maxHeight: 110, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 16,
  },
  disabledInput: { justifyContent: 'center' },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendGlyph: { fontSize: 19 },
});
