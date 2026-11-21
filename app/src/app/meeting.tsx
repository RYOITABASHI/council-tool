import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { FacadeError, facadeErrorMessages, fetchMeeting } from '../api';
import type { FacadeErrorKind } from '../api';
import { AttestRow } from '../components/AttestRow';
import { GateCard } from '../components/GateCard';
import { PacketBubble } from '../components/PacketBubble';
import { RoundHeader } from '../components/RoundHeader';
import { StateBanner } from '../components/StateBanner';
import { SynthesisCard } from '../components/SynthesisCard';
import { colors, ui } from '../components/styles';
import { loadFixtureMeeting } from '../fixtures';
import { buildTimeline, receptionRowsForRound, supersededInfo, topicOf } from '../model';
import type { TimelineItem } from '../model';
import { displayStyles, loadSettings, saveSettings } from '../storage';
import type { DisplayStyle } from '../storage';
import type { MeetingData, Round, RoundState } from '../types';

type LoadError = FacadeErrorKind | 'fixture';
const errorMessages: Record<LoadError, string> = {
  ...facadeErrorMessages,
  fixture: 'サンプル会議の読み込みに失敗しました',
};

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
  return <Text style={[ui.chip, ui.warning, styles.message]}>会議が制限時間を超過しました</Text>;
}

function MeetingContent({ data, displayStyle, refreshing, refresh }: {
  data: MeetingData; displayStyle: DisplayStyle; refreshing: boolean; refresh: () => void;
}) {
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
          <View style={ui.card}>
            {displayStyle === 'line' && <Text accessibilityRole="header" style={ui.title}>アジェンダ</Text>}
            <Text selectable style={ui.body}>{item.entry.packet.body.topic}</Text>
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
    keyExtractor: itemKey,
    renderItem,
    refreshControl: <RefreshControl refreshing={refreshing} onRefresh={refresh} />,
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
        : section.title ? <Text accessibilityRole="header" style={styles.sectionTitle}>{section.title}</Text>
          : null}
    />
  );
}

function ItemSeparator() {
  return <View style={styles.separator} />;
}

function MeetingView({ fixture, meetingId }: { fixture: boolean; meetingId?: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError>();
  const [data, setData] = useState<MeetingData>();
  const [displayStyle, setDisplayStyle] = useState<DisplayStyle>('line');
  const [settingsReady, setSettingsReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const active = useRef(false);
  const inFlight = useRef<symbol | null>(null);
  const firstFocus = useRef(true);
  const saveAttempt = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const request = Symbol();
    inFlight.current = request;
    setLoading(true);
    setError(undefined);
    try {
      let result: MeetingData;
      if (fixture) {
        const sample = meetingId ? loadFixtureMeeting(meetingId) : null;
        if (!sample) throw new FacadeError('not_found');
        result = sample;
      } else {
        const { facadeUrl, token, meetingId: savedId } = await loadSettings();
        if (!facadeUrl) throw new FacadeError('unreachable');
        const id = meetingId ?? savedId;
        if (!id) throw new FacadeError('not_found');
        result = await fetchMeeting(facadeUrl, token, id);
      }
      if (inFlight.current === request) setData(result);
    } catch (cause) {
      if (inFlight.current === request) {
        const kind = cause instanceof FacadeError ? cause.kind : fixture ? 'fixture' : 'http';
        if (kind === 'unauthorized' || kind === 'not_found') setData(undefined);
        setError(kind);
      }
    } finally {
      if (inFlight.current === request) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [fixture, meetingId]);

  useEffect(() => {
    active.current = true;
    void loadSettings().then(settings => {
      if (active.current) {
        setDisplayStyle(settings.displayStyle);
        setSettingsReady(true);
      }
    });
    void refresh();
    return () => {
      active.current = false;
      firstFocus.current = true;
      inFlight.current = null;
    };
  }, [refresh]);

  useFocusEffect(useCallback(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
    } else {
      let focused = true;
      void loadSettings().then(settings => {
        if (focused) setDisplayStyle(settings.displayStyle);
      });
      if (!fixture) void refresh();
      return () => { focused = false; };
    }
  }, [fixture, refresh]));

  function chooseStyle(value: DisplayStyle) {
    setDisplayStyle(value);
    setSaveFailed(false);
    const attempt = ++saveAttempt.current;
    void saveSettings({ displayStyle: value }).catch(() => {
      if (active.current && saveAttempt.current === attempt) setSaveFailed(true);
    });
  }

  const update = () => void refresh();

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        {data && (
          <>
            <StateBanner state={data.state.meeting_state} />
            <Text accessibilityRole="header" style={ui.title}>{topicOf(data.packets) || '会議'}</Text>
          </>
        )}
        <View style={styles.controls}>
          <View style={styles.segmented}>
            {displayStyles.map(({ value, label }) => (
              <Pressable key={value} accessibilityRole="button"
                accessibilityState={{ selected: displayStyle === value }}
                disabled={!settingsReady}
                onPress={() => chooseStyle(value)}
                style={[ui.button, styles.segment, displayStyle === value && ui.primary]}
              >
                <Text style={[ui.label, displayStyle === value && ui.primaryText]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" disabled={loading} onPress={update} style={ui.button}>
            <Text style={ui.label}>更新</Text>
          </Pressable>
        </View>
        {saveFailed && <Text accessibilityLiveRegion="polite" style={ui.muted}>表示設定を保存できませんでした</Text>}
      </View>
      {error && (
        <View style={styles.status}>
          <Text accessibilityLiveRegion="polite" style={[ui.body, styles.error]}>{errorMessages[error]}</Text>
          <Pressable accessibilityRole="button" onPress={update} style={ui.button}>
            <Text style={ui.label}>再試行</Text>
          </Pressable>
        </View>
      )}
      {data ? <MeetingContent data={data} displayStyle={displayStyle} refreshing={loading} refresh={update} />
        : loading && <ActivityIndicator style={styles.status} color={colors.teal} accessibilityLabel="読み込み中" />}
    </View>
  );
}

export default function MeetingScreen() {
  const { source, meetingId } = useLocalSearchParams<{ source?: string; meetingId?: string }>();
  return <MeetingView key={JSON.stringify([source, meetingId])} fixture={source === 'fixture'} meetingId={meetingId} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    backgroundColor: colors.white, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border, gap: 10, padding: 14,
  },
  controls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  segmented: { flex: 1, minWidth: 210, flexDirection: 'row', gap: 4 },
  segment: { flex: 1 },
  list: { width: '100%', maxWidth: 800, alignSelf: 'center', padding: 14, paddingBottom: 36 },
  sectionTitle: { ...ui.title, paddingTop: 8, paddingBottom: 10 },
  separator: { height: 8 },
  footer: { gap: 8, marginTop: 8 },
  message: { alignSelf: 'center', textAlign: 'center', marginVertical: 8 },
  status: { padding: 14, gap: 8, alignItems: 'center' },
  error: { color: colors.red, textAlign: 'center' },
});
