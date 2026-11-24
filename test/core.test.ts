import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { systemClock } from '../src/core/clock.js';
import { Core } from '../src/core/index.js';
import { FileStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';

installXattrTestTransport();
guardStoreLinks();
if (process.env.COUNCIL_STORE_NO_LINK === '1') vi.setConfig({ testTimeout: 60_000 });

const human = { id: 'chair-user', kind: 'human' } as const;
const seat = 'seat-user';
const draft = { agreements: [], minority_opinions: [], reversal_conditions: [],
  recommendation: null, cited_materials: [] };

async function meeting(connection: 'cli' | 'web' = 'cli', quota = 4) {
  const core = new Core();
  const { meeting_id } = await core.create_meeting(human, {
    topic: 'Topic', chair: { principal: human.id },
    seats: [{ seat_id: 'a', principal: seat, connection, quota }],
  });
  return { core, meeting_id };
}

it('uses the kernel boot ID as the system clock epoch when readable', (context) => {
  let bootId: string;
  try {
    bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return context.skip();
  }
  expect(bootId).not.toBe('');
  expect(systemClock.epoch).toBe(bootId);
});

describe('council core', () => {
  it('freezes both rounds, passes the gate and approves', async () => {
    const { core, meeting_id } = await meeting();
    for (const round of ['R0', 'R1']) {
      await core.open_round(human, { meeting_id, round });
      await core.submit_answer(seat, { meeting_id, round, seat_id: 'a', body: 'answer' });
      expect((await core.get_state(human, { meeting_id })).meeting_state).toBe('GATE');
    }
    await core.chair_gate(human, { meeting_id, result: 'pass' });
    await core.synthesize(human, { meeting_id, body: draft });
    expect(await core.approve(human, { meeting_id, decision: 'approve' }))
      .toMatchObject({ meeting_state: 'APPROVED' });
  });

  it('checks version before frozen state and returns both quota and freeze facts', async () => {
    const { core, meeting_id } = await meeting('cli', 1);
    const args = { meeting_id, round: 'R0', seat_id: 'a', body: 'answer' };
    await core.open_round(human, argsForRound(meeting_id));
    const { packet_id } = await core.submit_answer(seat, args);
    await expect(core.submit_answer(seat, args)).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(core.submit_answer(seat, { ...args, supersedes: packet_id })).rejects.toMatchObject({
      code: 'invalid_state', detail: { round_frozen: true, quota_exceeded: true },
    });
  });

  it('retranscribes only by superseding the invalidated version', async () => {
    const { core, meeting_id } = await meeting('web');
    const args = { meeting_id, round: 'R0', seat_id: 'a', body: 'answer' };
    await core.open_round(human, argsForRound(meeting_id));
    const first = await core.transcribe_web_seat(human, args);
    const attest = (id: string, result: string) => core.submit_attest(human, {
      meeting_id, target_packet_id: id, method: 'verbatim_confirm', result,
      evidence: { method: 'verbatim_confirm', confirmer: human.id, target_packet_id: id },
    });
    await attest(first.packet_id, 'mismatch');
    await expect(core.transcribe_web_seat(human, args)).rejects.toMatchObject({ code: 'invalid_argument' });
    const second = await core.transcribe_web_seat(human, { ...args, supersedes: first.packet_id });
    await attest(second.packet_id, 'confirmed');
    expect((await core.get_state(human, { meeting_id })).reception_table[0])
      .toMatchObject({ state: 'received', invalidated_packet_id: first.packet_id });
  });

  it('records waiver and delivers an absence notice once', async () => {
    const { core, meeting_id } = await meeting();
    await core.open_round(human, argsForRound(meeting_id));
    await core.waive_seat(human, { ...argsForRound(meeting_id), seat_id: 'a', reason_code: 'chair_judgment' });
    await core.open_round(human, { meeting_id, round: 'R1' });
    await core.declare_absent(human, { meeting_id, round: 'R1', seat_id: 'a' });
    const get = () => core.get_packets(seat, { meeting_id, caller_seat_id: 'a', round: 'R0' });
    expect((await get()).notices).toEqual([{ round: 'R1', seat_id: 'a', kind: 'absent', reason: 'chair_declared' }]);
    expect((await get()).notices).toEqual([]);
  });

  it('resolves every citation before rejecting an ineligible citation', async () => {
    const { core, meeting_id } = await meeting();
    const { packet_id } = await core.post_message(human, { meeting_id, body: { text: 'memo' } });
    const material_ref = 'packet:' + packet_id;
    const synthesize = (...refs: string[]) => core.synthesize(human, {
      meeting_id, body: { ...draft, cited_materials: refs.map(material_ref => ({ material_ref })) },
    });
    await expect(synthesize(material_ref, 'packet:missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(synthesize(material_ref, material_ref)).rejects.toEqual({
      code: 'invalid_state', detail: { meeting_state: 'CREATED', offending_materials: [material_ref] },
    });
  });
});

function argsForRound(meeting_id: string) {
  return { meeting_id, round: 'R0' };
}

describe('ordered processing and recovery', () => {
  const epoch = 1_700_000_000_000_000_000n;
  const second = 1_000_000_000n;
  const testSetup = {
    topic: 'Topic', chair: { principal: human.id },
    seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
  };

  it('puts equal-timestamp submissions ahead of a deadline sweep even when processed later', async () => {
    let ticks = 0n;
    const core = new Core({ clock: { now: () => ({ monotonic: ticks, wall: epoch + ticks }) } });
    try {
      const { meeting_id } = await core.create_meeting(human, {
        ...testSetup, round_settings: { R0: { deadline: { kind: 'relative', seconds: 1 } } },
      });
      await core.open_round(human, argsForRound(meeting_id));
      ticks = second;
      const submit = core.submit_answer(seat, { ...argsForRound(meeting_id), seat_id: 'a', body: 'on time' });
      ticks++;
      await submit;
      await core.sweep();
      expect((await core.get_state(human, { meeting_id })).reception_table[0].state).toBe('received');
    } finally {
      core.close();
    }
  });

  it('rejects a submission queued before the deadline but registered after it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'council-registration-'));
    let ticks = 0n;
    let lockAcquiredAt: bigint | undefined;
    class DelayedStore extends FileStore {
      override transaction<T>(work: () => T): T {
        return super.transaction(() => {
          ticks = lockAcquiredAt ?? ticks;
          return work();
        });
      }
    }
    const clock = { epoch: 'test', now: () => ({ monotonic: ticks, wall: epoch + ticks }) };
    const core = new Core({ store: new DelayedStore(home, clock), clock });
    try {
      const { meeting_id } = await core.create_meeting(human, testSetup);
      const round = argsForRound(meeting_id);
      await core.open_round(human, { ...round, deadline: { kind: 'relative', seconds: 1 } });
      ticks = second / 2n;
      lockAcquiredAt = 2n * second;
      await expect(core.submit_answer(seat, { ...round, seat_id: 'a', body: 'late' }))
        .rejects.toMatchObject({
          code: 'invalid_state',
          detail: { deadline_eligible: false, reception_state: 'absent', round_frozen: true },
        });
    } finally {
      core.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects both shared-store peers when the fallback clock has no epoch', () => {
    const home = mkdtempSync(join(tmpdir(), 'council-no-clock-epoch-'));
    try {
      for (const monotonic of [0n, 10n * second]) {
        const clock = { now: () => ({ monotonic, wall: epoch }) };
        expect.soft(() => {
          const peer = new Core({ home, clock });
          peer.close();
        }).toThrow('Shared council store requires a monotonic clock epoch');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an epochless injected store that exposes its transaction during load', () => {
    const home = mkdtempSync(join(tmpdir(), 'council-lazy-store-'));
    try {
      let opened: FileStore | undefined;
      const store: Store = {
        load() {
          opened ??= new FileStore(home, { epoch: 'test' });
          this.transaction = opened.transaction.bind(opened);
          return opened.load();
        },
        commit(changed, checkpoint) {
          opened!.commit(changed, checkpoint);
        },
      };
      expect(() => {
        const core = new Core({ store, clock: { now: () => ({ monotonic: 0n, wall: epoch }) } });
        core.close();
      }).toThrow('Shared council store requires a monotonic clock epoch');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([false, true])('rejects a load-time lock without an epoch (exposes transaction: %s)', exposes => {
    const home = mkdtempSync(join(tmpdir(), 'council-load-lock-'));
    const clock = { now: () => ({ monotonic: 0n, wall: epoch }) };
    const insideLock = vi.fn();
    const store: Store = {
      load() {
        // Exercise an untyped adapter that bypasses the constructor's TypeScript contract.
        const opened: FileStore = Reflect.construct(FileStore, [home, clock]);
        const loaded = opened.transaction(() => {
          insideLock();
          return opened.load();
        });
        if (exposes) this.transaction = opened.transaction.bind(opened);
        return loaded;
      },
      commit() {},
    };
    try {
      expect.soft(() => {
        const core = new Core({ store, clock });
        core.close();
      }).toThrow('Shared council store requires a monotonic clock epoch');
      expect(insideLock).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([false, true])('rejects a mismatched load-time lock (exposes transaction: %s)', exposes => {
    const home = mkdtempSync(join(tmpdir(), 'council-mismatched-load-lock-'));
    const backend = new FileStore(home, { epoch: 'backend' });
    const insideLock = vi.fn();
    const store: Store = {
      load() {
        const loaded = backend.transaction(() => {
          insideLock();
          return backend.load();
        });
        if (exposes) this.transaction = backend.transaction.bind(backend);
        return loaded;
      },
      commit() {},
    };
    try {
      expect.soft(() => {
        const core = new Core({ store, clock: {
          epoch: 'core', now: () => ({ monotonic: 0n, wall: epoch }),
        } });
        core.close();
      }).toThrow(/epoch.*match/i);
      expect(insideLock).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects non-string epochs before a transaction can run', () => {
    const home = mkdtempSync(join(tmpdir(), 'council-invalid-clock-epoch-'));
    const work = vi.fn();
    try {
      expect.soft(() => {
        const store: FileStore = Reflect.construct(FileStore, [home, { epoch: true }]);
        store.transaction(work);
      }).toThrow(/clock epoch/i);
      expect(work).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([true, 'different'])('rejects checkpoint epoch %s before locking or publishing', invalid => {
    const home = mkdtempSync(join(tmpdir(), 'council-invalid-checkpoint-epoch-'));
    const store = new FileStore(home, { epoch: 'test' });
    const transaction = vi.spyOn(store, 'transaction');
    try {
      const checkpoint = { monotonic: '0', wall: '0', position: 0, offset: '0', epoch: invalid };
      expect.soft(() => Reflect.apply(store.commit, store, [[], checkpoint])).toThrow(/epoch/i);
      expect.soft(transaction).not.toHaveBeenCalled();
      expect(store.load().checkpoint).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an epochless store that exposes its transaction during registration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'council-lazy-registration-'));
    const opened = new FileStore(home, { epoch: 'test' });
    const transaction = vi.spyOn(opened, 'transaction');
    const store: Store = {
      load: () => ({ meetings: [] }),
      commit: (changed, checkpoint) => opened.commit(changed, checkpoint),
    };
    const core = new Core({ store, clock: { now: () => ({ monotonic: 0n, wall: epoch }) } });
    try {
      const request = core.sweep();
      store.transaction = opened.transaction.bind(opened);
      await expect(request).rejects.toThrow('Shared council store requires a monotonic clock epoch');
      expect(transaction).not.toHaveBeenCalled();
      expect(opened.load().checkpoint).toBeUndefined();
    } finally {
      core.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an epochless store that opens its shared backend during commit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'council-lazy-commit-'));
    let transaction: ReturnType<typeof vi.spyOn<FileStore, 'transaction'>> | undefined;
    const store: Store = {
      load: () => ({ meetings: [] }),
      commit(changed, checkpoint) {
        const opened = new FileStore(home, { epoch: 'test' });
        transaction = vi.spyOn(opened, 'transaction');
        opened.commit(changed, checkpoint);
      },
    };
    const core = new Core({ store, clock: { now: () => ({ monotonic: 0n, wall: epoch }) } });
    try {
      await expect(core.create_meeting(human, testSetup))
        .rejects.toThrow('Shared council store requires a monotonic clock epoch');
      expect(transaction).not.toHaveBeenCalled();
      expect(new FileStore(home, { epoch: 'test' }).load().checkpoint).toBeUndefined();
    } finally {
      core.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('holds a live epoch until the owner closes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'council-live-epoch-'));
    vi.useFakeTimers();
    const clock = { epoch: 'a', now: () => ({ monotonic: 0n, wall: epoch }) };
    const before = new Core({ home, clock });
    const foreign = { ...clock, epoch: 'b' };
    const backend = new FileStore(home, foreign);
    const adapter: Store = {
      load: () => backend.load(),
      transaction: backend.transaction.bind(backend),
      commit: (changed, checkpoint) => backend.commit(changed, checkpoint),
    };
    const manifest = join(home, 'manifest.json');
    const attach = () => {
      const core = new Core({ store: adapter, clock: foreign });
      core.close();
    };
    try {
      const { meeting_id } = await before.create_meeting(human, testSetup);
      await vi.advanceTimersByTimeAsync(1250);
      const published = readFileSync(manifest, 'utf8');
      expect.soft(attach).toThrow(/live.*epoch/i);
      expect.soft(readFileSync(manifest, 'utf8')).toBe(published);
      await expect(before.get_state(human, { meeting_id })).resolves.toMatchObject({ meeting_state: 'CREATED' });
      before.close();
      expect(attach).not.toThrow();
      expect(backend.load().checkpoint?.epoch).toBe('b');
      expect(backend.load().meetings[0].id).toBe(meeting_id);
    } finally {
      before.close();
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([undefined, true, ''])('rejects corrupt persisted epoch %s without publishing', invalid => {
    const home = mkdtempSync(join(tmpdir(), 'council-corrupt-epoch-'));
    const clock = { epoch: 'test', now: () => ({ monotonic: 0n, wall: epoch }) };
    const backend = new FileStore(home, clock);
    const transaction = vi.spyOn(backend, 'transaction');
    const manifest = join(home, 'manifest.json');
    const corrupt = JSON.stringify({
      checkpoint: { monotonic: '0', wall: '0', position: 0, offset: '0', epoch: invalid },
      meetings: {},
    });
    writeFileSync(manifest, corrupt);
    try {
      expect.soft(() => new Core({ store: backend, clock }).close()).toThrow(/epoch/i);
      expect.soft(transaction).not.toHaveBeenCalled();
      expect.soft(existsSync(join(home, '.presence'))).toBe(false);
      expect(readFileSync(manifest, 'utf8')).toBe(corrupt);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([false, true])('shares the recovered deadline anchor across restarted peers (swept: %s)', async swept => {
    const home = mkdtempSync(join(tmpdir(), 'council-clock-restart-'));
    vi.useFakeTimers();
    const before = new Core({ home, clock: {
      epoch: 'before-restart',
      now: () => ({ monotonic: 10n * second, wall: epoch }),
    } });
    let writer: Core | undefined;
    let peer: Core | undefined;
    try {
      const { meeting_id } = await before.create_meeting(human, testSetup);
      const round = argsForRound(meeting_id);
      await before.open_round(human, { ...round, deadline: { kind: 'relative', seconds: 1 } });
      before.close();
      await vi.advanceTimersByTimeAsync(1000);

      let ticks = 0n;
      let wall = epoch + 15n * second;
      const clock = { epoch: 'after-restart', now: () => ({ monotonic: ticks, wall }) };
      writer = new Core({ home, clock });
      const observer = new FileStore(home, clock);
      const anchor = observer.load().checkpoint;
      ticks = second / 4n;
      wall = epoch + second / 4n; // A wall adjustment would shift an independently recovered anchor.
      peer = new Core({ home, clock });

      ticks = second;
      await writer.sweep();
      const atDeadline = observer.load();
      expect(atDeadline.checkpoint).toEqual(anchor);
      expect(atDeadline.meetings[0].rounds[0].rows[0].state).toBe('pending');
      ticks += second / 4n;
      if (swept) {
        await writer.sweep();
        expect(observer.load().meetings[0].rounds[0].rows[0].state).toBe('absent');
      }
      await expect(peer.submit_answer(seat, { ...round, seat_id: 'a', body: 'late' }))
        .rejects.toMatchObject({ code: 'invalid_state', detail: { deadline_eligible: false } });
      expect(anchor).toMatchObject({ epoch: clock.epoch, offset: String(10n * second) });
    } finally {
      before.close();
      writer?.close();
      peer?.close();
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a same-epoch offset change before a peer can sweep a deadline early', async () => {
    const home = mkdtempSync(join(tmpdir(), 'council-checkpoint-offset-'));
    let ticks = 0n;
    const clock = { epoch: 'test', now: () => ({ monotonic: ticks, wall: epoch + ticks }) };
    const owner = new Core({ home, clock });
    let peer: Core | undefined;
    try {
      const { meeting_id } = await owner.create_meeting(human, testSetup);
      const round = argsForRound(meeting_id);
      await owner.open_round(human, { ...round, deadline: { kind: 'relative', seconds: 1 } });
      expect((await owner.get_state(human, { meeting_id })).meeting_state).toBe('OPEN');

      const store = new FileStore(home, clock);
      const { checkpoint } = store.load();
      expect.soft(() => store.commit([], { ...checkpoint!, offset: String(2n * second) }))
        .toThrow(/checkpoint.*offset/i);
      expect.soft(store.load().checkpoint).toEqual(checkpoint);
      peer = new Core({ home, clock });
      await peer.sweep();
      expect.soft((await peer.get_state(human, { meeting_id })).meeting_state).toBe('OPEN');
      ticks = second + 1n;
      await peer.sweep();
      expect((await peer.get_state(human, { meeting_id })).meeting_state).toBe('GATE');
    } finally {
      peer?.close();
      owner.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(['immediate', 'queued', 'idle', 'hidden', 'preloaded'])('sweeps a closed peer’s deadline autonomously (%s activation)', async activation => {
    const home = mkdtempSync(join(tmpdir(), 'council-peer-deadline-'));
    vi.useFakeTimers();
    const clock = {
      epoch: 'test',
      now: () => {
        const monotonic = BigInt(Date.now()) * 1_000_000n;
        return { monotonic, wall: epoch + monotonic };
      },
    };
    const backend = new FileStore(home, clock);
    const adapter: Store = {
      load: () => backend.load(),
      hasChanges: () => backend.hasChanges(),
      commit: (changed, checkpoint) => backend.commit(changed, checkpoint),
    };
    if (activation === 'immediate') adapter.transaction = backend.transaction.bind(backend);
    const idle = new Core({ store: adapter, clock });
    const writer = new Core({ home, clock });
    try {
      if (activation === 'idle') adapter.transaction = backend.transaction.bind(backend);
      if (activation === 'queued') {
        const registration = idle.sweep();
        adapter.transaction = backend.transaction.bind(backend);
        await registration;
      }
      const { meeting_id } = await writer.create_meeting(human, testSetup);
      await writer.open_round(human, {
        ...argsForRound(meeting_id), deadline: { kind: 'relative', seconds: 1 },
      });
      writer.close();

      // Observe storage directly because a call to the idle core would itself sweep.
      const observer = new FileStore(home, clock);
      if (activation === 'preloaded') {
        backend.load();
        adapter.transaction = backend.transaction.bind(backend);
        expect(backend.hasChanges()).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(observer.load().meetings[0]?.rounds[0]?.rows[0]?.state).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(observer.load().meetings[0]?.rounds[0]?.rows[0]).toMatchObject({
        state: 'absent', reason: { code: 'deadline_no_submission' },
      });
    } finally {
      writer.close();
      idle.close();
      vi.useRealTimers();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retains sub-nanosecond absolute precision and does not move a deadline after a wall jump', async () => {
    let ticks = 0n;
    let wall = epoch;
    const core = new Core({ clock: { now: () => ({ monotonic: ticks, wall }) } });
    try {
      const { meeting_id } = await core.create_meeting(human, testSetup);
      wall += 1n;
      const at = '2023-11-14T22:13:20.0000000009Z';
      await expect(core.open_round(human, {
        ...argsForRound(meeting_id), deadline: { kind: 'absolute', at },
      })).rejects.toMatchObject({ code: 'invalid_argument' });
      const future = '2023-11-14T22:13:20.0000000011Z';
      await core.open_round(human, { ...argsForRound(meeting_id), deadline: { kind: 'absolute', at: future } });
      wall += second;
      expect((await core.get_state(human, { meeting_id })).round_states[0].deadline_at).toBe(future);
      ticks = 1n;
      expect((await core.get_state(human, { meeting_id })).reception_table[0].state).toBe('absent');
    } finally {
      core.close();
    }
  });

  it('resets delivery epochs on authority changes and validates partial updates atomically', async () => {
    const core = new Core();
    const { meeting_id } = await core.create_meeting(human, testSetup);
    const get = (p: string, ack_packet_ids?: string[], delivery_epoch?: number) => core.get_packets(p, {
      meeting_id, caller_seat_id: 'a',
      ...(ack_packet_ids ? { ack_packet_ids, delivery_epoch } : {}),
    });
    const initial = await get(seat);
    const packet = initial.new_packets[0];
    if (!('header' in packet)) throw new Error('Expected input packet');
    const ids = [packet.header.packet_id];
    expect((await get(seat, ids, 1)).new_packets).toEqual([]);
    await expect(core.update_setup(human, {
      meeting_id, seats: [{ seat_id: 'a', connection: 'web' }],
    })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect((await core.get_state(human, { meeting_id })).setup_version).toBe(1);
    await core.update_setup(human, {
      meeting_id, seats: [{ seat_id: 'a', connection: 'web', quota: 5, principal: 'new' }],
    });
    await expect(get(seat)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await get('new', ids, 1)).toMatchObject({
      setup_version: 2, delivery_epoch: 2, new_packets: [packet],
    });
  });

  it('persists atomic reopen and restores frozen missing records', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'council-core-'));
    let core = new Core({ home });
    try {
      const { meeting_id } = await core.create_meeting(human, testSetup);
      const ids: string[] = [];
      for (const round of ['R0', 'R1']) {
        await core.open_round(human, { meeting_id, round });
        const { packet_id } = await core.submit_answer(seat, {
          meeting_id, round, seat_id: 'a', body: 'answer',
          claims: [{ statement: '\u0085', reversal_condition: '\uFEFF' }],
        });
        ids.push(packet_id);
      }
      await core.chair_gate(human, { meeting_id, result: 'pass' });
      const { synthesis_packet } = await core.synthesize(human, { meeting_id, body: draft });
      expect(synthesis_packet.body.unverified_items).toEqual(ids.map(packet_id => ({
        seat_id: 'a', packet_id, source: 'core', state: 'received', missing: ['statement'],
      })));
      const reopened = await core.approve(human, { meeting_id, decision: 'reopen', reopen_points: ['A', 'B'] });
      core.close();
      core = new Core({ home });
      expect(await core.get_state(human, { meeting_id })).toMatchObject({ meeting_state: 'REJECTED' });
      expect(await core.get_state(human, { meeting_id: reopened.new_meeting_id })).toMatchObject({
        meeting_state: 'CREATED', reopens: meeting_id, setup_version: 1,
      });
      expect(await core.get_packets(human, { meeting_id, caller_seat_id: 'chair', view: 'oversight' }))
        .toMatchObject({ new_packets: expect.arrayContaining([expect.objectContaining({ missing_records: ['statement'] })]) });
    } finally {
      core.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

it('processes a tied deadline before the obsolete open-period timeout and flags the gate later', async () => {
  let monotonic = 0n;
  const second = 1_000_000_000n;
  const clock = { now: () => ({ monotonic, wall: 1_700_000_000_000_000_000n + monotonic }) };
  const core = new Core({ clock });
  try {
    const { meeting_id } = await core.create_meeting(human, {
      topic: 'Topic', chair: { principal: human.id }, meeting_timeout: 1,
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    await core.open_round(human, { ...argsForRound(meeting_id), deadline: { kind: 'relative', seconds: 1 } });
    monotonic = second + 1n;
    expect(await core.get_state(human, { meeting_id })).toMatchObject({
      meeting_state: 'GATE', timeout_exceeded: false,
      reception_table: [{ state: 'absent', reason: { code: 'deadline_no_submission' } }],
    });
    monotonic += second + 1n;
    expect(await core.get_state(human, { meeting_id })).toMatchObject({
      meeting_state: 'GATE', timeout_exceeded: true,
    });
  } finally {
    core.close();
  }
});

it('keeps the chair’s flash and note out of seat input until the barrier', async () => {
  const { core, meeting_id } = await meeting();
  try {
    const round = argsForRound(meeting_id);
    await core.open_round(human, round);
    const flash = await core.submit_flash(human, { ...round, seat_id: 'chair', body: 'idea', basis: 'topic' });
    const note = await core.post_message(human, { meeting_id, body: { text: 'note' } });
    const get = () => core.get_packets(seat, { meeting_id, caller_seat_id: 'a' });
    const visible = async () => (await get()).new_packets.flatMap(p => 'header' in p ? [p.header.packet_id] : []);
    expect(await visible()).not.toContain(flash.packet_id);
    expect(await visible()).not.toContain(note.packet_id);
    await core.submit_answer(seat, { ...round, seat_id: 'a', body: 'answer' });
    expect(await visible()).toEqual(expect.arrayContaining([flash.packet_id, note.packet_id]));
  } finally {
    core.close();
  }
});

it('checks the setup version before resolving a share confirmation', async () => {
  const core = new Core();
  const { meeting_id } = await core.create_meeting(human, {
    topic: 'Topic', chair: { principal: human.id },
    seats: [{ seat_id: 'a', principal: seat, connection: 'cli', seat_specific_materials: [{ id: 'memo' }] }],
  });
  const confirmation = { meeting_id, material_ref: 'seat:a:memo', purpose: 'cite_in_synthesis' };
  await core.confirm_share(human, { ...confirmation, setup_version: 1 });
  await core.update_setup(human, { meeting_id, seats: [{ seat_id: 'a', seat_specific_materials: [] }] });
  await expect(core.confirm_share(human, { ...confirmation, setup_version: 1 })).rejects.toEqual({
    code: 'invalid_state', detail: { meeting_state: 'CREATED', expected_setup_version: 2, provided_setup_version: 1 },
  });
  await expect(core.confirm_share(human, { ...confirmation, setup_version: 2 })).rejects.toEqual({ code: 'not_found' });
});

it('opens R2 on Fail, inheriting a relative deadline after skipping a past saved absolute deadline', async () => {
  let monotonic = 0n;
  const second = 1_000_000_000n;
  const core = new Core({
    clock: { now: () => ({ monotonic, wall: 1_700_000_000_000_000_000n + monotonic }) },
  });
  try {
    const { meeting_id } = await core.create_meeting(human, {
      topic: 'Topic', chair: { principal: human.id }, quorum: 1,
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
      round_settings: { R2: { deadline: { kind: 'absolute', at: '2023-11-14T22:13:20Z' } } },
    });
    await core.open_round(human, {
      ...argsForRound(meeting_id), deadline: { kind: 'relative', seconds: 4 },
    });
    await core.submit_answer(seat, { ...argsForRound(meeting_id), seat_id: 'a', body: 'answer' });
    monotonic += second;
    await core.open_round(human, { meeting_id, round: 'R1' });
    await core.submit_answer(seat, { meeting_id, round: 'R1', seat_id: 'a', body: 'critique' });
    monotonic += second;
    await core.chair_gate(human, {
      meeting_id, result: 'fail', unresolved_points: ['question'], next_round_scope: ['question'],
    });
    expect(await core.get_state(human, { meeting_id })).toMatchObject({
      meeting_state: 'OPEN',
      round_states: expect.arrayContaining([expect.objectContaining({
        round: 'R2', deadline_at: '2023-11-14T22:13:26.000Z',
      })]),
    });
    monotonic = 6n * second + 1n;
    const { synthesis_packet } = await core.synthesize(human, { meeting_id, body: draft });
    expect(synthesis_packet.body.reception_summary).toMatch(/R2: 受領0\/1.*quorum未達/);
  } finally {
    core.close();
  }
});

it.each(['a', 'unknown'])('checks submission roles before resolving seat %s', async seat_id => {
  const { core, meeting_id } = await meeting();
  const args = { meeting_id, round: 'R0', seat_id, body: 'idea' };
  const chair = { id: 'chair-only', kind: 'agent' } as const;
  await core.update_setup(human, { meeting_id, chair: { principal: chair.id } });
  for (const call of [
    () => core.submit_answer(chair, args),
    () => core.transcribe_web_seat(chair, args),
    () => core.submit_flash(chair, { ...args, basis: 'topic' }),
  ]) await expect(call()).rejects.toMatchObject({ code: 'unauthorized' });
  core.close();
});

it('records waived and absent seats while giving superseded reception precedence in synthesis', async () => {
  const { core, meeting_id } = await meeting('web');
  const args = { meeting_id, round: 'R0', seat_id: 'a', body: 'web answer' };
  await core.open_round(human, argsForRound(meeting_id));
  const first = await core.transcribe_web_seat(human, args);
  const second = await core.transcribe_web_seat(human, { ...args, supersedes: first.packet_id });
  await core.waive_seat(human, { ...argsForRound(meeting_id), seat_id: 'a', reason_code: 'chair_judgment' });
  await core.open_round(human, { meeting_id, round: 'R1' });
  const third = await core.transcribe_web_seat(human, { ...args, round: 'R1' });
  await core.declare_absent(human, { meeting_id, round: 'R1', seat_id: 'a' });
  await core.chair_gate(human, { meeting_id, result: 'pass' });
  const { synthesis_packet } = await core.synthesize(human, { meeting_id, body: {
    ...draft, unverified_items: [first, second, third].map(({ packet_id }) => ({ seat_id: 'a', packet_id })),
  } });
  expect(synthesis_packet.body.unverified_items).toEqual([
    { seat_id: 'a', packet_id: first.packet_id, source: 'chair', state: 'superseded' },
    { seat_id: 'a', packet_id: second.packet_id, source: 'chair', state: 'waived' },
    { seat_id: 'a', packet_id: third.packet_id, source: 'chair', state: 'absent' },
  ]);
  core.close();
});

it('requires authenticated humans for R0 and approval', async () => {
  const core = new Core();
  const agent = 'registered-agent';
  const { meeting_id } = await core.create_meeting(agent, {
    topic: 'Topic', chair: { principal: agent }, human_participants: [agent, human.id], seats: [],
  });
  const args = { meeting_id };
  await expect(core.open_round(agent, argsForRound(meeting_id))).rejects.toMatchObject({ code: 'invalid_state' });
  await core.get_state(human, args);
  for (const round of ['R0', 'R1']) await core.open_round(agent, { ...args, round });
  await core.chair_gate(agent, { ...args, result: 'pass' });
  await core.synthesize(agent, { ...args, body: draft });
  await expect(core.approve(agent, { ...args, decision: 'approve' })).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(core.approve(human, { ...args, decision: 'approve' })).resolves.toMatchObject({ meeting_state: 'APPROVED' });
  core.close();
});

it('rejects a file-store commit based on a stale manifest', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'council-revision-'));
  const core = new Core({ home });
  try {
    const { meeting_id } = await core.create_meeting(human, {
      topic: 'Topic', chair: { principal: human.id }, seats: [],
    });
    expect(systemClock.epoch).toBeTruthy();
    const stale = new FileStore(home, { epoch: systemClock.epoch! });
    const { meetings, checkpoint } = stale.load();
    await core.open_round(human, argsForRound(meeting_id));
    expect(() => stale.commit(meetings, checkpoint!)).toThrow('Council store revision changed since load');
    await expect(core.get_state(human, { meeting_id })).resolves.toMatchObject({ meeting_state: 'GATE' });
  } finally {
    core.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it.each([[90, 9], [90, 11], [110, 9]])(
  'rejects a peer checkpoint at (%i, %i) behind the durable timeline',
  (monotonic, position) => {
    const home = mkdtempSync(join(tmpdir(), 'council-checkpoint-order-'));
    try {
      const clock = { epoch: 'test' };
      const writer = new FileStore(home, clock);
      const peer = new FileStore(home, clock);
      const checkpoint = { epoch: clock.epoch, monotonic: '100', position: 10, offset: '0', wall: '100' };
      writer.commit([], checkpoint);
      expect(peer.load().checkpoint).toMatchObject(checkpoint);
      expect.soft(() => peer.commit([], { ...checkpoint, monotonic: String(monotonic), position }))
        .toThrow(/checkpoint.*backward/i);
      expect(writer.load().checkpoint).toMatchObject(checkpoint);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it('restores observed human participants on a fresh peer and after all peers restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'council-human-directory-'));
  const agent = 'agent-convener-and-chair';
  const setup = {
    topic: 'Topic', chair: { principal: agent }, human_participants: [human.id], seats: [],
  };
  const owner = new Core({ home });
  let peer: Core | undefined;
  let reopened: Core | undefined;
  try {
    const first = await owner.create_meeting(agent, setup);
    const second = await owner.create_meeting(agent, setup);
    await expect(owner.open_round(agent, argsForRound(first.meeting_id))).rejects.toMatchObject({ code: 'invalid_state' });
    await owner.get_state(human, { meeting_id: first.meeting_id });
    peer = new Core({ home });
    await expect.soft(peer.open_round(agent, argsForRound(first.meeting_id))).resolves.toMatchObject({ status: 'ok' });
    owner.close();
    peer.close();
    reopened = new Core({ home });
    await expect(reopened.open_round(agent, argsForRound(second.meeting_id))).resolves.toMatchObject({ status: 'ok' });
  } finally {
    owner.close();
    peer?.close();
    reopened?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
