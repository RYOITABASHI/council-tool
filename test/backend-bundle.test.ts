import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/core/clock.js';
import { Core, createCore } from '../src/core/index.js';
import { append } from '../src/core/meeting.js';
import type { Meeting } from '../src/core/model.js';
import { cliSeatKindAvailability, resolveCliConfigs } from '../src/http/cli-config.js';
import { continuation } from '../src/http/host-runner.js';
import { listMeetings } from '../src/http/meeting-list.js';
import { runnerEvidence } from '../src/core/views.js';
import { packetSha } from '../src/packet/index.js';
import { FileStore } from '../src/store/index.js';
import type { Checkpoint, Store } from '../src/store/index.js';
import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';

// The file-store round trip must also run under COUNCIL_STORE_NO_LINK=1.
installXattrTestTransport();
guardStoreLinks();

const human = { id: 'host:operator', kind: 'human' } as const;
const chair = 'chair-agent';
const seat = 'seat-user';

/** A synchronous in-memory store whose saved meetings a test can inspect and tamper with. */
function memoryStore(initial: Meeting[] = [], checkpoint?: Checkpoint) {
  const saved = new Map(initial.map(m => [m.id, structuredClone(m)]));
  let cp = checkpoint;
  const store: Store & { saved: typeof saved; checkpoint: () => Checkpoint | undefined } = {
    saved,
    checkpoint: () => cp,
    load: () => ({ meetings: [...saved.values()].map(m => structuredClone(m)), ...(cp ? { checkpoint: cp } : {}) }),
    commit(changed, next) {
      for (const m of changed) saved.set(m.id, structuredClone(m));
      cp = next;
    },
  };
  return store;
}

const cores: Core[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
});

function open(store: Store) {
  const core = new Core({ store, clock: systemClock, isHuman: id => id === human.id });
  cores.push(core);
  return core;
}

async function answeredMeeting() {
  const store = memoryStore();
  const core = open(store);
  const { meeting_id } = await core.create_meeting(human, {
    topic: 'Integrity', chair: { principal: chair }, human_participants: [human.id],
    seats: [
      { seat_id: 'a', principal: seat, connection: 'cli' },
      { seat_id: 'b', principal: 'seat-b', connection: 'cli' },
    ],
  });
  await core.open_round(chair, { meeting_id, round: 'R0' });
  const a = await core.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'answer a' });
  const b = await core.submit_answer('seat-b', { meeting_id, round: 'R0', seat_id: 'b', body: 'answer b' });
  core.close();
  return { store, meeting_id, a: a.packet_id, b: b.packet_id };
}

const oversight = (core: Core, meeting_id: string, principal: string = chair) =>
  core.get_packets(principal, { meeting_id, caller_seat_id: 'chair', view: 'oversight' });
const ids = (packets: { new_packets: unknown[] }) => packets.new_packets.map(entry =>
  (entry as { packet?: { header: { packet_id: string } }; header?: { packet_id: string } }).packet?.header.packet_id ??
  (entry as { header: { packet_id: string } }).header.packet_id);

describe('PR-D: packet_sha is verified on the normal read path', () => {
  it('returns every intact packet unchanged and reports no quarantine', async () => {
    const { store, meeting_id, a, b } = await answeredMeeting();
    const before = structuredClone(store.saved.get(meeting_id)!);
    const core = open(store);
    const view = await oversight(core, meeting_id);
    expect(ids(view)).toEqual(before.packets.map(p => p.packet.header.packet_id));
    expect(ids(view)).toEqual(expect.arrayContaining([a, b]));
    expect(view).not.toHaveProperty('quarantined_packet_ids');
    for (const entry of view.new_packets as { packet: Meeting['packets'][number]['packet'] }[]) {
      expect(entry.packet).toEqual(before.packets.find(p => p.packet.header.packet_id === entry.packet.header.packet_id)!.packet);
    }
  });

  it('quarantines a packet whose body no longer matches packet_sha without rewriting it', async () => {
    const { store, meeting_id, a, b } = await answeredMeeting();
    const tampered = store.saved.get(meeting_id)!;
    const target = tampered.packets.find(p => p.packet.header.packet_id === a)!;
    (target.packet.body as { body: string }).body = 'forged answer';
    const forged = structuredClone(target);

    const core = open(store);
    const view = await oversight(core, meeting_id);
    expect(ids(view)).not.toContain(a);
    expect(ids(view)).toContain(b);
    expect(view.quarantined_packet_ids).toEqual([a]);
    // The seat input view withholds it too.
    const input = await core.get_packets('seat-b', { meeting_id, caller_seat_id: 'b' });
    expect(ids(input)).not.toContain(a);

    // The meeting continues: R0 is frozen, R1 can open and a note can be posted.
    expect((await core.get_state(chair, { meeting_id })).meeting_state).toBe('GATE');
    await core.open_round(chair, { meeting_id, round: 'R1' });
    await core.post_message(chair, { meeting_id, body: { text: 'continuing' } });
    // Quarantine is a read-time decision: the stored packet keeps its forged bytes and its original sha.
    const saved = store.saved.get(meeting_id)!.packets.find(p => p.packet.header.packet_id === a)!;
    expect(saved).toEqual(forged);
    expect((await oversight(core, meeting_id)).quarantined_packet_ids).toEqual([a]);
  });

  it('quarantines a packet whose hashed header field was altered', async () => {
    const { store, meeting_id, b } = await answeredMeeting();
    const tampered = store.saved.get(meeting_id)!;
    const target = tampered.packets.find(p => p.packet.header.packet_id === b)!;
    target.packet.header.created_at = '2000-01-01T00:00:00.000000000Z';
    const view = await oversight(open(store), meeting_id);
    expect(view.quarantined_packet_ids).toEqual([b]);
    expect(ids(view)).not.toContain(b);
  });

  it('drops declared missing records that come from a quarantined synthesis', async () => {
    const { store, meeting_id, a } = await answeredMeeting();
    const m = store.saved.get(meeting_id)!;
    const body = {
      reception_summary: '', cited_materials: [], agreements: [], minority_opinions: [], unverified_items: [],
      declared_missing_records: [{ seat_id: 'a', packet_id: a, note: 'declared' }], reversal_conditions: [],
      recommendation: null,
    } as never;
    const synthesis = append(m, systemClock.now(), 'synthesis', { round: null, seat_id: null, supersedes: null }, body);
    const entryFor = async (core: Core) => (await oversight(core, meeting_id)).new_packets
      .find(entry => (entry as { packet: { header: { packet_id: string } } }).packet.header.packet_id === a) as
      { declared_missing_records: unknown[] };
    const intact = open(store);
    expect((await entryFor(intact)).declared_missing_records).toEqual([{ seat_id: 'a', packet_id: a, note: 'declared' }]);
    intact.close();

    const stored = store.saved.get(meeting_id)!.packets.find(p => p.packet.header.packet_id === synthesis.header.packet_id)!;
    // A well-formed but forged record must not surface.
    (stored.packet.body as { declared_missing_records: unknown }).declared_missing_records =
      [{ seat_id: 'a', packet_id: a, note: 'forged' }];
    const core = open(store);
    expect((await oversight(core, meeting_id)).quarantined_packet_ids).toEqual([synthesis.header.packet_id]);
    expect((await entryFor(core)).declared_missing_records).toEqual([]);
    core.close();
    // A malformed (non-array) field cannot break the whole view either.
    (stored.packet.body as { declared_missing_records: unknown }).declared_missing_records = null;
    expect((await entryFor(open(store))).declared_missing_records).toEqual([]);
  });

  it('withholds a quarantined mention note from runner evidence', async () => {
    const store = memoryStore();
    const core = open(store);
    const { meeting_id } = await core.create_meeting(human, {
      topic: 'Evidence', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    await core.openHumanMention(chair, { meeting_id, mention: { seat_id: 'a', text: 'genuine request' } });
    core.close();
    const m = store.saved.get(meeting_id)!;
    expect(runnerEvidence(m).directed).toMatchObject({ seat_id: 'a', text: 'genuine request' });
    const note = m.packets.find(p => p.packet.header.kind === 'note')!;
    (note.packet.body as { text: string }).text = 'forged request';
    expect(runnerEvidence(m).directed).toMatchObject({ seat_id: 'a', text: null });
  });

  it('limits the quarantine report to packets the response would have contained', async () => {
    const { store, meeting_id, a } = await answeredMeeting();
    const target = store.saved.get(meeting_id)!.packets.find(p => p.packet.header.packet_id === a)!;
    target.packet.header.packet_sha = '0'.repeat(64);
    const core = open(store);
    const other = await core.get_packets(chair, { meeting_id, caller_seat_id: 'chair', view: 'oversight', round: 'R1' });
    expect(other).not.toHaveProperty('quarantined_packet_ids');
    const r0 = await core.get_packets(chair, { meeting_id, caller_seat_id: 'chair', view: 'oversight', round: 'R0' });
    expect(r0.quarantined_packet_ids).toEqual([a]);
  });
});

describe('B3: note origin and addressee', () => {
  async function meetingWithStore() {
    const store = memoryStore();
    const core = open(store);
    const { meeting_id } = await core.create_meeting(human, {
      topic: 'Notes', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    return { store, core, meeting_id };
  }
  const notes = async (core: Core, meeting_id: string) =>
    ((await oversight(core, meeting_id)).new_packets as Record<string, unknown>[])
      .filter(entry => (entry.packet as { header: { kind: string } }).header.kind === 'note');

  it('records a chair origin for post_message, by route rather than principal', async () => {
    const { core, meeting_id } = await meetingWithStore();
    await core.dispatch('council.post_message', { meeting_id, body: { text: 'from chair' } }, chair);
    await core.post_message(human, { meeting_id, body: { text: 'from a human principal via post_message' } });
    expect(await notes(core, meeting_id)).toEqual([
      expect.objectContaining({ origin: { kind: 'chair', principal: chair }, addressee: null }),
      expect.objectContaining({ origin: { kind: 'chair', principal: human.id }, addressee: null }),
    ]);
  });

  it('records a human origin and the addressee for a facade mention', async () => {
    const { core, meeting_id } = await meetingWithStore();
    await core.open_round(chair, { meeting_id, round: 'R0' });
    await core.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'x' });
    await core.open_round(chair, { meeting_id, round: 'R1' });
    await core.submit_answer(seat, { meeting_id, round: 'R1', seat_id: 'a', body: 'y' });
    await core.chair_gate(chair, { meeting_id, result: 'pass' });
    await core.openHumanMention(chair, { meeting_id, mention: { seat_id: 'a', text: 'Please elaborate' } });
    const [note] = await notes(core, meeting_id);
    expect(note).toMatchObject({ origin: { kind: 'human', principal: chair }, addressee: 'a' });
  });

  it('keeps packet_sha independent of origin and addressee', async () => {
    const { store, core, meeting_id } = await meetingWithStore();
    const { packet_id, packet_sha } = await core.post_message(chair, { meeting_id, body: { text: 'hash me' } });
    const stored = store.saved.get(meeting_id)!.packets.find(p => p.packet.header.packet_id === packet_id)!;
    // The hashed header has exactly the protocol fields; attribution lives in the stored metadata.
    expect(Object.keys(stored.packet.header).sort()).toEqual(
      ['created_at', 'kind', 'meeting_id', 'packet_id', 'packet_sha', 'round', 'seat_id', 'supersedes']);
    expect(stored.packet.body).toEqual({ text: 'hash me' });
    expect(stored.note).toEqual({ origin: { kind: 'chair', principal: chair }, addressee: null });
    expect(packetSha(stored.packet)).toBe(packet_sha);
    const { note: _, ...legacy } = stored;
    expect(packetSha(legacy.packet)).toBe(packet_sha);
  });

  it('marks an MCP open_round mention as chair with no addressee', async () => {
    const { core, meeting_id } = await meetingWithStore();
    await core.open_round(chair, { meeting_id, round: 'R0' });
    await core.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'x' });
    await core.dispatch('council.open_round', { meeting_id, mention: { seat_id: 'a', text: 'via MCP' } }, chair);
    expect(await notes(core, meeting_id)).toEqual([
      expect.objectContaining({ origin: { kind: 'chair', principal: chair }, addressee: null }),
    ]);
  });

  it('does not expose openHumanMention through MCP dispatch', async () => {
    const { core, meeting_id } = await meetingWithStore();
    await expect(core.dispatch('openHumanMention' as never, { meeting_id }, chair))
      .rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('reads legacy notes without attribution as having no origin and keeps them intact', async () => {
    const { store, core, meeting_id } = await meetingWithStore();
    await core.post_message(chair, { meeting_id, body: { text: 'old note' } });
    core.close();
    const saved = store.saved.get(meeting_id)!;
    const note = saved.packets.find(p => p.packet.header.kind === 'note')!;
    delete note.note;
    const before = structuredClone(note);
    const reader = open(store);
    const view = await oversight(reader, meeting_id);
    expect(view).not.toHaveProperty('quarantined_packet_ids');
    const [entry] = await notes(reader, meeting_id);
    expect(entry).toMatchObject({ packet: before.packet, origin: null, addressee: null });
    await reader.post_message(chair, { meeting_id, body: { text: 'new note' } });
    expect(store.saved.get(meeting_id)!.packets.find(p => p.packet.header.packet_id === before.packet.header.packet_id))
      .toEqual(before);
  });

  it('persists attribution through the file store and reopens without quarantine', async () => {
    const home = mkdtempSync(join(tmpdir(), 'council-b3-disk-'));
    try {
      const writer = createCore({ home, isHuman: id => id === human.id });
      let meeting_id: string;
      try {
        ({ meeting_id } = await writer.create_meeting(human, {
          topic: 'Disk', chair: { principal: chair }, human_participants: [human.id],
          seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
        }));
        await writer.post_message(chair, { meeting_id, body: { text: 'chair memo' } });
        await writer.openHumanMention(chair, { meeting_id, mention: { seat_id: 'a', text: 'to a' } });
      } finally {
        writer.close();
      }
      const reader = createCore({ home, isHuman: id => id === human.id });
      cores.push(reader);
      const view = await oversight(reader, meeting_id);
      expect(view).not.toHaveProperty('quarantined_packet_ids');
      expect(await notes(reader, meeting_id)).toEqual([
        expect.objectContaining({ origin: { kind: 'chair', principal: chair }, addressee: null }),
        expect.objectContaining({ origin: { kind: 'human', principal: chair }, addressee: 'a' }),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('adds no attribution fields to non-note packets', async () => {
    const { core, meeting_id } = await meetingWithStore();
    const [agenda] = (await oversight(core, meeting_id)).new_packets as Record<string, unknown>[];
    expect(agenda).not.toHaveProperty('origin');
    expect(agenda).not.toHaveProperty('addressee');
  });

  it('rejects attribution on other kinds and malformed attribution at creation', async () => {
    const { store, meeting_id } = await meetingWithStore();
    const m = structuredClone(store.saved.get(meeting_id)!);
    const now = systemClock.now();
    const count = m.packets.length;
    const location = { round: null, seat_id: null, supersedes: null } as const;
    const attempt = (note: unknown, kind: 'note' | 'synthesis' = 'note') => () => append(m, now, kind as 'note', location,
      { text: 'x' }, { note } as never);
    expect(attempt({ origin: { kind: 'chair', principal: chair }, addressee: null }, 'synthesis'))
      .toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    for (const bad of [
      { origin: { kind: 'robot', principal: chair }, addressee: null },
      { origin: { kind: 'human', principal: '' }, addressee: null },
      { origin: { kind: 'human', principal: chair } },
      { origin: { kind: 'human', principal: chair }, addressee: 'nobody' },
      { origin: { kind: 'human', principal: chair, extra: 1 }, addressee: null },
      { origin: { kind: 'human', principal: chair }, addressee: null, extra: true },
      null,
    ]) {
      expect(attempt(bad)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(m.packets).toHaveLength(count);
    append(m, now, 'note', location, { text: 'x' }, { note: { origin: { kind: 'human', principal: chair }, addressee: 'a' } });
    expect(m.packets).toHaveLength(count + 1);
  });
});

describe('seat kind availability on /health', () => {
  let bin: string;
  afterEach(() => {
    if (bin) rmSync(bin, { recursive: true, force: true });
  });

  it('reports each CLI kind with the same resolution rules as the startup assertion', () => {
    bin = mkdtempSync(join(tmpdir(), 'council-health-'));
    symlinkSync(process.execPath, join(bin, 'codex'));
    let env: NodeJS.ProcessEnv = { PATH: bin };
    expect(cliSeatKindAvailability(env, resolveCliConfigs(env))).toEqual({ codex: true, claude: false });

    // Env overrides apply: an absolute command and a renamed command on PATH.
    env = { PATH: bin, COUNCIL_CLAUDE_COMMAND: process.execPath, COUNCIL_CODEX_COMMAND: 'missing-codex' };
    expect(cliSeatKindAvailability(env, resolveCliConfigs(env))).toEqual({ codex: false, claude: true });

    // A non-executable file does not count.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o644);
    env = { PATH: bin };
    expect(cliSeatKindAvailability(env, resolveCliConfigs(env))).toEqual({ codex: true, claude: false });
    chmodSync(join(bin, 'claude'), 0o755);
    expect(cliSeatKindAvailability(env, resolveCliConfigs(env))).toEqual({ codex: true, claude: true });

    // Reporting never throws, even with no PATH at all.
    expect(cliSeatKindAvailability({}, resolveCliConfigs({}))).toEqual({ codex: false, claude: false });
  });
});

describe('PR-D through the file store', () => {
  // Without links the store keeps per-packet receipts and digests; with links it records none.
  const receipts = process.env.COUNCIL_STORE_NO_LINK === '1';
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  const diskHome = () => {
    const home = mkdtempSync(join(tmpdir(), 'council-prd-disk-'));
    homes.push(home);
    return home;
  };
  const diskCore = (home: string) => {
    const core = createCore({ home, isHuman: id => id === human.id });
    cores.push(core);
    return core;
  };
  const packetFile = (home: string, meeting_id: string, packet_id: string) =>
    join(home, meeting_id, 'packets', packet_id + '.json');
  /** The retained stage copies behind a packet's receipt (no-link stores only). */
  const stageCopies = (file: string) => {
    const dir = dirname(file);
    const name = basename(file);
    return readdirSync(dir).flatMap(entry => {
      const match = entry.startsWith('.packet-receipt.' + name + '.') && /\.([0-9a-f-]{36})$/.exec(entry);
      return match ? [join(dir, '.packet-stage.' + match[1])] : [];
    }).filter(path => existsSync(path));
  };
  /**
   * Rewrite a stored packet file in place (same inode and mode), as an outside edit would. With
   * `stages`, its retained stage copy is rewritten too, so the store has no genuine bytes left.
   */
  const tamper = (file: string, edit: (packet: { header: Record<string, unknown>; body: Record<string, unknown> }) => void,
    resign = false, stages = true) => {
    const packet = JSON.parse(readFileSync(file, 'utf8'));
    edit(packet);
    if (resign) packet.header.packet_sha = packetSha(packet);
    for (const path of [file, ...(stages ? stageCopies(file) : [])]) writeFileSync(path, JSON.stringify(packet));
    return readFileSync(file);
  };
  const latestRevision = (home: string, meeting_id: string) => {
    const names = readdirSync(join(home, meeting_id)).filter(name => /^\d+-[0-9a-f-]+\.json$/.test(name));
    const newest = names.sort((x, y) => Number(y.split('-', 1)[0]) - Number(x.split('-', 1)[0]))[0]!;
    return JSON.parse(readFileSync(join(home, meeting_id, newest), 'utf8')) as
      { packets: Record<string, unknown>[]; generation: number };
  };

  async function answeredOnDisk(home: string) {
    const writer = diskCore(home);
    const { meeting_id } = await writer.create_meeting(human, {
      topic: 'Disk integrity', chair: { principal: chair }, human_participants: [human.id],
      seats: [
        { seat_id: 'a', principal: seat, connection: 'cli' },
        { seat_id: 'b', principal: 'seat-b', connection: 'cli' },
      ],
    });
    await writer.open_round(chair, { meeting_id, round: 'R0' });
    const a = await writer.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'answer a' });
    const b = await writer.submit_answer('seat-b', { meeting_id, round: 'R0', seat_id: 'b', body: 'answer b' });
    writer.close();
    return { meeting_id, a: a.packet_id, b: b.packet_id };
  }

  it('loads a meeting whose packet file was corrupted and quarantines only that packet', async () => {
    const home = diskHome();
    const { meeting_id, a, b } = await answeredOnDisk(home);
    const file = packetFile(home, meeting_id, a);
    const forged = tamper(file, packet => { packet.body.body = 'forged answer'; });
    const digestBefore = latestRevision(home, meeting_id).packets.find(entry => entry.packet_id === a)!.packet_digest;

    const reader = diskCore(home);
    const view = await oversight(reader, meeting_id);
    expect(view.quarantined_packet_ids).toEqual([a]);
    expect(ids(view)).not.toContain(a);
    expect(ids(view)).toContain(b);
    expect(ids(await reader.get_packets('seat-b', { meeting_id, caller_seat_id: 'b' }))).not.toContain(a);

    // The meeting continues and commits around the quarantined packet.
    expect((await reader.get_state(chair, { meeting_id })).meeting_state).toBe('GATE');
    expect(listMeetings(home).map(summary => summary.meeting_id)).toEqual([meeting_id]);
    await reader.open_round(chair, { meeting_id, round: 'R1' });
    await reader.post_message(chair, { meeting_id, body: { text: 'continuing' } });
    reader.close();

    // The stored file is not rewritten and the revision keeps the packet's original digest.
    expect(readFileSync(file)).toEqual(forged);
    const revision = latestRevision(home, meeting_id);
    const entry = revision.packets.find(entry => entry.packet_id === a)!;
    expect(entry.packet_digest).toBe(digestBefore);
    expect(typeof digestBefore).toBe(receipts ? 'string' : 'undefined');
    expect(revision.packets.every(entry => !Object.hasOwn(entry, 'quarantined'))).toBe(true);

    const again = diskCore(home);
    const reopened = await oversight(again, meeting_id);
    expect(reopened.quarantined_packet_ids).toEqual([a]);
    expect((await again.get_state(chair, { meeting_id })).round_states.at(-1)).toMatchObject({ round: 'R1' });
  }, 60_000);

  it('serves the genuine stage copy when only the packet file was edited in a no-link store', async () => {
    const home = diskHome();
    const { meeting_id, a } = await answeredOnDisk(home);
    const file = packetFile(home, meeting_id, a);
    expect(stageCopies(file)).toHaveLength(receipts ? 1 : 0);
    tamper(file, packet => { packet.body.body = 'forged answer'; }, false, false);
    const view = await oversight(diskCore(home), meeting_id);
    if (receipts) {
      expect(view).not.toHaveProperty('quarantined_packet_ids');
      const entry = (view.new_packets as { packet: { header: { packet_id: string }; body: { body: string } } }[])
        .find(item => item.packet.header.packet_id === a)!;
      expect(entry.packet.body.body).toBe('answer a');
    } else {
      expect(view.quarantined_packet_ids).toEqual([a]);
    }
  }, 60_000);

  it('quarantines unparseable packet bytes as well', async () => {
    const home = diskHome();
    const { meeting_id, a, b } = await answeredOnDisk(home);
    for (const path of [packetFile(home, meeting_id, b), ...stageCopies(packetFile(home, meeting_id, b))]) {
      writeFileSync(path, '{not json');
    }
    expect(listMeetings(home).map(summary => summary.meeting_id)).toEqual([meeting_id]);
    const view = await oversight(diskCore(home), meeting_id);
    expect(view.quarantined_packet_ids).toEqual([b]);
    expect(ids(view)).toContain(a);
  }, 60_000);

  it('never lets a tampered gate packet decide the runner state', async () => {
    const home = diskHome();
    const writer = diskCore(home);
    const { meeting_id } = await writer.create_meeting(human, {
      topic: 'Gate', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    await writer.open_round(chair, { meeting_id, round: 'R0' });
    await writer.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'x' });
    await writer.open_round(chair, { meeting_id, round: 'R1' });
    const r1 = await writer.submit_answer(seat, { meeting_id, round: 'R1', seat_id: 'a', body: 'y' });
    writer.close();

    // Awaiting the R1 gate: a packet forged into a passing gate must not skip the gate step.
    // Re-signing packet_sha is only detectable where the store keeps packet receipts.
    tamper(packetFile(home, meeting_id, r1.packet_id), packet => {
      packet.header.kind = 'gate_decision';
      packet.header.seat_id = null;
      packet.body = { result: 'pass' };
    }, receipts);
    const reader = diskCore(home);
    const awaiting = await reader.getRunnerState(chair, { meeting_id });
    expect(awaiting.meeting_state).toBe('GATE');
    expect(awaiting.round_states.at(-1)).toMatchObject({ round: 'R1', phase: 'frozen' });
    expect(awaiting.r1Gate).toBeNull();
    expect((await oversight(reader, meeting_id)).quarantined_packet_ids).toEqual([r1.packet_id]);

    // A genuine gate decision is read; once tampered (even re-signed) it is not.
    const { packet_id: gateId } = (await reader.chair_gate(chair, { meeting_id, result: 'pass' })) as unknown as
      { packet_id?: string };
    expect((await reader.getRunnerState(chair, { meeting_id })).r1Gate).toBe('pass');
    reader.close();
    const gate = gateId ?? (latestRevision(home, meeting_id).packets.at(-1)!.packet_id as string);
    tamper(packetFile(home, meeting_id, gate), packet => { packet.body.result = 'fail'; }, receipts);
    const after = diskCore(home);
    expect((await after.getRunnerState(chair, { meeting_id })).r1Gate).toBeNull();
    expect((await oversight(after, meeting_id)).quarantined_packet_ids).toEqual(expect.arrayContaining([gate]));
  }, 60_000);

  it('reads a legacy-format meeting (packet_digest present, no note attribution)', async () => {
    const home = diskHome();
    // A pre-B3 writer: the same file store, but notes are committed without attribution.
    const legacyStore = new FileStore(home, { epoch: systemClock.epoch! });
    const commit = legacyStore.commit.bind(legacyStore);
    legacyStore.commit = (changed, checkpoint) => commit(changed.map(m => ({
      ...m, packets: m.packets.map(({ note: _attribution, ...p }) => p),
    })), checkpoint);
    const writer = open(legacyStore);
    const { meeting_id } = await writer.create_meeting(human, {
      topic: 'Legacy', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    await writer.post_message(chair, { meeting_id, body: { text: 'old chair memo' } });
    await writer.openHumanMention(chair, { meeting_id, mention: { seat_id: 'a', text: 'old request' } });
    await writer.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'old answer' });
    writer.close();

    const stored = latestRevision(home, meeting_id).packets;
    expect(stored.length).toBeGreaterThanOrEqual(4);
    expect(stored.every(entry => !Object.hasOwn(entry, 'note'))).toBe(true);
    // The device store runs without links, so its packets carry packet_digest (as in this mode).
    expect(stored.every(entry => typeof entry.packet_digest === (receipts ? 'string' : 'undefined'))).toBe(true);
    const files = Object.fromEntries(stored.map(entry => [entry.packet_id as string,
      readFileSync(packetFile(home, meeting_id, entry.packet_id as string))]));

    const reader = diskCore(home);
    const view = await oversight(reader, meeting_id);
    expect(view).not.toHaveProperty('quarantined_packet_ids');
    expect(ids(view)).toEqual(stored.map(entry => entry.packet_id));
    const legacyNotes = (view.new_packets as Record<string, unknown>[])
      .filter(entry => (entry.packet as { header: { kind: string } }).header.kind === 'note');
    expect(legacyNotes).toHaveLength(2);
    for (const note of legacyNotes) expect(note).toMatchObject({ origin: null, addressee: null });
    expect((await reader.getRunnerState(chair, { meeting_id })).directed)
      .toMatchObject({ seat_id: 'a', text: 'old request' });

    await reader.post_message(chair, { meeting_id, body: { text: 'new memo' } });
    reader.close();
    for (const [packet_id, bytes] of Object.entries(files)) {
      expect(readFileSync(packetFile(home, meeting_id, packet_id))).toEqual(bytes);
    }
    const after = latestRevision(home, meeting_id).packets;
    expect(after.slice(0, stored.length)).toEqual(stored);
    expect(after.at(-1)).toMatchObject({ note: { origin: { kind: 'chair', principal: chair }, addressee: null } });
  }, 60_000);

  /** Replace a stored packet file (and its retained stage copies) with arbitrary bytes. */
  const overwrite = (file: string, bytes: string) => {
    for (const path of [file, ...stageCopies(file)]) writeFileSync(path, bytes);
    return readFileSync(file);
  };

  it.each([
    ['JSON null', () => 'null'],
    ['an empty object', () => '{}'],
    ['a header-less packet', () => JSON.stringify({ body: { body: 'x' } })],
  ])('quarantines a packet file holding %s instead of failing on its header', async (_, bytes) => {
    const home = diskHome();
    const { meeting_id, a, b } = await answeredOnDisk(home);
    const file = packetFile(home, meeting_id, a);
    const forged = overwrite(file, bytes());
    const reader = diskCore(home);
    expect((await reader.getRunnerState(chair, { meeting_id })).meeting_state).toBe('GATE');
    const view = await oversight(reader, meeting_id);
    expect(view.quarantined_packet_ids).toEqual([a]);
    expect(ids(view)).toContain(b);
    expect(listMeetings(home).map(summary => summary.meeting_id)).toEqual([meeting_id]);
    await reader.post_message(chair, { meeting_id, body: { text: 'continuing' } });
    reader.close();
    expect(readFileSync(file)).toEqual(forged);
    expect(latestRevision(home, meeting_id).packets.map(entry => entry.packet_id)).toContain(a);
  }, 60_000);

  it('keeps the recorded packet id when only the stored packet_id was changed', async () => {
    const home = diskHome();
    const { meeting_id, a } = await answeredOnDisk(home);
    const file = packetFile(home, meeting_id, a);
    const other = '00000000-0000-4000-8000-000000000000';
    // packet_id is outside the packet_sha input, so the digest alone would still match.
    const forged = tamper(file, packet => { packet.header.packet_id = other; });
    const reader = diskCore(home);
    expect((await oversight(reader, meeting_id)).quarantined_packet_ids).toEqual([a]);
    await reader.post_message(chair, { meeting_id, body: { text: 'continuing' } });
    reader.close();
    expect(readFileSync(file)).toEqual(forged);
    expect(existsSync(packetFile(home, meeting_id, other))).toBe(false);
    const entries = latestRevision(home, meeting_id).packets.map(entry => entry.packet_id);
    expect(entries).toContain(a);
    expect(entries).not.toContain(other);
    expect((await oversight(diskCore(home), meeting_id)).quarantined_packet_ids).toEqual([a]);
  }, 60_000);

  it('does not count a quarantined gate rewritten as an answer toward the seat quota', async () => {
    const home = diskHome();
    const writer = diskCore(home);
    const { meeting_id } = await writer.create_meeting(human, {
      topic: 'Quota', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli', quota: 3 }],
    });
    await writer.open_round(chair, { meeting_id, round: 'R0' });
    await writer.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'x' });
    await writer.open_round(chair, { meeting_id, round: 'R1' });
    await writer.submit_answer(seat, { meeting_id, round: 'R1', seat_id: 'a', body: 'y' });
    const { gate_decision_packet } = await writer.chair_gate(chair, { meeting_id, result: 'fail',
      unresolved_points: ['open'], next_round_scope: ['scope'] }) as unknown as
      { gate_decision_packet: { header: { packet_id: string } } };
    writer.close();
    const gate = gate_decision_packet.header.packet_id;
    tamper(packetFile(home, meeting_id, gate), packet => {
      packet.header.kind = 'answer';
      packet.header.round = 'R2';
      packet.header.seat_id = 'a';
      packet.body = { body: 'forged' };
    });
    const reader = diskCore(home);
    expect((await oversight(reader, meeting_id)).quarantined_packet_ids).toEqual([gate]);
    expect(await reader.get_quota(chair, { meeting_id, seat_id: 'a' })).toMatchObject({ used: 2 });
    await expect(reader.submit_answer(seat, { meeting_id, round: 'R2', seat_id: 'a', body: 'z' }))
      .resolves.toMatchObject({ packet_id: expect.any(String) });
  }, 60_000);

  it('a re-signed packet forged into an R1 gate never skips the gate step', async () => {
    const home = diskHome();
    const writer = diskCore(home);
    const { meeting_id } = await writer.create_meeting(human, {
      topic: 'Forged gate', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    await writer.open_round(chair, { meeting_id, round: 'R0' });
    await writer.submit_answer(seat, { meeting_id, round: 'R0', seat_id: 'a', body: 'x' });
    await writer.open_round(chair, { meeting_id, round: 'R1' });
    const r1 = await writer.submit_answer(seat, { meeting_id, round: 'R1', seat_id: 'a', body: 'y' });
    writer.close();
    // Re-signed in both modes: where the store keeps no digest this forgery passes packet_sha.
    tamper(packetFile(home, meeting_id, r1.packet_id), packet => {
      packet.header.kind = 'gate_decision';
      packet.header.seat_id = null;
      packet.body = { result: 'pass', rationale: '', resolved_points: [], unresolved_points: [], next_round_scope: [] };
    }, true);
    const reader = diskCore(home);
    const state = await reader.getRunnerState(chair, { meeting_id });
    expect(state.r1Gate).toBeNull();
    expect(continuation(state)).toMatchObject({ step: 'gate' });
    // The genuine gate still decides, and a re-signed flip of its result is not believed.
    const { gate_decision_packet } = await reader.chair_gate(chair, { meeting_id, result: 'pass' }) as unknown as
      { gate_decision_packet: { header: { packet_id: string } } };
    const passed = await reader.getRunnerState(chair, { meeting_id });
    // Where the forgery stays undetectable (no packet digests), two gate candidates exist and neither
    // is believed; the meeting state alone carries the runner on.
    expect(passed.r1Gate).toBe(receipts ? 'pass' : null);
    expect(continuation(passed)).toMatchObject({ step: 'synthesis' });
    reader.close();
    const gate = gate_decision_packet.header.packet_id;
    tamper(packetFile(home, meeting_id, gate), packet => { packet.body.result = 'fail'; }, true);
    const flipped = await diskCore(home).getRunnerState(chair, { meeting_id });
    expect(flipped.r1Gate).toBeNull();
    expect(continuation(flipped)).toMatchObject({ step: 'synthesis' });
  }, 60_000);

  it.each([false, true])('keeps a meeting listed and usable when its original agenda is quarantined (agenda only: %s)',
    async agendaOnly => {
    const home = diskHome();
    const writer = diskCore(home);
    const { meeting_id } = await writer.create_meeting(human, {
      topic: 'Agenda', chair: { principal: chair }, human_participants: [human.id],
      seats: [{ seat_id: 'a', principal: seat, connection: 'cli' }],
    });
    if (!agendaOnly) await writer.post_message(chair, { meeting_id, body: { text: 'memo' } });
    writer.close();
    const agenda = latestRevision(home, meeting_id).packets[0]!.packet_id as string;
    const forged = tamper(packetFile(home, meeting_id, agenda), packet => { packet.body.topic = 'forged'; });
    const [summary] = listMeetings(home);
    expect(summary).toMatchObject({ meeting_id, topic: 'Agenda', meeting_state: 'CREATED' });
    expect(Number.isNaN(Date.parse(summary!.created_at))).toBe(false);
    const reader = diskCore(home);
    expect((await oversight(reader, meeting_id)).quarantined_packet_ids).toEqual([agenda]);
    // Superseding the agenda needs the genuine one: refused cleanly, not an internal failure.
    await expect(reader.update_setup(chair, { meeting_id, shared_materials: ['revised'] }))
      .rejects.toMatchObject({ code: 'invalid_state' });
    await reader.open_round(chair, { meeting_id, round: 'R0' });
    reader.close();
    expect(readFileSync(packetFile(home, meeting_id, agenda))).toEqual(forged);
  }, 60_000);

  /** Convert a store to the pre-checkpoint (legacy) layout, as store-presence's legacy fixtures do. */
  const toLegacy = (home: string) => {
    const legacyName = (revision: string) => revision.replace(/^[1-9]\d*-(?=[0-9a-f-]{36}$)/, '');
    const { checkpoint, meetings } = JSON.parse(readFileSync(join(home, 'manifest.json'), 'utf8'));
    writeFileSync(join(home, 'manifest.json'), JSON.stringify({ checkpoint, meetings: Object.fromEntries(
      Object.entries(meetings as Record<string, string>).map(([id, revision]) => [id, legacyName(revision)])) }));
    rmSync(join(home, '.manifest-state'));
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (/^\.(presence|checkpoint|commit|commit-proof|commit-seal|proof-attempt)\./.test(entry.name)) {
        rmSync(join(home, entry.name), { recursive: true });
        continue;
      }
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(home, entry.name);
      const packets = join(directory, 'packets');
      for (const name of readdirSync(packets).filter(name => /^\.packet-(receipt|stage)\./.test(name))) {
        rmSync(join(packets, name), { recursive: true });
      }
      for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const revision = join(directory, name);
        const state = JSON.parse(readFileSync(revision, 'utf8'));
        delete state.generation;
        for (const packet of state.packets) {
          delete packet.packet_digest;
          delete packet.note;
        }
        writeFileSync(revision, JSON.stringify(state));
        const legacy = join(directory, legacyName(name.slice(0, -5)) + '.json');
        if (legacy !== revision) renameSync(revision, legacy);
      }
    }
  };

  it.each(['answer', 'agenda'] as const)('admits a legacy (pre-manifest) store with a tampered %s and quarantines it',
    async target => {
    const home = diskHome();
    const { meeting_id, a, b } = await answeredOnDisk(home);
    toLegacy(home);
    // Admission only uses packet bytes to infer the legacy revision order; the damaged packet is
    // still quarantined when the meeting is read.
    const packetId = target === 'answer' ? a : (JSON.parse(readFileSync(join(home, meeting_id,
      readdirSync(join(home, meeting_id)).find(name => name.endsWith('.json'))!), 'utf8')).packets[0].packet_id as string);
    const file = packetFile(home, meeting_id, packetId);
    const forged = tamper(file, packet => {
      if (target === 'answer') packet.body.body = 'forged answer';
      else packet.body.topic = 'forged topic';
    });
    expect(listMeetings(home).map(summary => summary.meeting_id)).toEqual([meeting_id]);
    const reader = diskCore(home);
    const view = await oversight(reader, meeting_id);
    expect(view.quarantined_packet_ids).toEqual([packetId]);
    expect(ids(view)).toContain(b);
    await reader.open_round(chair, { meeting_id, round: 'R1' });
    reader.close();
    expect(readFileSync(file)).toEqual(forged);
    expect((await oversight(diskCore(home), meeting_id)).quarantined_packet_ids).toEqual([packetId]);
  }, 60_000);

  it.each([
    ['a rejection reason on a live meeting', { rejectionReason: 'rejected' }],
    ['null confirmations', { confirmations: null }],
  ])('still rejects an inconsistent legacy revision (%s) when a packet fails verification', async (_, change) => {
    const home = diskHome();
    const { meeting_id, a } = await answeredOnDisk(home);
    toLegacy(home);
    tamper(packetFile(home, meeting_id, a), packet => { packet.body.body = 'forged answer'; });
    // Neither fault needs a packet to be seen, so admission still fails with the order error.
    const directory = join(home, meeting_id);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const revision = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      writeFileSync(join(directory, name), JSON.stringify({ ...revision, ...change }));
    }
    expect(() => diskCore(home)).toThrow(/cannot establish the latest legacy meeting revision/);
  }, 60_000);
});
