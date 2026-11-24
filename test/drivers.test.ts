import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { CliExecutionError, runCli, runCliSeat, type CliSeatConfig, type ToolCaller } from '../src/drivers/index.js';

const hanging = 'setInterval(() => {}, 1000)';
function node(script: string, bounds: Partial<CliSeatConfig> = {}, args: string[] = []) {
  return runCli({ kind: 'codex', command: process.execPath, args: ['-e', script, ...args], ...bounds }, '');
}

test('times out a hanging CLI promptly when it responds to SIGTERM', async () => {
  const start = performance.now();
  await expect(node(hanging, { timeoutMs: 200 })).rejects.toMatchObject({ disposition: 'execution_timeout' });
  expect(performance.now() - start).toBeLessThan(4000);
});

test('terminates the CLI process group, including the spawned child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'council-cli-group-'));
  const pidFile = join(dir, 'pid');
  try {
    await expect(node(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(hanging)}], { stdio: 'ignore' });
      // Keep the parent alive long enough to reap the child after group SIGTERM.
      process.on('SIGTERM', () => {});
      child.on('exit', () => process.exit());
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      ${hanging};
    `, { timeoutMs: 3500 }, [pidFile])).rejects.toMatchObject({ disposition: 'execution_timeout' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('escalates to SIGKILL after the grace period if the CLI ignores SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'council-cli-kill-'));
  const pidFile = join(dir, 'pid');
  try {
    const start = performance.now();
    await expect(node(`
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      process.on('SIGTERM', () => {});
      ${hanging};
    `, { timeoutMs: 3500 }, [pidFile])).rejects.toMatchObject({ disposition: 'execution_timeout' });
    expect(performance.now() - start).toBeGreaterThanOrEqual(5000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }, { timeout: 2000, interval: 50 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test('rejects stdout overflow', async () => {
  await expect(node("require('node:fs').writeSync(1, 'x'.repeat(100 * 1024))", { outputLimitBytes: 1024 }))
    .rejects.toMatchObject({ disposition: 'output_overflow' });
});

test('classifies a missing executable as an execution error', async () => {
  const command = 'missing-council-cli-xyz123';
  const result = runCli({ kind: 'codex', command }, '');
  await expect(result).rejects.toBeInstanceOf(CliExecutionError);
  await expect(result).rejects.toMatchObject({
    disposition: 'execution_error', message: `CLI executable not found or working directory missing: ${command}`,
  });
});

test('classifies nonzero exit and retains only the last 4096 stderr bytes', async () => {
  await expect(node("require('node:fs').writeSync(2, 'prefix' + 'x'.repeat(4096)); process.exit(3)"))
    .rejects.toMatchObject({
      disposition: 'execution_error', message: `${process.execPath} failed with exit code 3: ${'x'.repeat(4096)}`,
    });
});

test('returns successful stdout verbatim', async () => {
  await expect(node("require('node:fs').writeSync(1, 'Just a plain answer.\\n')")).resolves.toBe('Just a plain answer.\n');
});

function seat(stdout: string) {
  const call = vi.fn<ToolCaller>().mockResolvedValue({});
  const assignment = { meeting_id: 'meeting', round: 'R0', seat_id: 'a' } as const;
  const result = runCliSeat({ ...assignment, prompt: 'prompt' }, { kind: 'codex' }, call, async () => stdout);
  return { assignment, call, result };
}

test.each(['{"body":', '{"body": 42}', '```json\n{"body":"Hi"}', '{}', '{"body":"Hi","claims":[{"statement":42}]}'])(
  'rejects malformed envelope %j before submission', async stdout => {
    const { call, result } = seat(stdout);
    await expect(result).rejects.toMatchObject({ disposition: 'unparseable_output' });
    expect(call).not.toHaveBeenCalled();
  },
);

test.each([
  ['  Just a plain answer.\n', { body: '  Just a plain answer.\n' }],
  ['{"body":"Hi","claims":[{"statement":"S","reversal_condition":null}]}',
    { body: 'Hi', claims: [{ statement: 'S', reversal_condition: null }] }],
  ['```JSON\n{"body":"Hi"}\n```', { body: 'Hi' }],
  ['```json5\n{"body":"Hi"}\n```', { body: '```json5\n{"body":"Hi"}\n```' }],
  ['```jsonl\n{"body":"Hi"}\n```', { body: '```jsonl\n{"body":"Hi"}\n```' }],
] as const)('submits valid output %j', async (stdout, answer) => {
  const { assignment, call, result } = seat(stdout);
  await result;
  expect(call).toHaveBeenCalledExactlyOnceWith('council.submit_answer', { ...assignment, ...answer });
});

test('keeps empty output a plain error and submits nothing', async () => {
  const { call, result } = seat('');
  await expect(result).rejects.toThrow('CLI returned an empty answer');
  expect(await result.catch(error => error.constructor)).toBe(Error);
  expect(call).not.toHaveBeenCalled();
});
