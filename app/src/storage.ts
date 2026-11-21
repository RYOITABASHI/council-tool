import AsyncStorage from '@react-native-async-storage/async-storage';

export type DisplayStyle = 'line' | 'slack';

export const AGENT_PRESETS: { id: string; label: string; description: string }[] = [
  { id: 'codex-cli', label: 'Codex (CLI)', description: 'サブスクリプションの Codex CLI 席' },
  { id: 'claude-code-cli', label: 'Claude Code (CLI)', description: 'サブスクリプションの Claude Code CLI 席' },
  { id: 'api', label: 'API席', description: 'API キーで接続する席' },
  { id: 'local', label: 'ローカル席', description: '端末上のローカルモデル席' },
];

export const displayStyles = [
  { value: 'line', label: 'ライン風' },
  { value: 'slack', label: 'スレッド風' },
] as const;

export interface Settings {
  facadeUrl: string;
  token: string;
  meetingId: string;
  displayStyle: DisplayStyle;
  selectedAgents: string[];
}

const SETTINGS_KEY = 'council.settings';
const defaultAgentIds = ['codex-cli', 'claude-code-cli'];
function defaultSettings(): Settings {
  return { facadeUrl: '', token: '', meetingId: '', displayStyle: 'line', selectedAgents: [...defaultAgentIds] };
}

async function readSettings(): Promise<Settings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultSettings();
    const settings = value as Record<string, unknown>;
    return {
      facadeUrl: typeof settings.facadeUrl === 'string' ? settings.facadeUrl : '',
      token: typeof settings.token === 'string' ? settings.token : '',
      meetingId: typeof settings.meetingId === 'string' ? settings.meetingId : '',
      displayStyle: settings.displayStyle === 'slack' ? 'slack' : 'line',
      selectedAgents: Array.isArray(settings.selectedAgents)
        ? settings.selectedAgents.filter((id): id is string =>
          AGENT_PRESETS.some(preset => preset.id === id))
        : [...defaultAgentIds],
    };
  } catch {
    return defaultSettings();
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    await pendingWrite;
    return await readSettings();
  } catch {
    return defaultSettings();
  }
}

let pendingWrite: Promise<void> = Promise.resolve();

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  const write = pendingWrite.then(async () => {
    const settings = await readSettings();
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, ...patch }));
  });
  pendingWrite = write.catch(() => undefined);
  return write;
}
