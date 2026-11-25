import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl,
  SectionList, StyleSheet, Text, TextInput, View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent, TextInputSelectionChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeFacadeError, FacadeError, fetchMeeting, fetchRunner, postApprove, postMention } from '../api';
import { AgendaAnnouncement } from '../components/AgendaAnnouncement';
import { AttestRow } from '../components/AttestRow';
import { ChatHeader, HeaderIcon, HeaderPill } from '../components/ChatHeader';
import { GateCard } from '../components/GateCard';
import { PacketBubble } from '../components/PacketBubble';
import { RoundHeader } from '../components/RoundHeader';
import { SeatAvatar } from '../components/SeatAvatar';
import { StateBanner } from '../components/StateBanner';
import { SynthesisCard } from '../components/SynthesisCard';
import { mentionedSeat } from '../components/MentionText';
import { lineHeightFor, useTheme } from '../components/styles';
import { loadFixtureMeeting } from '../fixtures';
import { buildTimeline, receptionRowsForRound, supersededInfo, topicOf } from '../model';
import type { TimelineItem } from '../model';
import { loadSettings, saveSettings } from '../storage';
import type { DisplayStyle } from '../storage';
import { isPacketKind } from '../types';
import type { ApproveDecision, GetPacketsResponse, MeetingData, PacketEntry, Round, RoundState, RunnerState } from '../types';

const approvalLabels: Record<ApproveDecision, string> = { approve: '承認する', reject: '却下する' };
const styleNames: Record<DisplayStyle, string> = { line: 'ライン', slack: 'スレッド' };

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
    } else if (item.type === 'timeout') {
      // The timeout notice closes the rounds; notes sent after it follow as top-level posts, so the
      // last of them stays right above the synthesis card.
      section = { key: 'timeout', data: [item] };
      sections.push(section);
    } else {
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

/** A successful mention send, with what the meeting held just before it. */
type SentPost = {
  /** Bumped per send, so each send triggers one reveal. */
  seq: number;
  /** The body exactly as sent (the facade persists it verbatim in the note). */
  text: string;
  /** The explicitly selected addressee. */
  seatId: string;
  /** packet_ids present before the send. */
  knownIds: ReadonlySet<string>;
  /** Latest created_at (ms, facade clock) among those packets; -Infinity if none parse. */
  after: number;
};

/**
 * The note packet this send created, found in refreshed data (the mention response carries no
 * packet_id): a note that was not there before the send, whose text is the sent body, whose seat (if
 * the facade records one) is the addressee, and whose created_at is not earlier than anything that
 * existed before (same facade clock, commit order). If several qualify, the first committed wins: the
 * send's own note is committed right after the snapshot, so an identical post arriving later (another
 * device, a repeat send) never takes the anchor over.
 */
function findSentNote(packets: GetPacketsResponse, sent: SentPost): string | undefined {
  for (const entry of packets.new_packets) {
    if (!isPacketKind(entry, 'note')) continue;
    const { header, body } = entry.packet;
    if (sent.knownIds.has(header.packet_id)) continue;
    if (typeof body?.text !== 'string' || body.text.trim() !== sent.text) continue;
    if (header.seat_id !== null && header.seat_id !== sent.seatId) continue;
    const at = Date.parse(header.created_at);
    if (!Number.isNaN(at) && at < sent.after) continue;
    return header.packet_id;
  }
  return undefined;
}

// Space kept above the revealed post so it does not sit flush against the top edge.
const revealMargin = 12;

function MeetingContent({ data, displayStyle, refreshing, refresh, openPacket, follow }: {
  data: MeetingData; displayStyle: DisplayStyle; refreshing: boolean; refresh: () => void;
  openPacket: (packetId: string) => void;
  /** Set after the user's own post succeeds: bring that post into view and keep it there while polling. */
  follow?: SentPost;
}) {
  const { colors, ui } = useTheme();
  const { state, packets } = data;
  const flatRef = useRef<FlatList<ListItem>>(null);
  const sectionRef = useRef<SectionList<ListItem, MeetingSection>>(null);
  // Whether the view is parked at the latest content. Starts true so the meeting opens at the end;
  // afterwards only the user's own scrolling changes it, so polling never yanks a reader back down.
  const pinned = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
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

  // The last scroll offset seen, to tell a sizable upward move by the user from our own scrolls.
  const lastOffset = useRef(0);
  // Set by a successful send until the user drags the list, taps "最新へ" or moves well up: following
  // then anchors on the sent post itself rather than on the end (see revealSent).
  const revealing = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retries = useRef(0);
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  // Where the sent post sits in the current list (line: item index; thread: section + item index).
  const sentId = follow && findSentNote(packets, follow);
  const sentLocation = (() => {
    if (sentId === undefined) return undefined;
    const isSent = (item: ListItem) => item.type === 'packet' && item.entry.packet.header.packet_id === sentId;
    if (displayStyle === 'line') {
      const index = items.findIndex(isSent);
      return index < 0 ? undefined : { index, sectionIndex: 0, itemIndex: 0 };
    }
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const itemIndex = sections[sectionIndex].data.findIndex(isSent);
      if (itemIndex >= 0) return { index: 0, sectionIndex, itemIndex };
    }
    return undefined;
  })();
  const sentKey = sentLocation && `${sentId}:${sentLocation.index}:${sentLocation.sectionIndex}:${sentLocation.itemIndex}`;

  function scrollToEnd(animated: boolean) {
    if (displayStyle === 'line') flatRef.current?.scrollToEnd({ animated });
    else sectionRef.current?.getScrollResponder()?.scrollToEnd({ animated });
  }

  // Our own (non-animated) moves, even upward, must not read as the user scrolling away: scroll events
  // shortly after one are not checked for that. A time window rather than "the next event", because a
  // re-anchor that does not move (already in place) reports no event at all.
  const ownScrollUntil = useRef(0);
  function markOwnScroll() {
    ownScrollUntil.current = Date.now() + 250;
  }

  // Put the sent post at the top of the viewport (with a small margin); the scroll view stops at the
  // end on its own, so when little follows the post this is simply the end, and when a lot follows
  // (a tall synthesis card, many posts in the same update, later polling growth) the post stays in view.
  // Until a refresh brings the post (and it can be identified), do not scroll at all: the view stays
  // where it is — also when content grows meanwhile, since growth while revealing routes here rather
  // than to the end — and the sentKey effect anchors on the post once it is found.
  function revealSent() {
    if (!sentLocation) return;
    markOwnScroll();
    if (displayStyle === 'line') {
      flatRef.current?.scrollToIndex({ index: sentLocation.index, viewPosition: 0, viewOffset: revealMargin, animated: false });
    } else {
      // SectionList counts the section's header cell as itemIndex 0, so the item itself is itemIndex + 1.
      sectionRef.current?.scrollToLocation({
        sectionIndex: sentLocation.sectionIndex, itemIndex: sentLocation.itemIndex + 1,
        viewPosition: 0, viewOffset: revealMargin, animated: false,
      });
    }
  }

  // revealSent as of the latest render, for the delayed retry below (a timer would otherwise keep the
  // closure, and so the sent-post location, of the render that scheduled it). A layout effect, so the
  // ref is current synchronously within the commit: no timer can run between a new send's commit and
  // this update and scroll toward the earlier post (passive effects may run in a later task).
  const revealLatest = useRef(revealSent);
  useLayoutEffect(() => {
    revealLatest.current = revealSent;
  });

  // The post's cell has not been measured yet (the refresh that brought it is not laid out, or it lies
  // past the rendered window): bring the furthest measured cell's bottom edge to the viewport's bottom
  // (its position is known, so this scroll succeeds). The viewport then ends exactly where the
  // unmeasured cells begin, so the list renders and measures them — however tall that cell is — and the
  // retry gets further. No average-size estimate is involved.
  function onScrollToIndexFailed({ highestMeasuredFrameIndex }: { highestMeasuredFrameIndex: number }) {
    if (!revealing.current) return;
    markOwnScroll();
    // highestMeasuredFrameIndex is a flat cell index: FlatList's item index, or SectionList's flattened
    // index (header, items, footer per section), which the inner list's scrollToIndex takes as is.
    const index = Math.max(0, highestMeasuredFrameIndex);
    if (displayStyle === 'line') {
      flatRef.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
    } else {
      sectionRef.current?.scrollToLocation({ sectionIndex: 0, itemIndex: index, viewPosition: 1, animated: false });
    }
    if (retries.current >= 10) return;
    retries.current += 1;
    clearTimeout(retryTimer.current);
    // Through the ref, so the retry reads the location of the latest render, not this render's.
    retryTimer.current = setTimeout(() => {
      if (revealing.current) revealLatest.current();
    }, 100);
  }

  function scrollToLatest(animated: boolean) {
    if (revealing.current) revealSent();
    else scrollToEnd(animated);
  }

  function onScroll({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    // "Near the end" is a quarter of the viewport, so it scales with the screen rather than a pixel count.
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const near = distance <= layoutMeasurement.height / 4;
    // A sizable move up is the user scrolling away (also without a drag, e.g. a screen reader's page
    // scroll): leave reveal mode so the B2 rule applies again. Our own scrolls (markOwnScroll) never
    // count as such a move.
    if (revealing.current && Date.now() > ownScrollUntil.current &&
        contentOffset.y < lastOffset.current - layoutMeasurement.height / 4) {
      revealing.current = false;
    }
    lastOffset.current = contentOffset.y;
    // While revealing a sent post the view may rest short of the end on purpose: stay pinned.
    if (!revealing.current) pinned.current = near;
    setAtEnd(near);
  }

  // A drag ends reveal mode. Leaving it also unpins until the drag's own scroll events re-derive pinned
  // (B2 rule), so growth arriving before them cannot pull the view to the end — the last known position
  // may predate our own reveal move.
  function onScrollBeginDrag() {
    if (revealing.current) pinned.current = false;
    revealing.current = false;
  }

  // New posts (polling) and the list filling in after open grow the content: follow only while pinned.
  // While revealing a sent post, growth re-anchors on that post instead of chasing the end (and, while
  // the post is not yet identified, does not scroll at all).
  function onContentSizeChange() {
    if (pinned.current) scrollToLatest(false);
  }

  // The viewport shrinking (keyboard, composer growing) would otherwise push the latest out of view.
  function onLayout() {
    if (pinned.current) scrollToLatest(false);
  }

  function jumpToLatest() {
    revealing.current = false;
    pinned.current = true;
    setAtEnd(true);
    scrollToLatest(true);
  }

  // After a successful send, follow again even if the reader had scrolled up, in reveal mode. The post
  // itself arrives with the post-write refresh; until then nothing scrolls (see revealSent), and once
  // it is identified the sentKey effect (or, being pinned, onContentSizeChange) anchors on it.
  // Not animated, so no intermediate scroll positions are reported on the way.
  const seenFollow = useRef(follow?.seq);
  useEffect(() => {
    if (follow?.seq === seenFollow.current) return;
    seenFollow.current = follow?.seq;
    // A retry still pending from an earlier send must not move the view toward that earlier post.
    clearTimeout(retryTimer.current);
    revealing.current = true;
    pinned.current = true;
    retries.current = 0;
    revealSent();
  });

  // Once the sent post is found (or moves within the list), anchor on it even if the content size
  // happens not to change with that refresh.
  useEffect(() => {
    if (sentKey !== undefined && revealing.current && pinned.current) {
      retries.current = 0;
      revealSent();
    }
    // Only on a new location; revealSent reads the current one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentKey]);

  const footer = (
    <View style={styles.footer}>
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
    onScroll,
    onScrollBeginDrag,
    scrollEventThrottle: 64,
    onContentSizeChange,
    onLayout,
    onScrollToIndexFailed,
  };

  return (
    <View style={styles.screen}>
      {displayStyle === 'line' ? <FlatList ref={flatRef} {...listProps} data={items} renderItem={renderItem} /> : (
        <SectionList<ListItem, MeetingSection>
          ref={sectionRef}
          {...listProps}
          sections={sections}
          renderItem={renderThreadItem}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => section.header
            ? roundHeader(section.header.round, section.header.phase)
            : null}
        />
      )}
      {!atEnd && (
        <Pressable accessibilityRole="button" accessibilityLabel="最新へ" onPress={jumpToLatest}
          style={({ pressed }) => [styles.latest, {
            backgroundColor: colors.surface, borderColor: colors.border, shadowColor: '#000',
          }, pressed && { backgroundColor: colors.pressed }]}>
          <Text style={[styles.latestGlyph, { color: colors.ink }]}>↓</Text>
        </Pressable>
      )}
    </View>
  );
}

function agendaOf(data: MeetingData): PacketEntry<'agenda'> | undefined {
  return data.packets.new_packets.find((entry): entry is PacketEntry<'agenda'> => isPacketKind(entry, 'agenda'));
}

type MentionQuery = { start: number; end: number; token: string };

/**
 * The `@partial` token at the cursor, if any (Slack-style mention autocomplete). The `@` may start
 * the text or a line, or follow whitespace or Japanese punctuation (。、！？). `end` runs past the
 * cursor to the end of the token, so choosing a candidate removes the whole fragment.
 */
function mentionQuery(text: string, cursor: number): MentionQuery | undefined {
  const before = text.slice(0, cursor);
  const match = /(?:^|[\s。、！？])[@＠]([^\s@＠、。,.!?！？]*)$/.exec(before);
  if (!match) return undefined;
  const rest = /^[^\s@＠、。,.!?！？]*/.exec(text.slice(cursor))?.[0] ?? '';
  return { start: before.length - match[1].length - 1, end: cursor + rest.length, token: match[1] + rest };
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
  // The latest successful mention send; MeetingContent reveals that post whenever this changes.
  const [follow, setFollow] = useState<SentPost>();
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
  // An `@seat` that names a seat exactly, while nothing is selected: offer it as a chip — also while the
  // candidate menu is up (an exact ID is usually a prefix of itself, so the menu shows it too). The
  // fragment at the cursor wins over other `@seat`s in the text. Only a tap on the chip (or on a
  // candidate) selects — the text never selects an addressee by itself.
  const exactSeat = canMention && seatId === undefined
    ? (query && seatIds.find(id => id === query.token)) ?? mentionedSeat(text, seatIds)
    : undefined;
  // The @ button opens an explicit all-seat picker that the typed fragment does not filter; it closes
  // on a selection or another tap of the button. Otherwise the menu follows the typed fragment.
  const menu: { seats: readonly string[] } | undefined = canMention && pickerOpen
    ? { seats: seatIds }
    : candidates.length > 0 ? { seats: candidates } : undefined;

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
    const body = text.trim();
    // What the meeting held before this send, to tell the new note apart once a refresh brings it.
    const before = data?.packets.new_packets ?? [];
    const knownIds = new Set(before.map(entry => entry.packet.header.packet_id));
    const after = before.reduce((latest, entry) => {
      const at = Date.parse(entry.packet.header.created_at);
      return Number.isNaN(at) ? latest : Math.max(latest, at);
    }, -Infinity);
    void write(async ({ facadeUrl, token, id }) => {
      const nextRunner = await postMention(facadeUrl, token, id, { seat_id: seatId, text: body });
      if (active.current) {
        setMeeting(current => current && { ...current, runner: nextRunner });
        setText('');
        setCursor(0);
        setAddressee(undefined);
        setPickerOpen(false);
        setFollow(previous => ({ seq: (previous?.seq ?? 0) + 1, text: body, seatId, knownIds, after }));
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
    setPickerOpen(false);
  }

  function chooseSeat(seat: string) {
    setAddressee(seat);
    setPickerOpen(false);
  }

  // From either menu, a typed `@…` fragment at the cursor is removed (sheet: the whole fragment goes on
  // a selection); with no fragment the picker only selects.
  function chooseFromMenu(seat: string) {
    if (query) chooseCandidate(seat);
    else chooseSeat(seat);
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
        {/* Reads as the current style; a tap switches to the other one. */}
        <HeaderPill text={styleNames[displayStyle]}
          label={`表示スタイル：${styleNames[displayStyle]}風`}
          hint={`${styleNames[nextStyle]}風に切り替え`}
          disabled={!settingsReady} onPress={() => chooseStyle(nextStyle)} />
        <HeaderIcon glyph="↻" label="更新" disabled={refreshDisabled} onPress={update} />
      </ChatHeader>
      {agenda && <AgendaAnnouncement entry={agenda} />}
      {error && (
        <View style={styles.status}>
          <Text accessibilityLiveRegion="polite" style={errorStyle}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={update} style={ui.button}>
            <Text style={[ui.label, ui.buttonText]}>再試行</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.screen}>
        {/* Keyed by style so each list style mounts fresh and opens at the latest content. */}
        {data ? <MeetingContent key={displayStyle} data={data} displayStyle={displayStyle} refreshing={loading} refresh={update}
          openPacket={openPacket} follow={follow} />
          : loading && <ActivityIndicator style={styles.status} color={colors.accent} accessibilityLabel="読み込み中" />}
      </View>
      <SafeAreaView edges={['bottom']} style={[styles.composer, { backgroundColor: colors.header }]}>
        {(data || saveFailed) && (
          <View style={[styles.band, { borderBottomColor: colors.border }]}>
            <View style={styles.bandRow}>
              {data && <StateBanner state={data.state.meeting_state} canApprove={canApprove} />}
              {data && (runner?.phase === 'error' || (runner?.phase === 'running' && phase !== 'OPEN')) &&
                <RunnerIndicator runner={runner} />}
            </View>
            {canApprove && (
              <>
                {/* What the decision applies to and what each choice does (facts of the facade's approve route). */}
                <Text style={ui.muted}>承認の対象は直前の統合案です。</Text>
                <Text style={ui.muted}>承認：会議は完了として終了 ／ 却下：会議は却下として終了（再議論にはなりません）</Text>
                <View style={styles.controls}>
                  <Pressable accessibilityRole="button" accessibilityHint="直前の統合案を承認し、会議を完了として終了します"
                    disabled={writeBusy} onPress={() => confirmApproval('approve')}
                    style={[ui.button, ui.primary, styles.bandButton, writeBusy && ui.disabled]}>
                    <Text style={[ui.primaryText, ui.buttonText]}>{approvalLabels.approve}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityHint="直前の統合案を却下し、会議を却下として終了します"
                    disabled={writeBusy} onPress={() => confirmApproval('reject')}
                    style={[ui.button, styles.bandButton, { backgroundColor: colors.redBackground }, writeBusy && ui.disabled]}>
                    <Text style={[ui.label, ui.buttonText, { color: colors.red }]}>{approvalLabels.reject}</Text>
                  </Pressable>
                </View>
              </>
            )}
            {saveFailed && <Text accessibilityLiveRegion="polite" style={ui.muted}>表示設定を保存できませんでした</Text>}
          </View>
        )}
        <View style={styles.composerContent}>
          {menu && (
            <View accessibilityRole="menu"
              style={[styles.popup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {menu.seats.map(id => {
                const selected = id === seatId;
                return (
                  <Pressable key={id} accessibilityRole="menuitem" accessibilityLabel={`宛先 ${id}`}
                    accessibilityState={{ selected, disabled: writeBusy }} disabled={writeBusy}
                    onPress={() => chooseFromMenu(id)}
                    style={({ pressed }) => [styles.candidate, pressed && { backgroundColor: colors.pressed }]}>
                    <SeatAvatar seat={id} size={26} shape="rounded" />
                    <Text style={[ui.label, styles.candidateLabel]}>@{id}</Text>
                    {selected && <Text style={[ui.label, { color: colors.accentText }]} aria-hidden>✓</Text>}
                  </Pressable>
                );
              })}
            </View>
          )}
          {exactSeat !== undefined && (
            <Pressable accessibilityRole="button" accessibilityLabel={`宛先を ${exactSeat} にする`}
              disabled={writeBusy} onPress={() => chooseSeat(exactSeat)}
              style={({ pressed }) => [styles.suggestion, {
                backgroundColor: colors.mentionBackground, borderColor: colors.mention,
              }, pressed && styles.pressedChip]}>
              <Text style={[ui.label, styles.suggestionText, { color: colors.mention }]}>
                宛先： {exactSeat} にする
              </Text>
            </Pressable>
          )}
          {canMention && seatId !== undefined && (
            <View style={styles.addresseeRow}>
              <Text numberOfLines={1} style={[ui.chip, { color: colors.mention, backgroundColor: colors.mentionBackground }]}>
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
          {canMention && seatId === undefined && hasText && exactSeat === undefined && (
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
                placeholder="@で席を指定して発言" placeholderTextColor={colors.muted}
                style={[styles.mentionInput, { backgroundColor: colors.inputBg, color: colors.ink }]}
                value={text} onChangeText={setText} onSelectionChange={onSelectionChange}
                selection={forcedSelection}
                editable={!writeBusy} multiline />
            ) : (
              <View style={[styles.mentionInput, styles.disabledInput, { backgroundColor: colors.inputBg }]}>
                <Text numberOfLines={2} style={ui.muted}>{postingReason}</Text>
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
  // Full-width row of equal buttons: the labels get spare width instead of an exact-fit box.
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  bandButton: { flex: 1, minHeight: 40, paddingVertical: 4, borderRadius: 20 },
  composerContent: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 6 },
  popup: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 4, overflow: 'hidden' },
  candidate: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 44 },
  candidateLabel: { flex: 1, minWidth: 0 },
  suggestion: {
    // Spans the input's width (between the @ and send buttons) so its label is never boxed to an exact fit.
    marginLeft: 46, marginRight: 50, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16,
    paddingHorizontal: 12, paddingVertical: 6, minHeight: 36, justifyContent: 'center',
  },
  suggestionText: { fontWeight: '600' },
  pressedChip: { opacity: 0.7 },
  addresseeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 48 },
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
  latest: {
    position: 'absolute', right: 14, bottom: 12, width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth,
    elevation: 3, shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  latestGlyph: { fontSize: 20, lineHeight: lineHeightFor(20) },
});
