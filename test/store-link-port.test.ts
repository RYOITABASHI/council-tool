import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as primitives from '../src/store/files.js';
import { FileStore } from '../src/store/index.js';
import { listMeetings } from '../src/http/meeting-list.js';
import type { Meeting } from '../src/core/model.js';
import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';

const fixtureLink = fs.linkSync;
installXattrTestTransport();
guardStoreLinks();
vi.setConfig({ testTimeout: 30_000 });

let home: string;
let fd: number;
const originalLink = fs.linkSync;
const originalCopy = fs.copyFileSync;
const originalMkdir = fs.mkdirSync;
const originalOpen = fs.openSync;
const originalSync = fs.fsyncSync;
const originalWrite = fs.writeSync;
const originalSpawn = childProcess.spawnSync;
const clock = { epoch: 'port-test' };

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'council-link-port-'));
  fd = fs.openSync(home, fs.constants.O_DIRECTORY);
});

afterEach(() => {
  fs.linkSync = originalLink;
  fs.copyFileSync = originalCopy;
  fs.mkdirSync = originalMkdir;
  fs.openSync = originalOpen;
  fs.fsyncSync = originalSync;
  fs.writeSync = originalWrite;
  childProcess.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  fs.closeSync(fd);
  fs.rmSync(home, { recursive: true, force: true });
});

it.each(['EACCES', 'EPERM', 'EOPNOTSUPP', 'ENOSYS', 'ENOSPC', 'EIO', 'EEXIST'])(
  'classifies and cleans up a link probe returning %s', code => {
    let calls = 0;
    fs.linkSync = () => { calls++; throw Object.assign(new Error(code), { code }); };
    syncBuiltinESMExports();
    const probe = () => primitives.probeLinkCapability(fd);
    if (['ENOSPC', 'EIO', 'EEXIST'].includes(code)) {
      expect(probe).toThrow(code);
      expect(probe).toThrow(code);
      expect(calls).toBe(2);
    } else {
      expect(probe()).toBe(false);
      expect(probe()).toBe(false);
      expect(calls).toBe(1);
    }
    expect(fs.readdirSync(home)).toEqual([]);
  },
);

it('bypasses a successful link capability cache when forced', () => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  expect(primitives.probeLinkCapability(fd)).toBe(true);
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '1');
  fs.linkSync = () => { throw new Error('unexpected hard link'); };
  syncBuiltinESMExports();
  new FileStore(home, clock).transaction(() => {});
  expect(binding().scheme).toBe('recorded');
});

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const key = (root = home) => {
  const { dev, ino } = fs.statSync(root, { bigint: true });
  return `${dev}:${ino}`;
};
const checkpoint = {
  epoch: clock.epoch, monotonic: '0', position: 1, wall: '1767225600000000000', offset: '0',
};
const meeting = {
  id: '00000000-0000-4000-8000-000000000001', topic: 'Port', state: 'CREATED', setup: { seats: [] },
  packets: [{ packet: { header: {
    packet_id: '00000000-0000-4000-8000-000000000002', meeting_id: '00000000-0000-4000-8000-000000000001',
    kind: 'agenda', created_at: '2026-01-01T00:00:00Z',
  } } }],
} as unknown as Meeting;

function forcedStore(root = home) {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '1');
  return new FileStore(root, clock);
}

function manifestBytes(root = home) {
  return fs.readFileSync(join(root, 'manifest.json'), 'utf8');
}

function binding(root = home) {
  return JSON.parse(fs.readFileSync(join(root, '.manifest-state'), 'utf8')).presence;
}

function currentRevision() {
  return join(home, meeting.id, JSON.parse(manifestBytes()).meetings[meeting.id] + '.json');
}

const packetName = meeting.packets[0]!.packet.header.packet_id + '.json';
const packetDirectory = () => join(home, meeting.id, 'packets');
const packetPath = () => join(packetDirectory(), packetName);

function stagePacketRetry(bytes: string) {
  const dir = packetDirectory();
  const attempt = randomUUID();
  fs.writeFileSync(join(dir, '.packet-stage.' + attempt), bytes, { mode: 0o600 });
  fs.mkdirSync(join(dir, `.packet-receipt.${packetName}.${digest(bytes)}.${attempt}`), { mode: 0o700 });
}

const copySites = [
  ['packet', (name: string) => name.endsWith('/packets/' + packetName), false],
  ['pending revision', (name: string) => name.endsWith('.json.pending'), false],
  ['proof payload', (name: string) => name.endsWith('/proof.json'), false],
  ['journal target', (name: string) => basename(name).startsWith('.manifest-target-v2.'), false],
  ['journal undo', (name: string) => basename(name).startsWith('.manifest-undo-v2.'), false],
  ['final revision', (name: string) => /\/\d+-[0-9a-f-]{36}\.json$/.test(name), true],
  ['commit sibling', (name: string) => /\/\.commit\.\d+\.json$/.test(name), true],
  ['checkpoint sibling', (name: string) => /\/\.checkpoint\.\d+\.json$/.test(name), true],
] as const;

it.each(copySites)('preserves a late insertion at the %s copy', (_site, match, committed) => {
  const store = forcedStore();
  let occupied: string | undefined;
  let ino: number | undefined;
  fs.copyFileSync = (src, dest, flags) => {
    const path = String(dest);
    const actual = join(fs.realpathSync(dirname(path)), basename(path));
    if (!occupied && match(actual)) {
      occupied = actual;
      fs.writeFileSync(actual, 'late insertion', { mode: 0o600, flag: 'wx' });
      ino = fs.statSync(actual).ino;
    }
    originalCopy(src, dest, flags);
  };
  syncBuiltinESMExports();
  expect(() => store.commit([meeting], checkpoint)).toThrow(/EEXIST|journal identity changed/);
  expect(occupied).toBeDefined();
  expect(fs.statSync(occupied!).ino).toBe(ino);
  expect(fs.readFileSync(occupied!, 'utf8')).toBe('late insertion');
  expect(new primitives.StoreFiles(fd).checkpointGeneration()).toBe(committed ? 1 : 0);
});

it('preserves a late insertion at the exclusive manifest create', () => {
  const store = forcedStore();
  let ino: number | undefined;
  fs.openSync = (path, flags, mode) => {
    if (typeof flags === 'number' && flags & fs.constants.O_EXCL && String(path).endsWith('/manifest.json')) {
      const foreign = originalOpen(path, 'wx', 0o600);
      fs.writeFileSync(foreign, '{"foreign":true}');
      ino = fs.fstatSync(foreign).ino;
      fs.closeSync(foreign);
    }
    return originalOpen(path, flags, mode);
  };
  syncBuiltinESMExports();
  expect(() => store.commit([], checkpoint)).toThrow(/manifest identity changed/);
  expect(fs.statSync(join(home, 'manifest.json')).ino).toBe(ino);
  expect(manifestBytes()).toBe('{"foreign":true}');
  expect(fs.existsSync(join(home, '.manifest-init.' + key()))).toBe(false);
});

it('preserves the exact seal name if it appears at mkdir', () => {
  const store = forcedStore();
  let foreign: string | undefined;
  fs.mkdirSync = ((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
    if (!foreign && String(path).includes('/.commit-seal.')) {
      foreign = join(home, basename(String(path)));
      originalMkdir(foreign, { mode: 0o700 });
      fs.writeFileSync(join(foreign, 'foreign'), 'already present');
    }
    return originalMkdir(path, options);
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  expect(() => store.commit([], checkpoint)).toThrow(/EEXIST/);
  expect(fs.readFileSync(join(foreign!, 'foreign'), 'utf8')).toBe('already present');
  expect(manifestBytes()).toBe('null');
});

const copyCuts = copySites.flatMap(([site, match, committed]) =>
  (['during copy', 'after file sync', 'after directory sync'] as const).map(cut => ({ site, match, committed, cut })));

it.each(copyCuts)('recovers a $site cut $cut', ({ site, match, committed, cut }) => {
  const store = forcedStore();
  let cutPath: string | undefined;
  let sawFileSync = false;
  let fired = false;
  const stop = () => {
    fired = true;
    throw new Error('injected copy cut');
  };
  fs.copyFileSync = (src, dest, flags) => {
    const path = String(dest);
    const actual = join(fs.realpathSync(dirname(path)), basename(path));
    if (!cutPath && match(actual)) {
      cutPath = actual;
      if (cut === 'during copy') {
        const bytes = site === 'journal target' || site === 'packet' ? fs.readFileSync(src).subarray(0, 10) : 'partial';
        fs.writeFileSync(actual, bytes, { mode: 0o600, flag: 'wx' });
        stop();
      }
    }
    originalCopy(src, dest, flags);
  };
  fs.fsyncSync = file => {
    originalSync(file);
    if (!cutPath || fired) return;
    const path = fs.readlinkSync('/proc/self/fd/' + file);
    if (path === cutPath) {
      sawFileSync = true;
      if (cut === 'after file sync') stop();
    } else if (sawFileSync && path === dirname(cutPath) && cut === 'after directory sync') stop();
  };
  syncBuiltinESMExports();
  expect(() => store.commit([meeting], checkpoint)).toThrow(/injected copy cut|journal identity changed/);
  expect(fired).toBe(true);
  fs.copyFileSync = originalCopy;
  fs.fsyncSync = originalSync;
  syncBuiltinESMExports();

  const reopened = forcedStore();
  expect(reopened.load().meetings.map(({ id }) => id)).toEqual(committed ? [meeting.id] : []);
  if (!committed) reopened.commit([meeting], checkpoint);
  expect(reopened.load().meetings.map(({ id }) => id)).toEqual([meeting.id]);
  expect(fs.statSync(currentRevision()).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(currentRevision() + '.pending')).toBe(false);
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe(JSON.stringify(meeting.packets[0]!.packet));
  if (site === 'packet' && cut === 'during copy') {
    const quarantined = fs.readdirSync(packetDirectory()).find(name => name.endsWith('.invalid'));
    expect(fs.readFileSync(join(packetDirectory(), quarantined!)))
      .toEqual(Buffer.from(JSON.stringify(meeting.packets[0]!.packet)).subarray(0, 10));
  }
});

it.each([['missing', 'missing'], ['missing', 'intact'], ['intact', 'missing'], ['intact', 'intact'],
  ['torn', 'missing'], ['missing', 'torn'], ['torn', 'intact'], ['intact', 'torn'], ['torn', 'torn']])(
  'repairs sealed checkpoint siblings when commit is %s and checkpoint is %s', (commit, checkpointState) => {
    forcedStore().commit([meeting], checkpoint);
    const published = manifestBytes();
    const paths = [join(home, '.commit.1.json'), join(home, '.checkpoint.1.json')];
    for (const [path, state] of paths.map((path, i) => [path, [commit, checkpointState][i]!] as const)) {
      if (state === 'missing') fs.unlinkSync(path);
      if (state === 'torn') fs.writeFileSync(path, 'partial');
    }
    expect(listMeetings(home).map(x => x.meeting_id)).toEqual([meeting.id]);
    expect(fs.existsSync(paths[0]!)).toBe(commit !== 'missing');
    expect(fs.existsSync(paths[1]!)).toBe(checkpointState !== 'missing');
    expect(forcedStore().load().meetings).toHaveLength(1);
    for (const path of paths) expect(fs.readFileSync(path, 'utf8')).toBe(published);
    expect(fs.statSync(paths[0]!).ino).not.toBe(fs.statSync(paths[1]!).ino);
  },
);

it('rejects a damaged sealed payload even with both healthy siblings', () => {
  forcedStore().commit([meeting], checkpoint);
  const attempt = fs.readdirSync(home).find(name => name.startsWith('.proof-attempt.'));
  fs.writeFileSync(join(home, attempt!, 'proof.json'), 'torn');
  const files = new primitives.StoreFiles(fd);
  expect(() => files.readCheckpoint(1)).toThrow(/sealed manifest commit proof is damaged/);
  expect(() => forcedStore().load()).toThrow(/checkpoint is older than a committed meeting revision/);
  expect(() => listMeetings(home)).toThrow(/checkpoint is older than a committed meeting revision/);

  fs.unlinkSync(join(home, attempt!, 'proof.json'));
  expect(() => new primitives.StoreFiles(fd).readCheckpoint(1)).toThrow(/sealed manifest commit proof is damaged/);
  expect(() => forcedStore().load()).toThrow(/checkpoint is older than a committed meeting revision/);
  expect(() => listMeetings(home)).toThrow(/checkpoint is older than a committed meeting revision/);
});

it.each([undefined, '', 'nu', 'null'] as const)('admits and resolves an init cut with live contents %j', live => {
  const marker = join(home, '.manifest-init.' + key());
  const path = join(home, 'manifest.json');
  fs.writeFileSync(marker, 'null', { mode: 0o600 });
  if (live !== undefined) fs.writeFileSync(path, live, { mode: 0o600 });
  expect(listMeetings(home)).toEqual([]);
  expect(fs.existsSync(marker)).toBe(true);
  if (live !== undefined) expect(manifestBytes()).toBe(live);
  expect(forcedStore().load()).toEqual({ meetings: [] });
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path)).toBe(live !== undefined);
  if (live !== undefined) expect(manifestBytes()).toBe('null');
  expect(listMeetings(home)).toEqual([]);
});

it('rejects a truncated manifest once its marker is gone', () => {
  fs.writeFileSync(join(home, 'manifest.json'), 'nu', { mode: 0o600 });
  expect(() => forcedStore().load()).toThrow();
  expect(() => listMeetings(home)).toThrow();
  expect(manifestBytes()).toBe('nu');
});

it.each(['live non-null', 'committed checkpoint', 'v1 journal', 'legacy head'])(
  'declines to treat init as empty with %s evidence', conflict => {
    if (conflict === 'committed checkpoint') forcedStore().commit([meeting], checkpoint);
    if (conflict === 'live non-null') fs.writeFileSync(join(home, 'manifest.json'), '{}', { mode: 0o600 });
    if (conflict === 'v1 journal') fs.writeFileSync(join(home, '.manifest-undo.' + key()), '{}', { mode: 0o600 });
    if (conflict === 'legacy head') fs.writeFileSync(join(home, '.manifest-head'), '{}', { mode: 0o600 });
    const marker = join(home, '.manifest-init.' + key());
    fs.writeFileSync(marker, 'null', { mode: 0o600 });
    expect(() => listMeetings(home)).toThrow(/manifest initializer conflicts/);
    expect(() => forcedStore().load()).toThrow(/manifest initializer conflicts/);
    expect(fs.existsSync(marker)).toBe(true);
  },
);

function setClaim(path: string, nonce: string) {
  const target = fs.openSync(path, 'r+');
  try {
    primitives.identityNonce(target, () => {}, nonce);
  } finally {
    fs.closeSync(target);
  }
}

it.each(['witness lost', 'witness symlink', 'public replacement', 'claim mismatch', 'canonical extra link', 'witness extra link'])(
  'rejects a recorded presence with %s', damage => {
    forcedStore().commit([], checkpoint);
    const path = join(home, '.presence');
    const anchor = join(home, '.presence.' + key());
    if (damage === 'witness lost') fs.unlinkSync(anchor);
    if (damage === 'witness symlink') {
      fs.renameSync(anchor, anchor + '-backup');
      fs.symlinkSync(anchor + '-backup', anchor);
    }
    if (damage === 'public replacement') {
      fs.copyFileSync(path, path + '-replacement');
      fs.renameSync(path + '-replacement', path);
      setClaim(path, binding().claim);
    }
    if (damage === 'claim mismatch') setClaim(path, randomUUID());
    if (damage === 'canonical extra link') fs.linkSync(path, path + '-extra');
    if (damage === 'witness extra link') fs.linkSync(anchor, path + '-extra');
    expect(() => forcedStore().load()).toThrow(/presence identity changed|ELOOP/);
  },
);

it.each(['v1 split copy', 'v1 aliased copy', 'v2 copy'])('enrolls a new lock domain for a %s', format => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', format === 'v2 copy' ? '1' : '0');
  new FileStore(home, clock).commit([], checkpoint);
  const expected = binding();
  const copy = join(home, 'copy');
  const files = fs.readdirSync(home);
  fs.mkdirSync(copy, { mode: 0o700 });
  for (const name of files) fs.cpSync(join(home, name), join(copy, name), { recursive: true });
  const oldAnchor = join(copy, '.presence.' + key());
  const copiedPresence = join(copy, '.presence');
  if (format === 'v1 aliased copy') {
    fs.unlinkSync(oldAnchor);
    fs.linkSync(copiedPresence, oldAnchor);
    expect(fs.statSync(copiedPresence).nlink).toBe(2);
  }
  forcedStore(copy).transaction(() => {});
  const current = binding(copy);
  expect(current).toMatchObject({ scheme: 'recorded', directory: key(copy), token: expected.token });
  expect(current.inode).not.toBe(expected.inode);
  expect(fs.statSync(copiedPresence).nlink).toBe(1);
  expect(fs.statSync(oldAnchor).nlink).toBe(1);
  expect(fs.statSync(copiedPresence).ino).not.toBe(fs.statSync(oldAnchor).ino);
  expect(JSON.parse(fs.readFileSync(join(copy, '.presence.' + key(copy)), 'utf8'))).toEqual(current);
  expect(binding()).toEqual(expected);
});

it.each([false, true])('resumes a v1 enrollment in forced mode with a surviving alias = %s', alias => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  new FileStore(home, clock).transaction(() => {});
  const expected = binding();
  const anchor = join(home, '.presence.' + key());
  fs.renameSync(join(home, '.manifest-state'), join(home, '.manifest-enrollment'));
  if (!alias) fs.unlinkSync(anchor);
  forcedStore().transaction(() => {});
  expect(binding().inode).toBe(expected.inode);
  expect(binding().token).toBe(expected.token);
  expect(binding().scheme).toBe(alias ? undefined : 'recorded');
  expect(fs.statSync(anchor).ino === fs.statSync(join(home, '.presence')).ino).toBe(alias);
});

function armedJournal(nonce: string, copyHasCheckpoint: boolean, preimage?: string) {
  const published = manifestBytes();
  const path = join(home, 'manifest.json');
  fs.renameSync(path, path + '-old');
  fs.writeFileSync(path, copyHasCheckpoint ? published : 'dirty', { mode: 0o600 });
  const { dev, ino } = fs.statSync(path, { bigint: true });
  const attempt = randomUUID();
  const directory = join(home, '.manifest-attempt-v2.' + key() + '.' + attempt);
  fs.mkdirSync(directory, { mode: 0o700 });
  const attemptStat = fs.statSync(directory, { bigint: true });
  const target = join(home, '.manifest-target-v2.' + key());
  const record = { dev: String(dev), ino: String(ino), nonce, bytes: preimage ?? published, attempt,
    attemptDev: String(attemptStat.dev), attemptIno: String(attemptStat.ino) };
  const bytes = JSON.stringify(record);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  const targetStat = fs.statSync(target, { bigint: true });
  fs.writeFileSync(join(directory, '.manifest-undo-v2.' + key()), JSON.stringify({
    dev: record.dev, ino: record.ino, nonce, targetDev: String(targetStat.dev), targetIno: String(targetStat.ino),
    digest: digest(bytes),
  }), { mode: 0o600 });
  fs.writeFileSync(join(directory, 'armed'), '', { mode: 0o600 });
  return { path, ino, published, target };
}

it.each([false, true])('checks a spoofed v2 journal identity in link mode, checkpoint already in place = %s', matches => {
  forcedStore().commit([], checkpoint);
  const { path, ino, published, target } = armedJournal(randomUUID(), matches);
  setClaim(path, randomUUID());
  let manifestWrites = 0;
  fs.writeSync = ((file: number, ...args: unknown[]) => {
    if (fs.readlinkSync('/proc/self/fd/' + file) === path) manifestWrites++;
    return Reflect.apply(originalWrite, fs, [file, ...args]);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  const reopened = new FileStore(home, clock);
  if (matches) {
    expect(reopened.load().checkpoint).toEqual(checkpoint);
    expect(fs.existsSync(target)).toBe(false);
  } else {
    expect(() => reopened.load()).toThrow(/manifest replacement disagrees/);
    expect(fs.existsSync(target)).toBe(true);
  }
  expect(manifestWrites).toBe(0);
  expect(fs.statSync(path, { bigint: true }).ino).toBe(ino);
  expect(manifestBytes()).toBe(matches ? published : 'dirty');
});

function expectQuarantinedPacket(bytes: Buffer) {
  const invalid = fs.readdirSync(packetDirectory()).filter(name => name.endsWith('.invalid'));
  expect(invalid).toHaveLength(1);
  expect(invalid[0]).toMatch(new RegExp('^' + packetName.replace('.', '\\.') + '\\.[0-9a-f-]{36}\\.invalid$'));
  expect(fs.readFileSync(join(packetDirectory(), invalid[0]!))).toEqual(bytes);
}

it('moves a foreign packet inserted after receipt sealing aside on retry', () => {
  const store = forcedStore();
  const foreign = Buffer.from('foreign packet');
  fs.copyFileSync = (src, dest, flags) => {
    if (String(dest).endsWith('/' + packetName)) {
      expect(fs.readdirSync(packetDirectory()).some(name => name.startsWith('.packet-receipt.'))).toBe(true);
      fs.writeFileSync(dest, foreign, { mode: 0o600, flag: 'wx' });
    }
    originalCopy(src, dest, flags);
  };
  syncBuiltinESMExports();
  expect(() => store.commit([meeting], checkpoint)).toThrow(/EEXIST/);
  expect(fs.readFileSync(packetPath())).toEqual(foreign);
  fs.copyFileSync = originalCopy;
  syncBuiltinESMExports();

  forcedStore().commit([meeting], checkpoint);
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe(JSON.stringify(meeting.packets[0]!.packet));
  expectQuarantinedPacket(foreign);
});

it.each(['absent destination', 'torn destination'])('syncs the packet receipt before retrying with %s', state => {
  const expected = JSON.stringify(meeting.packets[0]!.packet);
  const prefix = expected.slice(0, 12);
  fs.copyFileSync = (src, dest, flags) => {
    if (String(dest).endsWith('/' + packetName)) {
      if (state === 'torn destination') fs.writeFileSync(dest, prefix, { mode: 0o600, flag: 'wx' });
      throw new Error('interrupted packet copy');
    }
    originalCopy(src, dest, flags);
  };
  syncBuiltinESMExports();
  expect(() => forcedStore().commit([meeting], checkpoint)).toThrow(/interrupted packet copy/);
  let receiptSynced = false;
  fs.fsyncSync = file => {
    originalSync(file);
    if (fs.readlinkSync('/proc/self/fd/' + file) === packetDirectory() &&
        (state === 'absent destination' || fs.existsSync(packetPath()))) receiptSynced = true;
  };
  fs.copyFileSync = (src, dest, flags) => {
    if (String(dest).endsWith('/' + packetName)) expect(receiptSynced).toBe(true);
    originalCopy(src, dest, flags);
  };
  syncBuiltinESMExports();

  forcedStore().commit([meeting], checkpoint);
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe(expected);
  if (state === 'torn destination') {
    const invalid = fs.readdirSync(packetDirectory()).find(name => name.endsWith('.invalid'));
    expect(fs.readFileSync(join(packetDirectory(), invalid!), 'utf8')).toBe(prefix);
  }
});

it.each(['zero', 'garbage'])('republishes a %s-filled packet tear on retry', fill => {
  const expected = Buffer.from(JSON.stringify(meeting.packets[0]!.packet));
  const tear = fill === 'zero' ? Buffer.alloc(expected.length, 0) : Buffer.from('garbage tear that is not a prefix');
  fs.copyFileSync = (src, dest, flags) => {
    if (String(dest).endsWith('/' + packetName)) {
      fs.writeFileSync(dest, tear, { mode: 0o600, flag: 'wx' });
      throw new Error('interrupted packet copy');
    }
    originalCopy(src, dest, flags);
  };
  syncBuiltinESMExports();
  expect(() => forcedStore().commit([meeting], checkpoint)).toThrow(/interrupted packet copy/);
  fs.copyFileSync = originalCopy;
  syncBuiltinESMExports();

  forcedStore().commit([meeting], checkpoint);
  expect(fs.readFileSync(packetPath())).toEqual(expected);
  expectQuarantinedPacket(tear);
});

it.each(['0', '1'])('quarantines a receipt-claimed 0644 packet tear in mode %s', mode => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', mode);
  const packet = meeting.packets[0]!.packet;
  const tear = Buffer.from('torn packet');
  fs.mkdirSync(packetDirectory(), { recursive: true, mode: 0o700 });
  stagePacketRetry(JSON.stringify(packet));
  fs.writeFileSync(packetPath(), tear, { mode: 0o644 });
  fs.chmodSync(packetPath(), 0o644);

  new FileStore(home, clock).commit([meeting], checkpoint);

  expectQuarantinedPacket(tear);
  expect(fs.statSync(packetPath()).mode & 0o7777).toBe(0o600);
  expect(new FileStore(home, clock).load().meetings[0]!.packets[0]!.packet).toEqual(packet);
});

it('refuses to replace a packet bound to a different committed digest', () => {
  forcedStore().commit([meeting], checkpoint);
  const original = fs.readFileSync(packetPath());
  const changed = structuredClone(meeting);
  changed.packets[0]!.packet.header.created_at = '2026-01-01T00:00:01Z';
  const bytes = JSON.stringify(changed.packets[0]!.packet);
  const attempt = randomUUID();
  const dir = packetDirectory();
  const prefix = '.packet-receipt.' + packetName + '.';
  const receipt = fs.readdirSync(dir).find(name => name.startsWith(prefix))!;
  const reopened = forcedStore();
  expect(reopened.load().meetings[0]!.packets[0]!.packet).toEqual(meeting.packets[0]!.packet);

  // Inject the crashed attempt at packet publication so the earlier
  // snapshot checks can validate the receipt observed by load().
  const writePacket = primitives.StoreFiles.prototype.writePacket;
  const publish = vi.spyOn(primitives.StoreFiles.prototype, 'writePacket').mockImplementationOnce(function (
    this: primitives.StoreFiles, ...args: Parameters<typeof writePacket>
  ) {
    expect(this.dependencies.get(join(meeting.id, 'packets', packetName))?.digest).toBeUndefined();
    fs.rmdirSync(join(dir, receipt));
    fs.mkdirSync(join(dir, prefix + digest(bytes) + '.' + attempt), { mode: 0o700 });
    fs.writeFileSync(join(dir, '.packet-stage.' + attempt), bytes, { mode: 0o600 });
    return writePacket.apply(this, args);
  });
  try {
    expect(() => reopened.commit([changed], checkpoint)).toThrow(/committed.*conflict|conflict.*committed/i);
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    publish.mockRestore();
  }
  expect(fs.readFileSync(packetPath())).toEqual(original);
  expect(fs.readdirSync(dir).filter(name => name.endsWith('.invalid'))).toEqual([]);
});

it.each(['0', '1'])('leaves a torn packet untouched without a committed revision digest in mode %s', mode => {
  forcedStore().commit([meeting], checkpoint);
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  const linkStore = new FileStore(home, clock);
  linkStore.load();
  linkStore.commit([meeting], { ...checkpoint, position: 2 });
  expect(JSON.parse(manifestBytes()).revisionDigests?.[meeting.id]).toBeUndefined();
  const revisionPath = currentRevision();
  const revision = JSON.parse(fs.readFileSync(revisionPath, 'utf8'));
  const committedDigest = digest(fs.readFileSync(packetPath()));
  expect(revision.packets[0]).toMatchObject({
    packet_id: meeting.packets[0]!.packet.header.packet_id, packet_digest: committedDigest,
  });

  const changed = structuredClone(meeting);
  changed.packets[0]!.packet.header.created_at = '2026-01-01T00:00:01Z';
  const bytes = JSON.stringify(changed.packets[0]!.packet);
  expect(digest(bytes)).not.toBe(committedDigest);
  // Without a manifest digest, altered revision bytes can hide the committed binding.
  revision.packets[0].packet_digest = digest(bytes);
  fs.writeFileSync(revisionPath, JSON.stringify(revision));
  const dir = packetDirectory();
  const receipt = fs.readdirSync(dir).find(name => name.startsWith('.packet-receipt.' + packetName + '.'))!;
  fs.rmdirSync(join(dir, receipt));
  stagePacketRetry(bytes);
  const tear = Buffer.from('torn packet');
  fs.writeFileSync(packetPath(), tear);
  const inode = fs.statSync(packetPath(), { bigint: true }).ino;
  vi.stubEnv('COUNCIL_STORE_NO_LINK', mode);
  const retry = new FileStore(home, clock);
  retry.load();

  expect(() => retry.commit([changed], { ...checkpoint, position: 3 }))
    .toThrow(/Council store.*committed meeting revision digest.*missing/i);
  expect(fs.readFileSync(packetPath())).toEqual(tear);
  expect(fs.statSync(packetPath(), { bigint: true }).ino).toBe(inode);
  expect(fs.readdirSync(dir).filter(name => name.endsWith('.invalid'))).toEqual([]);
});

it.each(['malformed name', 'missing payload', 'damaged payload'])(
  'ignores higher checkpoint seal evidence with %s', damage => {
    forcedStore().commit([], checkpoint);
    const attempt = randomUUID();
    const bytes = manifestBytes();
    const seal = damage === 'malformed name' ? 'garbage' : digest(bytes) + '.' + attempt;
    fs.mkdirSync(join(home, '.commit-seal.99.' + seal), { mode: 0o700 });
    const dir = join(home, '.proof-attempt.' + attempt);
    fs.mkdirSync(dir, { mode: 0o700 });
    if (damage === 'damaged payload') fs.writeFileSync(join(dir, 'proof.json'), 'torn', { mode: 0o600 });
    if (damage === 'malformed name') {
      fs.mkdirSync(join(home, '.commit-seal.9007199254740992.garbage'), { mode: 0o700 });
    }
    const files = new primitives.StoreFiles(fd);
    expect(files.checkpointGeneration()).toBe(1);
    expect(() => files.readCheckpoint(99)).toThrow(damage === 'malformed name' ?
      /Invalid council store receipt/ : /sealed manifest commit proof is damaged/);
  },
);

function addCheckpointSeal(generation: number, bytes: string) {
  const attempt = randomUUID();
  const dir = join(home, '.proof-attempt.' + attempt);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(join(dir, 'proof.json'), bytes, { mode: 0o600 });
  fs.mkdirSync(join(home, `.commit-seal.${generation}.${digest(bytes)}.${attempt}`), { mode: 0o700 });
}

it('does not advance checkpoint discovery on a seal whose payload generation differs', () => {
  forcedStore().commit([], checkpoint);
  const bytes = manifestBytes();
  addCheckpointSeal(99, bytes);

  const files = new primitives.StoreFiles(fd);
  expect(files.checkpointGeneration()).toBe(1);
  expect(files.readCheckpoint(1)).toBe(bytes);
});

it.each(['0', '1'])('rejects a sealed checkpoint with a mismatched payload generation on direct read in mode %s', mode => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', mode);
  new FileStore(home, clock).commit([], checkpoint);
  addCheckpointSeal(99, manifestBytes());

  const files = new primitives.StoreFiles(fd, mode === '1');
  expect(() => files.readCheckpoint(99)).toThrow(/Council store.*generation/i);
});

it('advances checkpoint discovery on a correctly bound higher seal', () => {
  forcedStore().commit([], checkpoint);
  const manifest = JSON.parse(manifestBytes());
  manifest.generation = 2;
  addCheckpointSeal(2, JSON.stringify(manifest));

  expect(new primitives.StoreFiles(fd).checkpointGeneration()).toBe(2);
});

it('rejects an unexplained final revision even with verified pending bytes', () => {
  forcedStore().commit([meeting], checkpoint);
  const final = currentRevision();
  const bytes = fs.readFileSync(final);
  fs.writeFileSync(final + '.pending', bytes, { mode: 0o600 });
  fs.writeFileSync(final, 'foreign revision');
  const files = new primitives.StoreFiles(fd);
  files.inDirectory(files.root, meeting.id, dir => {
    expect(() => files.readRevision(dir, basename(final), true, digest(bytes))).toThrow(/Unexplained.*final meeting revision/);
  });
});

it('rejects interrupted init with only a surviving revision receipt', () => {
  const dir = join(home, meeting.id);
  fs.mkdirSync(dir);
  fs.mkdirSync(join(dir, '.revision-receipt.1-' + randomUUID() + '.json.' + digest('revision')), { mode: 0o700 });
  fs.mkdirSync(join(home, '.manifest-init.' + key()), { mode: 0o700 });
  fs.writeFileSync(join(home, 'manifest.json'), 'nu', { mode: 0o600 });
  expect(() => listMeetings(home)).toThrow(/manifest initializer conflicts with a meeting revision/);
  expect(manifestBytes()).toBe('nu');
});

it.each(['marker only', 'already null'])('preserves interrupted init when the self-probe fails with %s', state => {
  const marker = join(home, '.manifest-init.' + key());
  fs.mkdirSync(marker, { mode: 0o700 });
  if (state === 'already null') fs.writeFileSync(join(home, 'manifest.json'), 'null', { mode: 0o600 });
  const names = fs.readdirSync(home);
  fs.copyFileSync = () => { throw Object.assign(new Error('copy unavailable'), { code: 'EOPNOTSUPP' }); };
  syncBuiltinESMExports();

  expect(() => forcedStore().load()).toThrow(/fallback self-probe.*copy unavailable/);
  expect(fs.readdirSync(home)).toEqual(names);
  expect(fs.readdirSync(marker)).toEqual([]);
  if (state === 'already null') expect(manifestBytes()).toBe('null');
});

it('reads a verified packet stage before parsing a torn packet as JSON', () => {
  forcedStore().commit([meeting], checkpoint);
  fs.writeFileSync(packetPath(), '{');
  expect(listMeetings(home).map(x => x.meeting_id)).toEqual([meeting.id]);
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe('{');
  expect(forcedStore().load().meetings[0]!.packets[0]!.packet).toEqual(meeting.packets[0]!.packet);
});

it('adopts a validated v1 packet using its actual stored bytes', () => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  new FileStore(home, clock).commit([meeting], checkpoint);
  const pretty = JSON.stringify(meeting.packets[0]!.packet, null, 2);
  fs.writeFileSync(packetPath(), pretty);
  const store = forcedStore();
  store.load();
  store.commit([meeting], { ...checkpoint, position: 2 });
  const revision = JSON.parse(fs.readFileSync(currentRevision(), 'utf8'));
  expect(revision.packets[0].packet_digest).toBe(digest(pretty));
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe(pretty);
  store.commit([meeting], { ...checkpoint, position: 3 });
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe(pretty);
  fs.writeFileSync(packetPath(), JSON.stringify(meeting.packets[0]!.packet));
  expect(() => forcedStore().load()).toThrow(/packet contents disagree/);
});

it('fails closed on a legacy packet with unexplained bytes', () => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  new FileStore(home, clock).commit([meeting], checkpoint);
  fs.writeFileSync(packetPath(), '{"other":true}');
  const store = forcedStore();
  store.load();
  expect(() => store.commit([meeting], { ...checkpoint, position: 2 })).toThrow(/legacy packet contents changed/);
  expect(fs.readFileSync(packetPath(), 'utf8')).toBe('{"other":true}');
});

const spawnCuts = [
  ['probe set', '.copy-probe-', 1, 0], ['probe get', '.copy-probe-', 2, 0],
  ['presence get', '/.presence', 1, 0], ['presence set', '/.presence', 2, 0],
  ['presence readback', '/.presence', 3, 0], ['presence enrollment check', '/.presence', 4, 0],
  ['presence registration check', '/.presence', 5, 0],
  ['manifest get', '/manifest.json', 1, 0], ['manifest set', '/manifest.json', 2, 0],
  ['manifest readback', '/manifest.json', 3, 0], ['pre-rewrite verification', '/manifest.json', 4, 0],
  ['proof verification', '/manifest.json', 5, 0], ['pre-rename verification', '/manifest.json', 6, 1],
  ['post-rename verification', '/manifest.json', 7, 1],
] as const;

it.each(spawnCuts)('fails closed and reopens after xattr failure at %s', (_, match, ordinal, generation) => {
  let hits = 0;
  childProcess.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
    if (command === '/bin/getfattr' || command === '/bin/setfattr') {
      const path = fs.readlinkSync('/proc/self/fd/' + (options.stdio as number[])[3]);
      if (path.includes(match) && ++hits === ordinal) {
        return { pid: 0, status: 1, signal: null, stdout: '', stderr: 'injected xattr failure', output: [] };
      }
    }
    return originalSpawn(command, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  const store = forcedStore();
  expect(() => store.commit([], checkpoint)).toThrow(/injected xattr failure/);
  expect(new primitives.StoreFiles(fd).checkpointGeneration()).toBe(generation);
  childProcess.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  expect(forcedStore().load().checkpoint).toEqual(generation ? checkpoint : undefined);
});

it('reports the missing xattr executable before publishing any fallback artifacts', () => {
  childProcess.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
    if (command === '/bin/setfattr') {
      return { pid: 0, status: null, signal: null, stdout: '', stderr: '', output: [],
        error: Object.assign(new Error('missing attr executable'), { code: 'ENOENT' }) };
    }
    return originalSpawn(command, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  expect(() => forcedStore().commit([], checkpoint)).toThrow(/fallback self-probe.*xattr install unavailable/);
  expect(fs.readdirSync(home)).toEqual([]);
});

it('does not reuse empty or malformed nonce output as an absent attribute', () => {
  childProcess.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
    if (command === '/bin/getfattr') {
      const path = fs.readlinkSync('/proc/self/fd/' + (options.stdio as number[])[3]);
      if (path.endsWith('/.presence')) return { pid: 0, status: 0, signal: null, stdout: '', stderr: '', output: [] };
    }
    return originalSpawn(command, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  expect(() => forcedStore().commit([], checkpoint)).toThrow(/nonce is malformed/);
  expect(fs.existsSync(join(home, '.manifest-enrollment'))).toBe(false);
});

it('does not treat fallback checkpoint siblings as legacy commit evidence', () => {
  forcedStore().commit([], checkpoint);
  const seal = fs.readdirSync(home).find(name => name.startsWith('.commit-seal.'));
  fs.rmdirSync(join(home, seal!));
  expect(new primitives.StoreFiles(fd).checkpointGeneration()).toBe(0);
  expect(() => forcedStore().load()).toThrow(/manifest checkpoint record/);
});

it.each([1, 2])('retains the armed journal after recovery xattr read %s fails', ordinal => {
  const writer = forcedStore();
  writer.commit([], checkpoint);
  const prior = fs.readFileSync(join(home, '.manifest-state'), 'utf8');
  const next = { ...checkpoint, position: 2 };
  writer.commit([], next);
  const nonce = randomUUID();
  const { path, published, target } = armedJournal(nonce, false, JSON.parse(prior).manifest);
  fs.writeFileSync(join(home, '.manifest-state'), prior);
  setClaim(path, nonce);
  let hits = 0;
  childProcess.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
    if (command === '/bin/getfattr' && fs.readlinkSync('/proc/self/fd/' +
      (options.stdio as number[])[3]) === path && ++hits === ordinal) {
      return { pid: 0, status: null, signal: 'SIGKILL', stdout: '', stderr: '', output: [] };
    }
    return originalSpawn(command, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  expect(() => forcedStore().load()).toThrow(/xattr read failed: SIGKILL/);
  expect(manifestBytes()).toBe(ordinal === 1 ? 'dirty' : published);
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.readFileSync(join(home, '.manifest-state'), 'utf8')).toBe(prior);
  childProcess.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  expect(forcedStore().load().checkpoint).toEqual(next);
  expect(manifestBytes()).toBe(published);
  expect(fs.existsSync(target)).toBe(false);
});

it('forces fallback with the adapter option and keeps the held mode through nested adapters', () => {
  vi.stubEnv('COUNCIL_STORE_NO_LINK', '0');
  const outer = new FileStore(home, clock, { forceNoLink: true });
  const nested = new FileStore(home, clock);
  fs.linkSync = () => { throw new Error('unexpected hard link'); };
  syncBuiltinESMExports();
  outer.transaction(() => nested.commit([], checkpoint));
  expect(binding().scheme).toBe('recorded');
  expect(JSON.parse(manifestBytes()).proofScheme).toBe('sealed');
});

it.each(['fresh', 'copied'] as const)('resumes a %s enrollment after tearing the recorded witness copy', format => {
  let root = home;
  if (format === 'copied') {
    forcedStore().commit([], checkpoint);
    root = fs.mkdtempSync(join(home, 'copied-'));
    for (const name of fs.readdirSync(home).filter(name => !name.startsWith('copied-'))) {
      fs.cpSync(join(home, name), join(root, name), { recursive: true });
    }
  }
  const anchor = join(root, '.presence.' + key(root));
  fs.copyFileSync = (src, dest, flags) => {
    if (basename(String(dest)) === basename(anchor)) {
      fs.writeFileSync(dest, fs.readFileSync(src).subarray(0, 20), { flag: 'wx', mode: 0o600 });
      throw new Error('injected witness cut');
    }
    originalCopy(src, dest, flags);
  };
  syncBuiltinESMExports();
  expect(() => forcedStore(root).transaction(() => {})).toThrow(/injected witness cut/);
  expect(fs.readFileSync(anchor).length).toBe(20);
  fs.copyFileSync = originalCopy;
  syncBuiltinESMExports();
  forcedStore(root).transaction(() => {});
  expect(JSON.parse(fs.readFileSync(anchor, 'utf8'))).toEqual(binding(root));
  expect(binding(root).directory).toBe(key(root));
  expect(fs.readdirSync(root).some(name => name.startsWith('.presence-witness-') && name.endsWith('.invalid'))).toBe(true);
});

it('admits the v2 initialization marker immediately after mkdir without a manifest', () => {
  const marker = join(home, '.manifest-init.' + key());
  fs.mkdirSync = ((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
    const result = originalMkdir(path, options);
    if (basename(String(path)) === basename(marker)) throw new Error('injected marker cut');
    return result;
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  expect(() => forcedStore().commit([], checkpoint)).toThrow(/injected marker cut/);
  expect(fs.statSync(marker).isDirectory()).toBe(true);
  expect(listMeetings(home)).toEqual([]);
  expect(fs.existsSync(marker)).toBe(true);
  expect(forcedStore().load()).toEqual({ meetings: [] });
  expect(fs.existsSync(marker)).toBe(false);
});

it.each(['chmod', 'hard link'])('rejects a pending revision %s before sealing', damage => {
  fs.fsyncSync = file => {
    originalSync(file);
    const path = fs.readlinkSync('/proc/self/fd/' + file);
    if (!path.endsWith('/proof.json')) return;
    const dir = join(home, meeting.id);
    const name = fs.readdirSync(dir).find(name => name.endsWith('.json.pending'));
    const pending = join(dir, name!);
    if (damage === 'chmod') fs.chmodSync(pending, 0o644);
    else fixtureLink(pending, pending + '.extra');
  };
  syncBuiltinESMExports();
  expect(() => forcedStore().commit([meeting], checkpoint)).toThrow(/meeting revision identity changed/);
  expect(new primitives.StoreFiles(fd).checkpointGeneration()).toBe(0);
});
