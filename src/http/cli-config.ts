import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { CLI_PRESETS, type CliSeatConfig } from '../drivers/index.js';

export function resolveCliConfigs(env: NodeJS.ProcessEnv): Record<'codex' | 'claude', CliSeatConfig> {
  const configs: Record<'codex' | 'claude', CliSeatConfig> = {
    codex: { kind: 'codex' },
    claude: { kind: 'claude' },
  };
  for (const kind of ['codex', 'claude'] as const) {
    const prefix = `COUNCIL_${kind.toUpperCase()}`;
    const command = env[`${prefix}_COMMAND`]?.trim();
    const args = env[`${prefix}_ARGS`]?.trim();
    if (command) configs[kind].command = command;
    // Arguments are whitespace-split with no quoting or escaping support.
    if (args) configs[kind].args = args.split(/\s+/);
  }
  return configs;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function assertCliCommandsResolvable(
  env: NodeJS.ProcessEnv,
  configs: ReturnType<typeof resolveCliConfigs>,
): void {
  const pathEntries = env.PATH?.split(delimiter) ?? [];
  const kinds = env.COUNCIL_CLAUDE_COMMAND?.trim() ? ['codex', 'claude'] as const : ['codex'] as const;
  for (const kind of kinds) {
    const command = configs[kind].command ?? CLI_PRESETS[kind].command;
    const candidates = command.includes('/') ? [command] : pathEntries.map(entry => join(entry, command));
    if (!candidates.some(isExecutableFile)) {
      throw new Error(`CLI command for kind "${kind}" is not resolvable on PATH: ${command}`);
    }
  }
}
