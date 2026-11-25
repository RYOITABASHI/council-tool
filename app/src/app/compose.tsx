import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { createMeeting, describeFacadeError, fetchCliSeatKinds, startMeeting } from '../api';
import { useTheme } from '../components/styles';
import { AGENT_PRESETS, loadSettings } from '../storage';
import type { Settings } from '../storage';
import type { CliSeatKinds, SeatKind } from '../types';

const presets = AGENT_PRESETS.map(preset => ({
  ...preset,
  seat_id: preset.id === 'claude-code-cli' ? 'claude' : preset.id.replace(/-cli$/, ''),
}));

/** The /health key reporting a seat kind's availability; api and local seats are not reported there. */
const healthKey: Partial<Record<SeatKind, keyof CliSeatKinds>> = { 'codex-cli': 'codex', 'claude-code-cli': 'claude' };

/** Whether this host can run the kind: false only when /health says so; unknown counts as runnable. */
function unavailableOn(kinds: CliSeatKinds | undefined, kind: SeatKind): boolean {
  const key = healthKey[kind];
  return kinds !== undefined && key !== undefined && kinds[key] === false;
}

const unavailableNote = 'このホストでは実行できません';

export default function ComposeScreen() {
  const { colors, ui } = useTheme();
  const [settings, setSettings] = useState<Settings>();
  const [topic, setTopic] = useState('');
  // The user's explicit choices per kind; untouched kinds follow the default set (which drops kinds
  // /health reports as unavailable, even when the report arrives after other kinds were toggled).
  const [toggled, setToggled] = useState<Partial<Record<SeatKind, boolean>>>({});
  const [createdId, setCreatedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const focused = useRef(false);
  const inFlight = useRef(false);
  // What /health reports for this host; undefined while loading or when it cannot be read ("unknown").
  const [seatKinds, setSeatKinds] = useState<CliSeatKinds>();

  useFocusEffect(useCallback(() => {
    let current = true;
    focused.current = true;
    void loadSettings().then(value => { if (current) setSettings(value); });
    return () => {
      current = false;
      focused.current = false;
    };
  }, []));

  const healthUrl = settings?.facadeUrl.trim() ?? '';
  useEffect(() => {
    if (!healthUrl) return;
    let current = true;
    void fetchCliSeatKinds(healthUrl).then(kinds => { if (current) setSeatKinds(kinds); });
    return () => { current = false; };
  }, [healthUrl]);

  if (!settings) return <ActivityIndicator accessibilityLabel="読み込み中" color={colors.accent} style={styles.loading} />;

  const facadeUrl = settings.facadeUrl.trim();
  if (!facadeUrl) {
    return (
      <View style={styles.content}>
        <View style={ui.card}>
          <Text style={ui.body}>セッションを作成するにはサーバー接続が必要です</Text>
          <Pressable accessibilityRole="button" style={[ui.button, ui.primary]} onPress={() => router.push('/settings')}>
            <Text style={[ui.primaryText, ui.buttonText]}>設定を開く</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Kinds this host cannot run are left out of the default set (still selectable, with the note).
  const selected = presets.filter(({ id }) =>
    toggled[id] ?? (settings.selectedAgents.includes(id) && !unavailableOn(seatKinds, id))).map(({ id }) => id);
  const seats = presets.filter(({ id }) => selected.includes(id)).map(({ id, seat_id }) => ({ seat_id, kind: id }));
  const trimmedTopic = topic.trim();
  const canSubmit = !!trimmedTopic && seats.length > 0 && !busy;
  const formLocked = busy || createdId !== undefined;

  async function submit() {
    if (!canSubmit || inFlight.current || !settings) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const token = settings.token;
      let meetingId = createdId;
      if (meetingId === undefined) {
        const result = await createMeeting(facadeUrl, token, { topic: trimmedTopic, seats });
        meetingId = result.meeting_id;
        setCreatedId(meetingId);
      }
      await startMeeting(facadeUrl, token, meetingId);
      if (focused.current) router.replace({ pathname: '/meeting', params: { source: 'facade', meetingId } });
    } catch (cause) {
      setError(describeFacadeError(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={ui.card}>
          <Text style={ui.label}>議題</Text>
          <TextInput accessibilityLabel="議題" style={[ui.input, styles.topic]} multiline
            value={topic} onChangeText={setTopic} editable={!formLocked} textAlignVertical="top" />
        </View>
        <View style={ui.card}>
          <Text accessibilityRole="header" style={ui.title}>エージェント席</Text>
          {presets.map(({ id, label, description, seat_id }) => {
            const checked = selected.includes(id);
            const unavailable = unavailableOn(seatKinds, id);
            return (
              <Pressable key={id} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: formLocked }}
                disabled={formLocked} style={[ui.button, styles.seat, checked && ui.primary]}
                onPress={() => setToggled(previous => ({ ...previous, [id]: !checked }))}>
                <View style={styles.seatHeading}>
                  <Text style={[checked ? ui.primaryText : ui.label, styles.seatLabel]}>{label}</Text>
                  <Text numberOfLines={1} style={ui.chip}>{seat_id}</Text>
                </View>
                <Text style={[ui.muted, checked && { color: colors.onAccent }]}>{description}</Text>
                {unavailable && (
                  <Text style={[ui.muted, { color: checked ? colors.onAccent : colors.red }]}>{unavailableNote}</Text>
                )}
              </Pressable>
            );
          })}
        </View>
        {!!error && <Text accessibilityLiveRegion="polite" style={[ui.body, { color: colors.red }]}>{error}</Text>}
        {error && createdId !== undefined && (
          <Pressable accessibilityRole="button" style={ui.button} onPress={() =>
            router.push({ pathname: '/meeting', params: { source: 'facade', meetingId: createdId } })}>
            <Text style={[ui.label, ui.buttonText]}>作成した会議を開く</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canSubmit, busy }}
          disabled={!canSubmit} onPress={() => void submit()} style={[ui.button, ui.primary, !canSubmit && ui.disabled]}>
          <Text style={[ui.primaryText, ui.buttonText]}>作成して開始</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { padding: 20 },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 12, gap: 12 },
  topic: { minHeight: 112, paddingVertical: 10 },
  seat: { alignItems: 'flex-start', gap: 2 },
  seatHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  // The label takes the heading row's spare width, so it is never boxed to its exact measured width.
  seatLabel: { flex: 1, minWidth: 0 },
});
