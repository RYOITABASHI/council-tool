import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { CLI_PRESETS, DEFAULT_EXECUTION_BOUNDS, type CliSeatConfig } from '../drivers/index.js';

const executionBoundVars = {
  timeoutMs: 'COUNCIL_EXECUTION_TIMEOUT_MS',
  outputLimitBytes: 'COUNCIL_EXECUTION_OUTPUT_LIMIT_BYTES',
} as const;

function readBound(env: NodeJS.ProcessEnv, key: keyof typeof executionBoundVars): number {
  const name = executionBoundVars[key];
  const raw = env[name];
  if (raw === undefined || !raw.trim()) return DEFAULT_EXECUTION_BOUNDS[key];
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${JSON.stringify(raw)}`);
  }
  return value;
}

export function resolveExecutionBounds(env: NodeJS.ProcessEnv): { timeoutMs: number; outputLimitBytes: number } {
  return { timeoutMs: readBound(env, 'timeoutMs'), outputLimitBytes: readBound(env, 'outputLimitBytes') };
}

export function resolveCliConfigs(env: NodeJS.ProcessEnv): Record<'codex' | 'claude', CliSeatConfig> {
  const configs: Record<'codex' | 'claude', CliSeatConfig> = {
    codex: { kind: 'codex' },
    claude: { kind: 'claude' },
  };
  const bounds = resolveExecutionBounds(env);
  for (const kind of ['codex', 'claude'] as const) {
    const prefix = `COUNCIL_${kind.toUpperCase()}`;
    const command = env[`${prefix}_COMMAND`]?.trim();
    const args = env[`${prefix}_ARGS`]?.trim();
    if (command) configs[kind].command = command;
    // Arguments are whitespace-split with no quoting or escaping support.
    if (args) configs[kind].args = args.split(/\s+/);
    if (env[executionBoundVars.timeoutMs]?.trim()) configs[kind].timeoutMs = bounds.timeoutMs;
    if (env[executionBoundVars.outputLimitBytes]?.trim()) configs[kind].outputLimitBytes = bounds.outputLimitBytes;
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
