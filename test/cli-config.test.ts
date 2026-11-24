import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { assertCliCommandsResolvable, resolveCliConfigs, resolveExecutionBounds } from '../src/http/cli-config.js';

const bareConfigs = {
  codex: { kind: 'codex' },
  claude: { kind: 'claude' },
};

test('resolves bare configs when no overrides are set', () => {
  expect(resolveCliConfigs({})).toEqual(bareConfigs);
});

test('resolves command and argument overrides for both CLI kinds', () => {
  expect(resolveCliConfigs({
    COUNCIL_CODEX_COMMAND: 'codex_exec',
    COUNCIL_CODEX_ARGS: '--skip-git-repo-check -',
    COUNCIL_CLAUDE_COMMAND: '/opt/bin/claude',
    COUNCIL_CLAUDE_ARGS: '-p --verbose',
  })).toEqual({
    codex: { kind: 'codex', command: 'codex_exec', args: ['--skip-git-repo-check', '-'] },
    claude: { kind: 'claude', command: '/opt/bin/claude', args: ['-p', '--verbose'] },
  });
});

test('omits overrides for empty and whitespace-only environment values', () => {
  expect(resolveCliConfigs({
    COUNCIL_CODEX_COMMAND: '',
    COUNCIL_CODEX_ARGS: ' \t ',
    COUNCIL_CLAUDE_COMMAND: ' \n ',
    COUNCIL_CLAUDE_ARGS: '',
  })).toEqual(bareConfigs);
});

test('splits arguments on runs of whitespace', () => {
  const configs = resolveCliConfigs({ COUNCIL_CODEX_ARGS: '  --skip-git-repo-check\t \n-  ' });
  expect(configs.codex).not.toHaveProperty('command');
  expect(configs.codex.args).toEqual(['--skip-git-repo-check', '-']);
});

test('reports the kind and command for an unresolvable Codex executable', () => {
  const env = { PATH: dirname(process.execPath), COUNCIL_CODEX_COMMAND: 'missing-council-codex' };
  expect(() => assertCliCommandsResolvable(env, resolveCliConfigs(env)))
    .toThrow('CLI command for kind "codex" is not resolvable on PATH: missing-council-codex');
});

test('resolves node on PATH without requiring the default Claude executable', () => {
  const bin = mkdtempSync(join(tmpdir(), 'council-cli-config-'));
  try {
    symlinkSync(process.execPath, join(bin, 'node'));
    const env = { PATH: bin, COUNCIL_CODEX_COMMAND: 'node' };
    expect(() => assertCliCommandsResolvable(env, resolveCliConfigs(env))).not.toThrow();
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('validates an explicitly configured Claude command', () => {
  const env = {
    PATH: dirname(process.execPath),
    COUNCIL_CODEX_COMMAND: 'node',
    COUNCIL_CLAUDE_COMMAND: 'missing-council-claude',
  };
  expect(() => assertCliCommandsResolvable(env, resolveCliConfigs(env)))
    .toThrow('CLI command for kind "claude" is not resolvable on PATH: missing-council-claude');
});

test('checks a command with a slash directly and rejects directories', () => {
  const env = { COUNCIL_CODEX_COMMAND: process.execPath };
  expect(() => assertCliCommandsResolvable(env, resolveCliConfigs(env))).not.toThrow();

  const directoryEnv = { COUNCIL_CODEX_COMMAND: dirname(process.execPath) };
  expect(() => assertCliCommandsResolvable(directoryEnv, resolveCliConfigs(directoryEnv))).toThrow();
});

test('applies execution bounds to both CLI kinds', () => {
  expect(resolveCliConfigs({
    COUNCIL_EXECUTION_TIMEOUT_MS: '2500',
    COUNCIL_EXECUTION_OUTPUT_LIMIT_BYTES: '2048',
  })).toEqual({
    codex: { kind: 'codex', timeoutMs: 2500, outputLimitBytes: 2048 },
    claude: { kind: 'claude', timeoutMs: 2500, outputLimitBytes: 2048 },
  });
});

test('defaults execution bounds and omits blank overrides', () => {
  expect(resolveExecutionBounds({})).toEqual({ timeoutMs: 600000, outputLimitBytes: 4194304 });
  expect(resolveCliConfigs({
    COUNCIL_EXECUTION_TIMEOUT_MS: ' ',
    COUNCIL_EXECUTION_OUTPUT_LIMIT_BYTES: '',
  })).toEqual(bareConfigs);
});

test.each(['COUNCIL_EXECUTION_TIMEOUT_MS', 'COUNCIL_EXECUTION_OUTPUT_LIMIT_BYTES']
  .flatMap(name => ['abc', '0', '-5', '1.5', '9007199254740993'].map(value => [name, value] as const)))(
  'rejects invalid %s value %s', (name, value) => {
    expect(() => resolveCliConfigs({ [name]: value })).toThrow(`${name} must be a positive integer: "${value}"`);
  },
);
