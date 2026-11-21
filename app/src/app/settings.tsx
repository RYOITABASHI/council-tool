import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { colors, ui } from '../components/styles';
import { AGENT_PRESETS, displayStyles, loadSettings, saveSettings } from '../storage';
import type { Settings } from '../storage';

const saveError = '設定を保存できませんでした。もう一度お試しください';

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void loadSettings().then(value => { if (active) setSettings(value); });
    return () => {
      active = false;
      clearTimeout(feedbackTimer.current);
    };
  }, []);

  if (!settings) return <ActivityIndicator accessibilityLabel="読み込み中" color={colors.teal} style={styles.loading} />;

  function edit(patch: Partial<Settings>) {
    setSettings(previous => previous && { ...previous, ...patch });
    setFeedback('');
  }

  function savePreference(patch: Partial<Settings>) {
    edit(patch);
    void saveSettings(patch).catch(() => setFeedback(saveError));
  }

  const connection = { facadeUrl: settings.facadeUrl.trim(), token: settings.token.trim() };
  const meetingId = settings.meetingId.trim();

  async function saveConnection(open: boolean) {
    if (busy) return;
    setBusy(true);
    setFeedback('');
    clearTimeout(feedbackTimer.current);
    try {
      const patch = open ? { ...connection, meetingId } : connection;
      await saveSettings(patch);
      edit(patch);
      if (open) {
        const source = connection.facadeUrl ? 'facade' : 'fixture';
        router.push({ pathname: '/meeting', params: { source, meetingId } });
      } else {
        setFeedback('保存しました');
        feedbackTimer.current = setTimeout(() => setFeedback(''), 2200);
      }
    } catch {
      setFeedback(saveError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={ui.card}>
          <Text accessibilityRole="header" style={ui.title}>接続</Text>
          <Text style={ui.label}>ファサードURL</Text>
          <TextInput accessibilityLabel="ファサードURL" style={styles.input}
            value={settings.facadeUrl} onChangeText={facadeUrl => edit({ facadeUrl })}
            editable={!busy} placeholder="https://host:port" placeholderTextColor={colors.muted}
            keyboardType="url" autoCapitalize="none" autoCorrect={false} />
          <Text style={ui.label}>トークン</Text>
          <TextInput accessibilityLabel="トークン" style={styles.input}
            value={settings.token} onChangeText={token => edit({ token })}
            editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          <Pressable accessibilityRole="button" disabled={busy} style={ui.button}
            onPress={() => void saveConnection(false)}>
            <Text style={ui.label}>保存</Text>
          </Pressable>
          {!!feedback && <Text accessibilityLiveRegion="polite" style={ui.muted}>{feedback}</Text>}
        </View>

        <View style={ui.card}>
          <Text accessibilityRole="header" style={ui.title}>呼び出すエージェント</Text>
          {AGENT_PRESETS.map(({ id, label, description }) => {
            const checked = settings.selectedAgents.includes(id);
            return (
              <Pressable key={id} accessibilityRole="checkbox" accessibilityState={{ checked }}
                style={styles.agent}
                onPress={() => savePreference({
                  selectedAgents: checked
                    ? settings.selectedAgents.filter(selected => selected !== id)
                    : [...settings.selectedAgents, id],
                })}>
                <View style={[styles.check, checked && ui.primary]} aria-hidden>
                  {checked && <Text style={ui.primaryText}>✓</Text>}
                </View>
                <View style={styles.agentDetails}>
                  <Text style={ui.label}>{label}</Text>
                  <Text style={ui.muted}>{description}</Text>
                </View>
              </Pressable>
            );
          })}
          <Text style={ui.muted}>選択は次フェーズのセッション作成で使われます（この版では作成はまだできません）。</Text>
        </View>

        <View style={ui.card}>
          <Text accessibilityRole="header" style={ui.title}>表示スタイル</Text>
          <View style={styles.segmented}>
            {displayStyles.map(({ value, label }) => {
              const selected = settings.displayStyle === value;
              return (
                <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected }}
                  style={[ui.button, styles.segment, selected && ui.primary]}
                  onPress={() => savePreference({ displayStyle: value })}>
                  <Text style={selected ? ui.primaryText : ui.label}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={ui.card}>
          <Text accessibilityRole="header" style={ui.title}>会議IDで開く</Text>
          <TextInput accessibilityLabel="会議ID" style={styles.input}
            value={settings.meetingId} onChangeText={value => edit({ meetingId: value })}
            editable={!busy} autoCapitalize="none" autoCorrect={false} />
          <Pressable accessibilityRole="button" disabled={busy || !meetingId}
            style={[ui.button, ui.primary, (busy || !meetingId) && styles.disabled]}
            onPress={() => void saveConnection(true)}>
            <Text style={ui.primaryText}>開く</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { padding: 20 },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 16, gap: 16 },
  input: {
    minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12,
    fontSize: 16, color: colors.ink,
  },
  agent: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 8, minHeight: 48 },
  agentDetails: { flex: 1 },
  check: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: colors.teal,
    alignItems: 'center', justifyContent: 'center',
  },
  segmented: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1 },
  disabled: { opacity: 0.55 },
});
