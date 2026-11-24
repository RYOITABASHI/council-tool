import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createCore } from '../src/core/index.js';
import { CliExecutionError, getSeatInput } from '../src/drivers/index.js';
import { HostRunner } from '../src/http/host-runner.js';
import type { Round } from '../src/core/types.js';
import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';

installXattrTestTransport();
guardStoreLinks();
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const principal = 'operator';
const overview = 'observer';
const clock = { epoch: 'reconciliation-test', now: () => ({ wall: 1_800_000_000_000_000_000n, monotonic: 0n }) };
const seats = ['a', 'b', 'optional'];
const synthesis = {
  agreements: [], minority_opinions: [], reversal_conditions: [],
  recommendation: 'Use a pilot.', cited_materials: [], unverified_items: [], missing_records: [],
};
const mentionText = 'How would you measure the pilot?';

async function fixture(
  options: Parameters<typeof createCore>[0] = {},
  seatIds = seats,
  topic = 'Pilot',
) {
  const core = createCore({
    isHuman: id => id === principal || id === overview,
    clock,
    ...options,
  });
  const { meeting_id } = await core.create_meeting(principal, {
    topic, chair: { principal }, human_participants: [overview], seats: seatIds.map(seat_id => ({
      seat_id, principal, connection: 'cli', role: 'codex-cli', optional: seat_id === 'optional',
    })),
  });
  return { core, meeting_id };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function pipeline(...args: Parameters<typeof fixture>) {
  const { core, meeting_id } = await fixture(...args);
  cleanups.push(() => core.close());
  const failGate = { result: 'fail', unresolved_points: ['Scope'], next_round_scope: ['Scope'] };
  const calls = new Map<string, number>();
  const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
  const execute = vi.fn(async (_config, prompt: string) => {
    if (prompt.startsWith('Chair gate')) {
      count('gate');
      return '{"result":"pass"}';
    }
    if (prompt.startsWith('Chair synthesis')) {
      count('synthesis');
      return JSON.stringify(synthesis);
    }
    const [, round, seat] = /ラウンド: (R\d+) \/ 席: (\S+)/.exec(prompt)!;
    count(round + '/' + seat);
    return 'Answer from ' + seat;
  });
  const submit = async (round: Round, seat_id: string) => {
    count(round + '/' + seat_id);
    await core.submit_answer(principal, { meeting_id, round, seat_id, body: 'Answer from ' + seat_id });
  };
  const finishRound = async (round: Round, order = ['optional', 'a', 'b']) => {
    for (const seat of order) await submit(round, seat);
  };
  const open = (round: 'R0' | 'R1') => core.open_round(principal, { meeting_id, round });
  const gate = async (fail: boolean) => {
    count('gate');
    await core.chair_gate(principal, { meeting_id, ...(fail ? failGate : { result: 'pass' }) });
  };
  const synthesize = async () => {
    count('synthesis');
    await core.synthesize(principal, { meeting_id, body: synthesis });
  };
  const mention = async () => {
    const { round_state } = await core.open_round(principal, {
      meeting_id, mention: { seat_id: 'a', text: mentionText },
    });
    await core.post_message(principal, { meeting_id, body: { text: 'An unrelated note at the same time.' } });
    return round_state.round;
  };
  const waive = (round: Round, seat_id: string) => core.waive_seat(principal, {
    meeting_id, round, seat_id, reason_code: 'chair_judgment', reason_note: 'Human directed this round to a.',
  });
  const snapshot = () => core.get_state(principal, { meeting_id });
  const packets = async () => (await core.get_packets(overview, {
    meeting_id, view: 'oversight', caller_seat_id: 'human',
  })).new_packets.map(({ packet }) => packet);
  const fresh = () => new HostRunner(() => core, principal, execute);
  return { core, meeting_id, calls, snapshot, packets, fresh, execute, open, gate, synthesize, mention, waive, finishRound, submit };
}

const cuts = [
  'mid-R0', 'frozen R0', 'before gate commit', 'after gate pass', 'after gate fail',
  'before synthesis commit', 'after synthesis commit', 'partial mention waivers', 'all mention waivers',
  'after addressed answer', 'addressed answer before last waiver', 'open R2', 'frozen R2', 'mention after prior synthesis',
] as const;

test.each(cuts)('reconciles and continues at %s', async cut => {
  const p = await pipeline(undefined, cut === 'mid-R0' ? ['optional', 'b'] : seats);
  await p.open('R0');
  const isMention = cut.includes('mention') || cut.includes('addressed answer');
  if (cut === 'mid-R0') {
    await p.submit('R0', 'optional');
  } else {
    await p.finishRound('R0');
    if (cut !== 'frozen R0' && (!isMention || cut === 'mention after prior synthesis')) {
      await p.open('R1');
      await p.finishRound('R1');
      if (cut !== 'before gate commit') {
        await p.gate(cut === 'after gate fail' || cut === 'open R2' || cut === 'frozen R2');
        if (cut === 'open R2') await p.submit('R2', 'optional');
        if (cut === 'frozen R2') await p.finishRound('R2');
        if (cut === 'after synthesis commit' || cut === 'mention after prior synthesis') await p.synthesize();
      }
    }
  }
  if (isMention) {
    const round = await p.mention();
    await p.waive(round, 'b');
    if (cut === 'all mention waivers' || cut === 'after addressed answer') await p.waive(round, 'optional');
    if (cut.includes('addressed answer')) await p.submit(round, 'a');
  }

  const state = await p.snapshot();
  const before = await p.packets();
  const runner = p.fresh();
  if (cut === 'mid-R0') {
    expect(state.reception_table.filter(row => row.round === 'R0').map(({ seat_id, state }) => [seat_id, state]))
      .toEqual(expect.arrayContaining([['optional', 'received'], ['b', 'pending']]));
    expect(state.reception_table.filter(row => row.round === 'R0')).toHaveLength(2);
  }
  const snapshotReads = vi.spyOn(p.core, 'snapshotState');
  await runner.reconcile([p.meeting_id]);
  expect(snapshotReads).toHaveBeenCalledExactlyOnceWith(principal, { meeting_id: p.meeting_id });
  snapshotReads.mockRestore();
  // Read the recorded state directly because status() would classify even if reconcile() did nothing.
  const first = runner['states'].get(p.meeting_id)!;
  expect(first.phase).toBe(cut === 'after synthesis commit' ? 'awaiting_approval' : 'interrupted');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(first.updated_at).getTime() + 1000);
  await runner.reconcile([p.meeting_id]);
  expect(await runner.status(p.meeting_id)).toEqual(first);
  expect(p.execute).not.toHaveBeenCalled();
  expect(await p.snapshot()).toEqual(state);
  expect(await p.packets()).toEqual(before);

  if (cut === 'after synthesis commit') {
    await expect(runner.resume(p.meeting_id)).rejects.toEqual({
      code: 'invalid_state', detail: { meeting_state: 'AWAITING_APPROVAL' },
    });
    expect(p.execute).not.toHaveBeenCalled();
  } else {
    expect((await runner.resume(p.meeting_id)).phase).toBe('running');
    await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({ phase: 'awaiting_approval', detail: null }));
  }
  expect((await p.snapshot()).meeting_state).toBe('AWAITING_APPROVAL');
  const after = await p.packets();
  expect(after).toEqual(expect.arrayContaining(before));
  const answerKeys = after.flatMap(({ header }) => header.kind === 'answer' || header.kind === 'critique'
    ? [header.round + '/' + header.seat_id] : []);
  expect(answerKeys).toHaveLength(new Set(answerKeys).size);
  expect(new Map(answerKeys.map(key => [key, 1]))).toEqual(
    new Map([...p.calls].filter(([key]) => key.includes('/'))),
  );
  expect(p.calls.get('gate') ?? 0).toBe(isMention && cut !== 'mention after prior synthesis' ? 0 : 1);
  expect(p.calls.get('synthesis')).toBe(cut === 'mention after prior synthesis' ? 2 : 1);
  if (cut === 'mid-R0') {
    const reference = await pipeline(undefined, ['optional', 'b']);
    const uninterrupted = reference.fresh();
    await uninterrupted.start(reference.meeting_id);
    await vi.waitFor(async () => expect((await uninterrupted.status(reference.meeting_id)).phase).toBe('awaiting_approval'));
    expect((await p.snapshot()).meeting_state).toBe((await reference.snapshot()).meeting_state);
    const committedRecord = (packets: typeof after) => packets.map(packet => {
      const { kind, round, seat_id } = packet.header;
      const body = 'unverified_items' in packet.body ? {
        ...packet.body,
        unverified_items: packet.body.unverified_items.map(({ packet_id, ...item }) => ({
          ...item, packet_index: packets.findIndex(({ header }) => header.packet_id === packet_id),
        })),
      } : packet.body;
      return { kind, round, seat_id, body };
    });
    expect(committedRecord(after)).toEqual(committedRecord(await reference.packets()));
  }
  if (isMention && !cut.includes('addressed answer')) {
    expect(p.execute.mock.calls[0][1]).toContain(mentionText);
  }
});

test('reports a failed seat run as interrupted and resumes on the same runner', async () => {
  const p = await pipeline();
  p.execute.mockRejectedValueOnce(new Error('seat interrupted'));
  const runner = p.fresh();
  await runner.start(p.meeting_id);
  const expected = {
    phase: 'interrupted',
    detail: expect.stringContaining('seat_driver_error: optional failed in R0'),
  };
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject(expected));
  const interrupted = await runner.status(p.meeting_id);
  expect(interrupted.detail).toContain('OPEN (R0 open)');
  await runner.reconcile([p.meeting_id]);
  expect(runner['states'].get(p.meeting_id)).toEqual(interrupted);
  expect(await runner.status(p.meeting_id)).toEqual(interrupted);
  await runner.resume(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id))
    .toMatchObject({ phase: 'awaiting_approval', detail: null }));
  expect((await p.snapshot()).meeting_state).toBe('AWAITING_APPROVAL');
});

test('resume delivers new input without redelivering input acknowledged with an answer', async () => {
  const acked = 'ACKED_AGENDA_4F8C';
  const unread = 'UNREAD_NOTE_6D2A';
  const p = await pipeline(undefined, seats, acked);
  p.execute.mockImplementationOnce(async (_config, prompt) => {
    expect(prompt).toContain(acked);
    return 'Answer from optional';
  }).mockRejectedValueOnce(new Error('interrupted'));
  const first = p.fresh();
  await first.start(p.meeting_id);
  await vi.waitFor(async () => expect(await first.status(p.meeting_id)).toMatchObject({
    phase: 'interrupted', detail: expect.stringContaining('seat_driver_error: a failed in R0'),
  }));
  expect((await p.snapshot()).reception_table).toContainEqual(expect.objectContaining({
    round: 'R0', seat_id: 'optional', state: 'received',
  }));
  await p.core.post_message(principal, { meeting_id: p.meeting_id, body: { text: unread } });

  p.execute.mockClear();
  const runner = p.fresh();
  await runner.reconcile([p.meeting_id]);
  await runner.resume(p.meeting_id);
  await vi.waitFor(async () => expect((await runner.status(p.meeting_id)).phase).toBe('awaiting_approval'));

  const resumedPrompts = p.execute.mock.calls.map(([, prompt]) => prompt);
  const optional = resumedPrompts.filter(prompt => prompt.includes('ラウンド: R1 / 席: optional'));
  expect(optional).toHaveLength(1);
  expect(optional[0]).toContain(unread);
  expect(optional[0]).not.toContain(acked);
  const pending = resumedPrompts.find(prompt => prompt.includes('ラウンド: R0 / 席: a'));
  expect(pending).toContain(acked);
  expect(pending).toContain(unread);
});

test('retries a lost seat execution and commits one answer', async () => {
  const p = await pipeline();
  p.execute.mockRejectedValueOnce(new Error('seat interrupted'));
  const first = p.fresh();
  await first.start(p.meeting_id);
  await vi.waitFor(async () => expect((await first.status(p.meeting_id)).phase).toBe('interrupted'));
  const runner = p.fresh();
  await runner.reconcile([p.meeting_id]);
  await runner.resume(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({ phase: 'awaiting_approval', detail: null }));
  expect(p.execute.mock.calls.filter(([, prompt]) => prompt.includes('ラウンド: R0 / 席: optional'))).toHaveLength(2);
  expect((await p.packets()).filter(({ header }) => header.round === 'R0' && header.seat_id === 'optional')).toHaveLength(1);
});

test('acknowledged input stays acknowledged across a fresh core and runner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'council-reconcile-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const { core, meeting_id } = await fixture({ home });
  const assignment = { meeting_id, round: 'R0', seat_id: 'optional' } as const;
  try {
    const first = new HostRunner(() => core, principal, async () => 'Answer');
    const input = await getSeatInput(assignment, (op, args) => core.dispatch(op, args, principal));
    expect(input.packets.map(({ header }) => header.kind)).toEqual(['agenda']);
    await input.acknowledge();
    expect((await first.status(meeting_id)).phase).toBe('idle');
  } finally {
    core.close();
  }
  const reopened = createCore({ home, isHuman: id => id === principal || id === overview,
    clock,
  });
  cleanups.push(() => reopened.close());
  const runner = new HostRunner(() => reopened, principal);
  await runner.reconcile([meeting_id]);
  const fresh = await getSeatInput(assignment, (op, args) => reopened.dispatch(op, args, principal));
  expect(fresh.packets).toEqual([]);
});

test('commits the input receipt with the answer even if the runner stops before another seat submits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'council-answer-receipt-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const { core, meeting_id } = await fixture({ home });
  try {
    const execute = vi.fn().mockResolvedValueOnce('Optional answer').mockRejectedValueOnce(new Error('interrupted'));
    const first = new HostRunner(() => core, principal, execute);
    const readPackets = vi.spyOn(core, 'get_packets');
    await first.start(meeting_id);
    await vi.waitFor(async () => expect((await first.status(meeting_id)).phase).toBe('interrupted'), { timeout: 10_000 });
    expect(readPackets.mock.calls).toHaveLength(2);
    expect(readPackets.mock.calls.every(([, args]) => !Object.hasOwn(args as object, 'ack_packet_ids'))).toBe(true);
  } finally {
    core.close();
  }
  const reopened = createCore({ home, isHuman: id => id === principal, clock });
  cleanups.push(() => reopened.close());
  const runner = new HostRunner(() => reopened, principal);
  await runner.reconcile([meeting_id]);
  expect((await runner.status(meeting_id)).phase).toBe('interrupted');
  const input = await getSeatInput({ meeting_id, round: 'R0', seat_id: 'optional' },
    (op, args) => reopened.dispatch(op, args, principal));
  expect(input.packets.map(({ header }) => header.kind)).toEqual(['answer']);
});

test.each(['execution_timeout', 'unparseable_output'] as const)('waives a mandatory seat for %s', async disposition => {
  const p = await pipeline();
  const healthy = p.execute.getMockImplementation()!;
  p.execute.mockImplementation(async (config, prompt) => {
    if (!prompt.includes('ラウンド: R0 / 席: a\n')) return healthy(config, prompt);
    if (disposition === 'execution_timeout') throw new CliExecutionError(disposition, 'x'.repeat(250));
    return '{"body":';
  });
  const runner = p.fresh();
  await runner.start(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({
    phase: 'awaiting_approval',
  }));
  const snapshot = await p.snapshot();
  expect(snapshot.meeting_state).toBe('AWAITING_APPROVAL');
  expect(snapshot.round_states).toContainEqual(expect.objectContaining({ round: 'R0', phase: 'frozen' }));
  expect(snapshot.reception_table).toContainEqual(expect.objectContaining({
    round: 'R0', seat_id: 'a', state: 'waived',
    reason: disposition === 'execution_timeout' ? { code: disposition, text: 'x'.repeat(200) } :
      expect.objectContaining({ code: disposition }),
  }));
  expect((await p.packets()).map(packet => packet.header)).not.toContainEqual(expect.objectContaining({
    kind: 'answer', round: 'R0', seat_id: 'a',
  }));
});

test('tolerates an invalid_state race on the disposition waiver and completes after resume', async () => {
  const p = await pipeline();
  const healthy = p.execute.getMockImplementation()!;
  p.execute.mockImplementation(async (config, prompt) => {
    if (!prompt.includes('ラウンド: R0 / 席: a\n')) return healthy(config, prompt);
    throw new CliExecutionError('execution_timeout', 'Timed out');
  });
  // Simulate the seat being resolved between the runner's state read and its
  // waiver: the first waive_seat for seat a in R0 reports invalid_state
  // without applying anything; later calls delegate to the real core.
  const realWaive = p.core.waive_seat;
  let waiveAttempts = 0;
  vi.spyOn(p.core, 'waive_seat').mockImplementation(async (principalArg, args) => {
    const a = args as { round?: string; seat_id?: string };
    if (a.round === 'R0' && a.seat_id === 'a') {
      waiveAttempts += 1;
      if (waiveAttempts === 1) throw { code: 'invalid_state' };
    }
    return realWaive(principalArg, args);
  });
  const runner = p.fresh();
  await runner.start(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({
    phase: 'interrupted', detail: expect.stringContaining('barrier_not_reached'),
  }));
  expect(waiveAttempts).toBe(1);
  const midway = await p.snapshot();
  expect(midway.round_states).toContainEqual(expect.objectContaining({ round: 'R0', phase: 'open' }));
  expect(midway.reception_table).toContainEqual(expect.objectContaining({
    round: 'R0', seat_id: 'a', state: 'pending',
  }));
  // The swallowed invalid_state must not abort the round pass: seats ordered
  // after 'a' were still executed in the same pass.
  expect(midway.reception_table).toContainEqual(expect.objectContaining({
    round: 'R0', seat_id: 'b', state: 'received',
  }));
  expect(midway.reception_table).toContainEqual(expect.objectContaining({
    round: 'R0', seat_id: 'optional', state: 'received',
  }));
  await runner.resume(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({
    phase: 'awaiting_approval', detail: null,
  }));
  expect(waiveAttempts).toBe(2);
  const snapshot = await p.snapshot();
  expect(snapshot.meeting_state).toBe('AWAITING_APPROVAL');
  expect(snapshot.round_states).toContainEqual(expect.objectContaining({ round: 'R0', phase: 'frozen' }));
  expect(snapshot.reception_table).toContainEqual(expect.objectContaining({
    round: 'R0', seat_id: 'a', state: 'waived',
    reason: expect.objectContaining({ code: 'execution_timeout' }),
  }));
});

test('reports a chair gate timeout as interrupted and resumes', async () => {
  const p = await pipeline();
  const healthy = p.execute.getMockImplementation()!;
  p.execute.mockImplementation(async (config, prompt) => {
    if (prompt.startsWith('Chair gate')) throw new CliExecutionError('execution_timeout', 'Timed out');
    return healthy(config, prompt);
  });
  const runner = p.fresh();
  await runner.start(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({
    phase: 'interrupted',
    detail: expect.stringContaining('chair_driver_error: the gate call failed (execution_timeout: Timed out)'),
  }));
  p.execute.mockImplementation(healthy);
  await runner.resume(p.meeting_id);
  await vi.waitFor(async () => expect(await runner.status(p.meeting_id)).toMatchObject({
    phase: 'awaiting_approval', detail: null,
  }));
  expect((await p.snapshot()).meeting_state).toBe('AWAITING_APPROVAL');
});
