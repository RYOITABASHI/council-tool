import { Readable, Writable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { runCliSeat } from '../../src/drivers/index.js';
import { handcarryWebSeat } from '../../src/drivers/web-handcarry.js';

const seat = { meeting_id: 'meeting', round: 'R0', seat_id: 'seat' } as const;
const prompt = '判断が変わる条件を含めて回答してください。\n';
const answer = { body: '提案に賛成します。', claims: [{ statement: '採用', reversal_condition: '費用超過' }] };

test('closes CLI stdin and submits its structured stdout using the assigned seat', async () => {
  const submit = vi.fn(async () => ({ status: 'ok' }));
  const code = `
    const fs = require('node:fs');
    const prompt = fs.readFileSync(0, 'utf8');
    if (prompt !== process.argv[1]) process.exit(9);
    fs.writeSync(1, process.argv[2]);
  `;
  await runCliSeat({ ...seat, prompt, supersedes: 'old' }, {
    kind: 'codex', command: process.execPath,
    args: ['-e', code, prompt, JSON.stringify({ ...answer, seat_id: 'other' })],
  }, submit);
  expect(submit).toHaveBeenCalledExactlyOnceWith('council.submit_answer', {
    ...seat, supersedes: 'old', ...answer,
  });
});

test.each([
  ['自然文の回答。\n', { body: '自然文の回答。\n' }],
  ['```json\n{"body":"回答","claims":[]}\n```\n', { body: '回答', claims: [] }],
])('submits answer output %j', async (stdout, expected) => {
  const submit = vi.fn(async () => ({ status: 'ok' }));
  await runCliSeat({ ...seat, prompt }, {
    kind: 'antigravity', command: process.execPath,
    args: ['-e', "require('node:fs').writeSync(1, process.argv[1])", stdout],
  }, submit);
  expect(submit).toHaveBeenCalledExactlyOnceWith('council.submit_answer', { ...seat, ...expected });
});

test('reports an executable missing from PATH without submitting', async () => {
  const submit = vi.fn();
  await expect(runCliSeat({ ...seat, prompt }, {
    kind: 'claude', command: '/council-test/missing-cli', args: [],
  }, submit)).rejects.toThrow(/CLI executable not found.*missing-cli/);
  expect(submit).not.toHaveBeenCalled();
});

test('rejects a failed CLI even if it printed an answer', async () => {
  const submit = vi.fn();
  await expect(runCliSeat({ ...seat, prompt }, {
    kind: 'antigravity', command: process.execPath,
    args: ['-e', `
      const fs = require('node:fs');
      fs.writeSync(1, 'partial answer');
      fs.writeSync(2, 'stub failed');
      process.exitCode = 3;
    `],
  }, submit)).rejects.toThrow(/exit code 3.*stub failed/);
  expect(submit).not.toHaveBeenCalled();
});

test('displays the web prompt and transcribes pasted UTF-8 text verbatim', async () => {
  const body = '  Web 席の回答\r\n\n';
  const bytes = Buffer.from(body);
  const input = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
  let displayed = '';
  const output = new Writable({
    write(chunk, _encoding, done) { displayed += chunk.toString(); done(); },
  });
  const call = vi.fn(async () => ({ status: 'ok', attest_required: true }));
  await handcarryWebSeat({ ...seat, prompt }, call, input, output);
  expect(displayed).toContain(prompt);
  expect(call).toHaveBeenCalledExactlyOnceWith('council.transcribe_web_seat', { ...seat, body });
});
