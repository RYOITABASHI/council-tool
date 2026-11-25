import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Core } from '../src/core/index.js';
import type { Meeting, Operations, RoundRecord } from '../src/core/model.js';

installXattrTestTransport();
guardStoreLinks();

// These tests wait for subprocesses and their file locks under parallel load.
const forced = process.env.COUNCIL_STORE_NO_LINK === '1';
vi.setConfig({ testTimeout: forced ? 60_000 : 15_000 });

let home: string;
let script: string;
let sandbox: string;
let workerDirectory: string;
const workers: { child: ReturnType<typeof fork>; done: Promise<unknown> }[] = [];

beforeAll(() => {
  workerDirectory = mkdtempSync(join(tmpdir(), 'council-presence-worker-'));
  script = join(workerDirectory, 'peer.mjs');
  buildSync({
    stdin: { resolveDir: process.cwd(), contents: `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { Core } from './src/core/index.ts';
      import { installXattrTestTransport } from './test/store-test-platform.ts';
      installXattrTestTransport();
      const [home, epoch, skew, count, tick, startupPause] = process.argv.slice(2);
      const wall = Date.now;
      Date.now = () => wall() + Number(skew);
      const chair = { id: 'chair', kind: 'human' };
      const create = core => core.create_meeting(chair, {
        topic: epoch, chair: { principal: chair.id },
        seats: [{ seat_id: 'a', principal: 'seat', connection: 'cli' }],
      });
      let pauseAt = startupPause;
      function pause() {
        pauseAt = undefined;
        fs.writeSync(1, 'paused');
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      const { copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } = fs;
      fs.fsyncSync = fd => {
        if (pauseAt === 'fail-directory-sync' && fs.fstatSync(fd).isDirectory()) {
          pauseAt = undefined;
          throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
        }
        if (pauseAt === 'fail-before-checkpoint' &&
            /\\.checkpoint\\.\\d+\\.json\\..+\\.tmp$/.test(fs.readlinkSync('/proc/self/fd/' + fd))) {
          pauseAt = undefined;
          throw Object.assign(new Error('injected checkpoint sync failure'), { code: 'EIO' });
        }
        fsyncSync(fd);
        if (!pauseAt) return;
        const path = fs.readlinkSync('/proc/self/fd/' + fd);
        if (pauseAt === 'presence-token' && path.endsWith('/.presence')) {
          pause();
        } else if (pauseAt === 'next-directory-sync' && fs.fstatSync(fd).isDirectory()) {
          pause();
        } else if (pauseAt === 'enrollment-record-staged' && /\\.manifest-(state|enrollment)\\..+\\.tmp$/.test(path)) {
          pause();
        } else if (pauseAt === 'staged' && /manifest\\.json\\..+\\.tmp$/.test(path)) {
          pause();
        } else if (pauseAt === 'check' && /manifest\\.json\\..+\\.tmp$/.test(path)) {
          pauseAt = 'final-check';
        } else if (pauseAt === 'manifest-written-sync' && path.endsWith('/manifest.json')) {
          pause();
        } else if (/\\.checkpoint\\.\\d+\\.json\\..+\\.tmp$/.test(path)) {
          if (pauseAt === 'publishing-checkpoint' || pauseAt === 'pending-revision-before-proof') pause();
          if (pauseAt === 'finalize') pauseAt = 'finalizing-checkpoint';
        }
      };
      fs.statSync = (path, options) => {
        const result = statSync(path, options);
        if (pauseAt === 'final-check' && String(path).endsWith('/manifest.json')) pause();
        return result;
      };
      fs.lstatSync = (path, options) => {
        const result = lstatSync(path, options);
        if (pauseAt === 'final-check' && String(path).endsWith('/manifest.json')) pause();
        if (pauseAt === 'finalizing-checkpoint' && /\\/\\.manifest-target(?:-v2)?\\./.test(String(path))) pause();
        return result;
      };
      function published(to) {
        if (pauseAt?.startsWith('pending-revision-') && to.endsWith('.json.pending')) {
          // Use a timestamp the test can restore exactly with Node's utimesSync.
          fs.utimesSync(to, 1000, 1000);
        }
        if (pauseAt === 'target-linked' && /\\/\\.manifest-target(?:-v2)?\\./.test(to)) pause();
        if (pauseAt === 'undo-linked' && /\\/\\.manifest-undo(?:-v2)?\\./.test(to)) pause();
        if (/\\.commit-proof\\.\\d+\\.json$|\\.commit-seal\\.\\d+\\./.test(to)) {
          if (pauseAt === 'commit-proof') pause();
          if (pauseAt === 'fail-proof-sync') pauseAt = 'fail-directory-sync';
        }
        if (pauseAt === 'commit-record' && /\\.commit\\.\\d+\\.json$/.test(to)) pause();
        if (/\\.checkpoint\\.\\d+\\.json$/.test(to)) {
          if (pauseAt === 'checkpoint' || pauseAt === 'pending-revision-after-proof') pause();
          if (pauseAt === 'checkpoint-synced') pauseAt = 'next-directory-sync';
          if (pauseAt === 'fail-checkpoint-sync') pauseAt = 'fail-directory-sync';
        }
        if (to.includes('/.presence.')) {
          if (pauseAt === 'presence-linked') pause();
          if (pauseAt === 'presence-synced') pauseAt = 'next-directory-sync';
          if (pauseAt === 'fail-presence-sync') pauseAt = 'fail-directory-sync';
        }
        if (pauseAt === 'fail-revision-sync' && /\\/\\d+-[0-9a-f-]{36}\\.json$/.test(to)) {
          pauseAt = 'fail-directory-sync';
        }
      }
      fs.linkSync = (from, to) => {
        if (process.env.COUNCIL_STORE_NO_LINK === '1' && !String(to).includes('/.link-probe-')) {
          throw new Error('Store worker called linkSync in forced mode');
        }
        linkSync(from, to);
        published(String(to));
      };
      fs.copyFileSync = (from, to, flags) => {
        copyFileSync(from, to, flags);
        published(String(to));
      };
      fs.mkdirSync = (path, options) => {
        const result = mkdirSync(path, options);
        if (String(path).includes('/.commit-seal.')) published(String(path));
        return result;
      };
      fs.renameSync = (from, to) => {
        if (pauseAt === 'rename' && to.endsWith('/manifest.json')) pause();
        renameSync(from, to);
        if (pauseAt === 'enrollment-intent' && to.endsWith('/.manifest-enrollment')) pause();
        if (to.endsWith('/.manifest-state')) {
          if (pauseAt === 'enrollment-record') pause();
          if (pauseAt === 'enrollment-record-synced') pauseAt = 'next-directory-sync';
          if (pauseAt === 'migration-record' && !from.endsWith('/.manifest-enrollment')) pause();
          if (pauseAt === 'fail-publication-sync') pauseAt = 'fail-directory-sync';
        }
      };
      fs.writeSync = (fd, ...args) => {
        if (pauseAt === 'rename' || pauseAt === 'written') {
          if (fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/manifest.json')) {
            if (pauseAt === 'rename') pause();
            else pauseAt = 'manifest-written-sync';
          }
        }
        return writeSync(fd, ...args);
      };
      fs.writeFileSync = (file, data, ...options) => {
        if (pauseAt === 'partial-presence-token' && typeof file === 'number' &&
            /\\/\\.presence(?:-token\\..+\\.tmp)?$/.test(fs.readlinkSync('/proc/self/fd/' + file))) {
          writeSync(file, Buffer.from(data).subarray(0, 9));
          pause();
        }
        return writeFileSync(file, data, ...options);
      };
      fs.unlinkSync = path => {
        unlinkSync(path);
        if (pauseAt === 'unlinked' && /\\/\\.manifest-undo(?:-v2)?\\.\\d+:\\d+$/.test(String(path))) pause();
      };
      syncBuiltinESMExports();
      try {
        const core = new Core({ home, clock: {
          epoch, now: () => ({ monotonic: BigInt(tick), wall: BigInt(Date.now()) * 1_000_000n }),
        } });
        for (let index = 0; index < Number(count); index++) {
          const { meeting_id } = await create(core);
          await core.open_round(chair, {
            meeting_id, round: 'R0', deadline: { kind: 'relative', seconds: 10 },
          });
        }
        await core.sweep();
        process.on('message', async request => {
          try {
            if (request === 'stop-while-idle') {
              fs.writeSync(1, 'stopping ' + fs.readlinkSync('/proc/self'));
              process.kill(process.pid, 'SIGSTOP');
              return;
            }
            if (request === 'sweep') {
              await core.sweep();
            } else {
              pauseAt = request.pauseAt;
              await create(core);
            }
            process.send({ ok: true });
          } catch (error) {
            process.send({ ok: false, message: error.message });
          } finally {
            pauseAt = undefined;
          }
        });
        process.send({ ok: true });
      } catch (error) {
        process.send({ ok: false, message: error.message }, () => process.disconnect());
      }
    ` },
    bundle: true, platform: 'node', format: 'esm', outfile: script,
  });
});

afterAll(() => {
  rmSync(workerDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'council-presence-'));
  home = join(sandbox, 'store');
});

afterEach(async () => {
  for (const { child } of workers) child.kill('SIGKILL');
  await Promise.all(workers.splice(0).map(({ done }) => done));
  rmSync(sandbox, { recursive: true, force: true });
});

function peer(epoch: string, { skew = 0, count = 0, tick = '0', root = home, maxFiles = 0, startupPause = '',
  noLink = forced } = {}) {
  const args = [root, epoch, String(skew), String(count), tick, startupPause];
  const stdio: ['pipe', 'pipe', 'inherit', 'ipc'] = ['pipe', 'pipe', 'inherit', 'ipc'];
  const env = { ...process.env, COUNCIL_STORE_NO_LINK: noLink ? '1' : '0' };
  const child = maxFiles
    ? spawn('bash', ['-c', 'ulimit -n "$1" && shift && exec "$@"', 'peer', String(maxFiles), process.execPath, script, ...args], { stdio, env })
    : fork(script, args, { execArgv: [], stdio, env });
  const done = once(child, 'exit');
  const ready = Promise.race([
    once(child, 'message').then(([message]) => message),
    done.then(() => { throw new Error('Peer exited before reporting its result'); }),
  ]);
  const worker = { child, done, ready };
  workers.push(worker);
  return worker;
}

const manifest = () => readFileSync(join(home, 'manifest.json'), 'utf8');
const sealedFields = forced ? { proofScheme: 'sealed' } : {};

function proofPath(generation: number): string {
  const seal = readdirSync(home).find(name => name.startsWith(`.commit-seal.${generation}.`));
  return seal
    ? join(home, '.proof-attempt.' + seal.split('.').at(-1), 'proof.json')
    : join(home, `.commit-proof.${generation}.json`);
}

it('recovers a forced writer’s interrupted v2 journal in link mode', async () => {
  const owner = peer('a', { noLink: true });
  expect(await owner.ready).toEqual({ ok: true });
  await pauseCreation(owner.child, 'commit-proof');
  const candidate = manifest();
  const { generation, meetings, proofScheme } = JSON.parse(candidate);
  expect(proofScheme).toBe('sealed');
  expect(Object.keys(meetings)).toHaveLength(1);
  expect(readdirSync(home).some(name => name.startsWith('.manifest-target-v2.'))).toBe(true);
  expect(owner.child.kill('SIGKILL')).toBe(true);
  expect(await owner.done).toEqual([null, 'SIGKILL']);
  expect(await peer('a', { noLink: false }).ready).toEqual({ ok: true });
  expect(manifest()).toBe(candidate);
  expect(readFileSync(proofPath(generation), 'utf8')).toBe(candidate);
  expect(JSON.parse(readFileSync(join(home, '.manifest-state'), 'utf8')).manifest).toBe(candidate);
  expect(readdirSync(home).some(name => name.startsWith('.manifest-target-v2.'))).toBe(false);
}, 60_000);

function replaceFile(path: string, source = path) {
  const replacement = join(sandbox, 'incoming.json');
  cpSync(source, replacement);
  renameSync(replacement, path);
}

function replaceStore() {
  const original = join(sandbox, 'original');
  renameSync(home, original);
  cpSync(original, home, { recursive: true });
}

async function commitInReplacement() {
  const before = Object.keys(JSON.parse(manifest()).meetings);
  const replacement = peer('replacement', { count: 1 });
  expect(await replacement.ready).toEqual({ ok: true });
  const published = manifest();
  const { checkpoint, meetings } = JSON.parse(published);
  expect(checkpoint.epoch).toBe('replacement');
  const added = Object.keys(meetings).filter(id => !before.includes(id));
  expect(added).toHaveLength(1);
  const newMeeting = () => readFileSync(join(home, added[0], meetings[added[0]] + '.json'), 'utf8');
  const meeting = newMeeting();
  expect(JSON.parse(meeting).topic).toBe('replacement');
  return {
    replacement,
    assertPreserved() {
      expect.soft(manifest()).toBe(published);
      expect.soft(newMeeting()).toBe(meeting);
    },
  };
}

function requestCreate(child: ReturnType<typeof fork>, pauseAt?: string) {
  const response = once(child, 'message').then(([message]) => message);
  child.send({ pauseAt });
  return response;
}

async function pauseCreation(child: ReturnType<typeof fork>, pauseAt: string) {
  const response = requestCreate(child, pauseAt);
  const reported = await Promise.race([
    once(child.stdout!, 'data').then(([data]) => String(data)),
    response.then(result => ({ earlyResponse: result })),
  ]);
  expect(reported).toBe('paused');
  return async () => {
    child.stdin!.write('1');
    return response;
  };
}

async function expectStartupPaused({ child, ready }: ReturnType<typeof peer>) {
  const stopped = await Promise.race([
    once(child.stdout!, 'data').then(([data]) => String(data)),
    ready,
  ]);
  expect(stopped).toBe('paused');
}

function editWithRestoredMtime(path: string, original: string, edited: string) {
  expect(edited).not.toBe(original);
  expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(original));
  const before = statSync(path, { bigint: true });
  writeFileSync(path, edited);
  utimesSync(path, 1000, 1000);
  const after = statSync(path, { bigint: true });
  expect(after).toMatchObject({ ino: before.ino, size: before.size, mtimeNs: before.mtimeNs });
}

it.each([
  { pauseAt: 'pending-revision-before-proof', tamper: true, description: 'rejects a pending edit before committing the checkpoint' },
  { pauseAt: 'pending-revision-after-proof', tamper: true, description: 'rejects a pending edit before linking the revision' },
  { pauseAt: 'checkpoint', tamper: false, description: 'publishes an untouched pending revision' },
])('$description', async ({ pauseAt, tamper }) => {
  const owner = peer('a');
  expect(await owner.ready).toEqual({ ok: true });
  const before = manifest();
  const resume = await pauseCreation(owner.child, pauseAt);
  const meetings = readdirSync(home, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  expect(meetings).toHaveLength(1);
  const directory = join(home, meetings[0].name);
  const pendingNames = readdirSync(directory).filter(name => name.endsWith('.json.pending'));
  expect(pendingNames).toHaveLength(1);
  const pending = join(directory, pendingNames[0]);
  const published = pending.slice(0, -'.pending'.length);
  const original = readFileSync(pending, 'utf8');
  expect(existsSync(published)).toBe(false);

  if (tamper) {
    const edited = original.replace('"topic":"a"', '"topic":"b"');
    editWithRestoredMtime(pending, original, edited);
    expect(await resume()).toEqual({ ok: false, message: expect.stringMatching(/meeting revision contents changed/i) });
    expect(existsSync(published)).toBe(false);
    if (pauseAt === 'pending-revision-before-proof') {
      expect(manifest()).toBe(before);
      const generation = JSON.parse(before).generation + 1;
      expect(existsSync(proofPath(generation))).toBe(false);
      expect(readdirSync(home).some(name => name.startsWith(`.commit-seal.${generation}.`))).toBe(false);
    } else {
      expect(await peer('a').ready).toEqual({ ok: false, message: expect.stringMatching(forced
        ? /meeting revision contents disagree/ : /ENOENT.*\.json\.pending/) });
      expect(existsSync(published)).toBe(false);
      if (forced) {
        // No verified replacement survives, so the fallback leaves the evidence in place.
        expect(readFileSync(pending, 'utf8')).toBe(edited);
      } else {
        const [rejected] = readdirSync(directory).filter(name => name.startsWith(pendingNames[0] + '.'));
        expect(rejected).toBeDefined();
        expect(readFileSync(join(directory, rejected), 'utf8')).toBe(edited);
      }
    }
  } else {
    expect(await resume()).toEqual({ ok: true });
    expect(readFileSync(published, 'utf8')).toBe(original);
    expect(existsSync(pending)).toBe(false);
  }
});

it('rejects a different epoch with a fast wall clock while a peer is alive', async () => {
  expect(await peer('a', { count: 1 }).ready).toEqual({ ok: true });
  const published = manifest();
  expect.soft(await peer('b', { skew: 15_000 }).ready).toMatchObject({ ok: false, message: expect.stringMatching(/live.*epoch/i) });
  expect(manifest()).toBe(published);
});

it('retains ownership while a peer is stopped and after it resumes', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  // Stop the worker between transactions so only its presence lock is held.
  const stopping = once(owner.child.stdout!, 'data');
  owner.child.send('stop-while-idle');
  // The procfs mount can expose a different PID namespace than child.pid.
  const ack = /^stopping ([0-9]+)$/.exec(String((await stopping)[0]));
  expect(ack).not.toBeNull();
  await expect.poll(() => {
    const stat = readFileSync(`/proc/${ack![1]}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2];
  }, { timeout: 5000 }).toBe('T');
  const published = manifest();
  await delay(1250);
  const foreign = peer('b');
  expect.soft(await foreign.ready).toMatchObject({ ok: false, message: expect.stringMatching(/live.*epoch/i) });
  expect.soft(manifest()).toBe(published);
  expect(owner.child.kill('SIGCONT')).toBe(true);
  const resumed = once(owner.child, 'message');
  owner.child.send('sweep');
  const [message] = await resumed;
  expect(message).toEqual({ ok: true });
  expect(manifest()).toBe(published);
});

it('takes over on the first attempt after SIGKILL without advancing the round by wall time', async () => {
  const owner = peer('a', { skew: 5000, count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  owner.child.kill('SIGKILL');
  await owner.done;
  expect(await peer('b').ready).toEqual({ ok: true });
  const { checkpoint, meetings } = JSON.parse(manifest());
  expect(checkpoint.epoch).toBe('b');
  const [id, revision] = Object.entries(meetings)[0];
  const meeting = JSON.parse(readFileSync(join(home, id, revision + '.json'), 'utf8'));
  expect(meeting.rounds[0].rows[0].state).toBe('pending');
});

it('keeps a live owner protected after .presence is replaced with identical bytes', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const published = manifest();
  replaceFile(join(home, '.presence'));

  expect.soft(await peer('b').ready).toMatchObject({ ok: false });
  expect.soft(manifest()).toBe(published);
  expect.soft(await requestCreate(owner.child)).toMatchObject({
    ok: false, message: expect.stringMatching(/store presence.*changed/i),
  });
  expect(manifest()).toBe(published);
});

it.each(['deleted', 'rolled back', 'rewritten in place'])('rejects a manifest %s between transactions', async damage => {
  const owner = peer('a');
  expect(await owner.ready).toEqual({ ok: true });
  const initial = manifest();
  expect(await requestCreate(owner.child)).toEqual({ ok: true });
  const [[id, revision]] = Object.entries(JSON.parse(manifest()).meetings);
  const meetingPath = join(home, id, revision + '.json');
  const committed = readFileSync(meetingPath, 'utf8');
  const path = join(home, 'manifest.json');
  if (damage === 'deleted') {
    unlinkSync(path);
  } else if (damage === 'rolled back') {
    const old = join(sandbox, 'old.json');
    writeFileSync(old, initial);
    renameSync(old, path);
  } else {
    writeFileSync(path, initial);
  }

  const refusal = { ok: false, message: expect.stringMatching(/store manifest/i) };
  expect.soft(await peer('a').ready).toMatchObject(refusal);
  expect.soft(await requestCreate(owner.child)).toMatchObject(refusal);
  expect.soft(existsSync(path) ? manifest() : undefined).toBe(damage === 'deleted' ? undefined : initial);
  expect(readFileSync(meetingPath, 'utf8')).toBe(committed);
});

it('rejects an epoch takeover after both presence names are deleted while the owner is alive', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const published = manifest();
  const [[id, revision]] = Object.entries(JSON.parse(published).meetings);
  const meetingPath = join(home, id, revision + '.json');
  const committed = readFileSync(meetingPath, 'utf8');
  const presenceNames = () => readdirSync(home).filter(name => name === '.presence' || name.startsWith('.presence.'));
  expect(presenceNames()).toHaveLength(2);
  for (const name of presenceNames()) unlinkSync(join(home, name));

  const refusal = { ok: false, message: expect.stringMatching(/store presence.*changed/i) };
  expect.soft(await peer('b').ready).toMatchObject(refusal);
  expect.soft(await requestCreate(owner.child)).toMatchObject(refusal);
  expect.soft(presenceNames()).toEqual([]);
  expect.soft(manifest()).toBe(published);
  expect(readFileSync(meetingPath, 'utf8')).toBe(committed);
});

it('rejects an idle peer after its store directory is replaced', async () => {
  const owner = peer('original', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  replaceStore();
  const { replacement, assertPreserved } = await commitInReplacement();
  // With the replacement peer gone, its presence lock cannot explain the rejection.
  replacement.child.kill('SIGKILL');
  await replacement.done;
  expect.soft(await requestCreate(owner.child)).toMatchObject({
    ok: false, message: expect.stringMatching(/store directory.*changed/i),
  });
  assertPreserved();
});

it.each(['staged', 'rename'])('rejects an in-flight peer after directory replacement at %s', async pauseAt => {
  const owner = peer('original', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const published = manifest();
  const resume = await pauseCreation(owner.child, pauseAt);
  replaceStore();
  // The replacement commits while the original peer still holds its transaction lock.
  const { assertPreserved } = await commitInReplacement();
  expect.soft(await resume()).toMatchObject({
    ok: false, message: expect.stringMatching(/store directory.*changed/i),
  });
  assertPreserved();
  expect(readFileSync(join(sandbox, 'original', 'manifest.json'), 'utf8')).toBe(published);
});

it('rejects a publication if an identical manifest replaces the one read in the transaction', async () => {
  const owner = peer('original', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const paused = once(owner.child.stdout!, 'data');
  const response = requestCreate(owner.child, 'staged');
  expect(String((await paused)[0])).toBe('paused');
  const path = join(home, 'manifest.json');
  const replacement = join(home, 'replacement.json');
  const published = manifest();
  cpSync(path, replacement);
  renameSync(replacement, path);
  owner.child.stdin!.write('1');
  expect.soft(await response).toMatchObject({
    ok: false, message: expect.stringMatching(/store manifest.*changed/i),
  });
  expect(manifest()).toBe(published);
});

async function prepareCommittedManifest() {
  const previous = JSON.parse(manifest()).meetings;
  const otherRoot = join(sandbox, 'other-store');
  cpSync(home, otherRoot, { recursive: true });
  expect(await peer('a', { root: otherRoot, count: 1 }).ready).toEqual({ ok: true });
  const otherManifest = join(otherRoot, 'manifest.json');
  const published = readFileSync(otherManifest, 'utf8');
  const { meetings } = JSON.parse(published);
  const added = Object.keys(meetings).filter(id => !Object.hasOwn(previous, id));
  expect(added).toHaveLength(1);
  const [id] = added;
  const source = join(otherRoot, id);
  const destination = join(home, id);
  const revision = join(destination, meetings[id] + '.json');
  const committed = readFileSync(join(source, meetings[id] + '.json'), 'utf8');
  const installRevision = () => cpSync(source, destination, { recursive: true });
  return { otherRoot, otherManifest, published, revision, committed, installRevision };
}

it.each(['staged', 'check', 'rename', 'written', 'finalize', 'publishing-checkpoint'])('preserves another peer’s committed meeting when the manifest is replaced at %s', async pauseAt => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const durablePath = join(home, '.manifest-state');
  const durable = readFileSync(durablePath, 'utf8');
  const { otherManifest, published, revision, committed, installRevision } = await prepareCommittedManifest();
  const resume = await pauseCreation(owner.child, pauseAt);
  installRevision();
  const path = join(home, 'manifest.json');
  replaceFile(path, otherManifest);
  const inode = statSync(path, { bigint: true }).ino;
  expect.soft(await resume()).toMatchObject({
    ok: false, message: expect.stringMatching(/store manifest.*changed/i),
  });
  expect.soft(manifest()).toBe(published);
  expect.soft(statSync(path, { bigint: true }).ino).toBe(inode);
  expect.soft(readFileSync(durablePath, 'utf8')).toBe(durable);
  expect(readFileSync(revision, 'utf8')).toBe(committed);
});

it.each([
  ['packet', 'staged'], ['packet', 'rename'], ['packet', 'written'],
  ['meeting revision', 'rename'], ['presence', 'rename'],
])('rejects publication after an identical %s is replaced at %s', async (file, pauseAt) => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const published = manifest();
  const [id, revision] = Object.entries(JSON.parse(published).meetings)[0];
  const packets = join(home, id, 'packets');
  const [packet] = readdirSync(packets).filter(name => !name.startsWith('.'));
  expect(packet).toBeDefined();
  const path = {
    packet: join(packets, packet),
    'meeting revision': join(home, id, revision + '.json'),
    presence: join(home, '.presence'),
  }[file]!;
  const bytes = readFileSync(path, 'utf8');

  const resume = await pauseCreation(owner.child, pauseAt);
  replaceFile(path);
  const inode = statSync(path, { bigint: true }).ino;
  expect.soft(await resume()).toMatchObject({
    ok: false, message: expect.stringMatching(new RegExp('store ' + file + '.*changed', 'i')),
  });
  expect.soft(manifest()).toBe(published);
  expect.soft(statSync(path, { bigint: true }).ino).toBe(inode);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});

it('recovers the prior snapshot after a writer dies during publication', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const published = manifest();
  await pauseCreation(owner.child, 'written');
  expect(manifest()).not.toBe(published);
  expect(owner.child.kill('SIGKILL')).toBe(true);
  await owner.done;
  expect(await peer('a').ready).toEqual({ ok: true });
  expect(manifest()).toBe(published);
});

it.each([
  ['publishing-checkpoint', false], ['commit-proof', true], ['commit-record', true],
  ['checkpoint', true], ['unlinked', true],
] as const)(
  'recovers the correct durable snapshot after the writer dies at %s',
  async (pauseAt, committed) => {
    const owner = peer('a', { count: 1 });
    expect(await owner.ready).toEqual({ ok: true });
    const before = manifest();
    await pauseCreation(owner.child, pauseAt);
    const candidate = manifest();
    expect(candidate).not.toBe(before);
    const { generation } = JSON.parse(candidate);
    if (pauseAt === 'commit-proof') {
      expect(existsSync(join(home, `.checkpoint.${generation}.json`))).toBe(false);
      expect(existsSync(join(home, `.commit.${generation}.json`))).toBe(false);
    }
    expect(owner.child.kill('SIGKILL')).toBe(true);
    await owner.done;
    expect(await peer('a').ready).toEqual({ ok: true });
    expect(manifest()).toBe(committed ? candidate : before);
    if (committed) {
      const checkpoint = join(home, `.checkpoint.${generation}.json`);
      const proof = proofPath(generation);
      expect(readFileSync(checkpoint, 'utf8')).toBe(candidate);
      expect(readFileSync(join(home, `.commit.${generation}.json`), 'utf8')).toBe(candidate);
      expect(readFileSync(proof, 'utf8')).toBe(candidate);
      expect(statSync(proof, { bigint: true }).ino).not.toBe(statSync(checkpoint, { bigint: true }).ino);
    }
  },
);

it.each(['interrupted cleanup', 'matching old manifest'])(
  'rejects an older durable record with %s',
  async failure => {
    const owner = peer('a');
    expect(await owner.ready).toEqual({ ok: true });
    expect(await requestCreate(owner.child)).toEqual({ ok: true });
    const durablePath = join(home, '.manifest-state');
    const prior = readFileSync(durablePath, 'utf8');
    expect(await requestCreate(owner.child)).toEqual({ ok: true });
    const published = manifest();
    expect(Object.keys(JSON.parse(published).meetings)).toHaveLength(2);
    const committed = readFileSync(durablePath, 'utf8');
    expect(owner.child.kill('SIGKILL')).toBe(true);
    await owner.done;

    const path = join(home, 'manifest.json');
    if (failure === 'interrupted cleanup') {
      const { dev, ino } = statSync(home, { bigint: true });
      linkSync(path, join(home, `.manifest-target.${dev}:${ino}`));
    } else {
      writeFileSync(path, JSON.parse(prior).manifest);
    }
    writeFileSync(durablePath, prior);
    const beforeReopen = manifest();
    expect.soft(await peer('a').ready).toMatchObject({
      ok: false, message: expect.stringMatching(/store manifest/i),
    });
    expect.soft(manifest()).toBe(beforeReopen);
    expect(readFileSync(durablePath, 'utf8')).toBe(prior);

    writeFileSync(path, published);
    writeFileSync(durablePath, committed);
    expect(await peer('a').ready).toEqual({ ok: true });
    expect(manifest()).toBe(published);
  },
);

const legacyName = (revision: string) => revision.replace(/^[1-9]\d*-(?=[0-9a-f-]{36}$)/, '');

function unmarkedManifest() {
  const { checkpoint, meetings } = JSON.parse(manifest());
  const legacyRevisions = Object.fromEntries(Object.entries(meetings as Record<string, string>)
    .map(([id, revision]) => [id, legacyName(revision)]));
  return JSON.stringify({ checkpoint, meetings: legacyRevisions });
}

function convertToLegacy(legacy: string) {
  const path = join(home, 'manifest.json');
  const durablePath = join(home, '.manifest-state');
  writeFileSync(path, legacy);
  unlinkSync(durablePath);
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
      // Legacy revisions predate packet digests and note attribution (B3).
      for (const packet of state.packets) {
        delete packet.packet_digest;
        delete packet.note;
      }
      writeFileSync(revision, JSON.stringify(state));
      const legacy = join(directory, legacyName(name.slice(0, -5)) + '.json');
      if (legacy !== revision) renameSync(revision, legacy);
    }
  }
  return { path, durablePath, legacy };
}

async function prepareLegacyStore() {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const olderManifest = unmarkedManifest();
  expect(await requestCreate(owner.child)).toEqual({ ok: true });
  const legacy = unmarkedManifest();
  expect(owner.child.kill('SIGKILL')).toBe(true);
  await owner.done;
  return { ...convertToLegacy(legacy), olderManifest };
}

it.each([false, true])(
  'closes legacy admission immediately after migration (unmarked rollback: %s)',
  async rollback => {
    const { path, durablePath, olderManifest, legacy } = await prepareLegacyStore();
    const migrated = peer('a');
    expect(await migrated.ready).toEqual({ ok: true });
    const published = manifest();
    const record = JSON.parse(readFileSync(durablePath, 'utf8'));
    expect.soft(JSON.parse(published)).toMatchObject({
      ...JSON.parse(legacy), presence: record.presence.token,
    });
    expect(record.manifest).toBe(published);
    expect(migrated.child.kill('SIGKILL')).toBe(true);
    await migrated.done;

    unlinkSync(durablePath);
    if (rollback) writeFileSync(path, olderManifest);
    expect.soft(await peer('a').ready).toMatchObject({
      ok: false, message: expect.stringMatching(/store manifest/i),
    });
    expect.soft(manifest()).toBe(rollback ? olderManifest : published);
    expect(existsSync(durablePath)).toBe(false);
  },
);

it('completes migration on reopen after the writer dies with an unpublished marker', async () => {
  const { durablePath, legacy } = await prepareLegacyStore();
  const migrating = peer('a', { startupPause: 'written' });
  await expectStartupPaused(migrating);
  expect(JSON.parse(manifest()).presence).toBeDefined();
  expect(JSON.parse(readFileSync(durablePath, 'utf8')).manifest).toBe(legacy);
  expect(migrating.child.kill('SIGKILL')).toBe(true);
  await migrating.done;

  expect(await peer('a').ready).toEqual({ ok: true });
  const record = JSON.parse(readFileSync(durablePath, 'utf8'));
  expect(JSON.parse(manifest())).toEqual({ ...JSON.parse(legacy), presence: record.presence.token, generation: 1, ...sealedFields });
  expect(readFileSync(join(home, '.checkpoint.1.json'), 'utf8')).toBe(manifest());
  expect(record.manifest).toBe(manifest());
});

it('reopens a committed replacement after the interrupted writer dies', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const { otherRoot, otherManifest, published, revision, committed, installRevision } = await prepareCommittedManifest();
  await pauseCreation(owner.child, 'written');
  installRevision();
  for (const name of readdirSync(otherRoot).filter(name => /^\.checkpoint\.\d+\.json$/.test(name))) {
    if (!existsSync(join(home, name))) cpSync(join(otherRoot, name), join(home, name));
  }
  if (forced) {
    const generation = JSON.parse(published).generation;
    const seal = readdirSync(otherRoot).find(name => name.startsWith(`.commit-seal.${generation}.`))!;
    const attempt = '.proof-attempt.' + seal.split('.').at(-1);
    for (const name of [seal, attempt]) cpSync(join(otherRoot, name), join(home, name), { recursive: true });
  }
  const path = join(home, 'manifest.json');
  replaceFile(path, otherManifest);
  const inode = statSync(path, { bigint: true }).ino;
  expect(owner.child.kill('SIGKILL')).toBe(true);
  await owner.done;

  expect.soft(await peer('a').ready).toEqual({ ok: true });
  expect.soft(manifest()).toBe(published);
  expect.soft(statSync(path, { bigint: true }).ino).toBe(inode);
  expect(readFileSync(revision, 'utf8')).toBe(committed);
  const { generation } = JSON.parse(published);
  expect(readFileSync(proofPath(generation), 'utf8')).toBe(published);
});

it.each(['recreated staging file', 'matching old head and record', 'absent head and matching old caches'])(
  'does not rewind a committed meeting with %s', async variant => {
    const owner = peer('a', { count: 1 });
    expect(await owner.ready).toEqual({ ok: true });
    const path = join(home, 'manifest.json');
    const durablePath = join(home, '.manifest-state');
    const headPath = join(home, '.manifest-head');
    const before = manifest();
    const prior = readFileSync(durablePath, 'utf8');
    const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const priorHead = JSON.stringify({ previous: digest(prior) });
    expect(await requestCreate(owner.child)).toEqual({ ok: true });
    const published = manifest();
    const committed = readFileSync(durablePath, 'utf8');
    const candidate = { name: `.manifest-state.${randomUUID()}.tmp`, digest: digest(committed) };
    expect(Object.keys(JSON.parse(published).meetings)).toHaveLength(2);
    expect(owner.child.kill('SIGKILL')).toBe(true);
    await owner.done;

    if (variant === 'absent head and matching old caches') {
      rmSync(headPath, { force: true });
      writeFileSync(path, before);
    } else {
      const { dev, ino } = statSync(home, { bigint: true });
      linkSync(path, join(home, `.manifest-target.${dev}:${ino}`));
      if (variant === 'matching old head and record') {
        writeFileSync(headPath, priorHead);
      } else {
        writeFileSync(headPath, JSON.stringify({ previous: digest(prior), candidate }));
        writeFileSync(join(home, candidate.name), committed);
      }
    }
    writeFileSync(durablePath, prior);
    const beforeReopen = manifest();
    const result = await peer('a').ready as { ok: boolean; message?: string };
    if (result.ok) {
      expect(manifest()).toBe(published);
      expect(JSON.parse(readFileSync(durablePath, 'utf8')).manifest).toBe(published);
    } else {
      expect(result.message).toMatch(/store manifest/i);
      expect(manifest()).toBe(beforeReopen);
    }
  },
);

it.each(['unmarked rollback', 'marked manifest with undo journal'])(
  'checks a missing record before legacy adoption or recovery with %s', async variant => {
    const { path, durablePath, olderManifest } = await prepareLegacyStore();
    const migrated = peer('a');
    expect(await migrated.ready).toEqual({ ok: true });
    const published = manifest();
    expect(Object.keys(JSON.parse(published).meetings)).toHaveLength(2);
    expect(migrated.child.kill('SIGKILL')).toBe(true);
    await migrated.done;

    const { presence: recordedPresence } = JSON.parse(readFileSync(durablePath, 'utf8'));
    unlinkSync(durablePath);
    rmSync(join(home, '.manifest-head'), { force: true });
    const { dev, ino } = statSync(home, { bigint: true });
    const anchor = join(home, `.presence.${dev}:${ino}`);
    const canonical = join(home, '.presence');
    if (forced) {
      expect(statSync(anchor).ino).not.toBe(statSync(canonical).ino);
      expect(statSync(anchor).nlink).toBe(1);
      expect(statSync(canonical).nlink).toBe(1);
      expect(JSON.parse(readFileSync(anchor, 'utf8'))).toEqual({
        scheme: 'recorded', directory: `${dev}:${ino}`, inode: recordedPresence.inode,
        token: readFileSync(canonical, 'utf8'), claim: recordedPresence.claim,
      });
    } else {
      expect(statSync(anchor).ino).toBe(statSync(canonical).ino);
    }
    if (variant === 'unmarked rollback') {
      writeFileSync(path, olderManifest);
    } else {
      linkSync(path, join(home, `.manifest-target.${dev}:${ino}`));
      const identity = statSync(path, { bigint: true });
      writeFileSync(join(home, `.manifest-undo.${dev}:${ino}`), JSON.stringify({
        dev: String(identity.dev), ino: String(identity.ino), bytes: olderManifest,
      }));
    }
    const beforeReopen = manifest();
    expect.soft(await peer('a').ready).toMatchObject({
      ok: false, message: expect.stringMatching(/store manifest/i),
    });
    expect.soft(manifest()).toBe(beforeReopen);
    expect(existsSync(durablePath)).toBe(false);
  },
);

it.each([
  ['fail-before-checkpoint', 0],
  ['fail-proof-sync', 1],
  ['fail-checkpoint-sync', 1],
  ['fail-revision-sync', 1],
  ['fail-publication-sync', 1],
] as const)('reopens a coherent generation after %s', async (failure, advance) => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const before = JSON.parse(manifest());
  expect(await requestCreate(owner.child, failure)).toMatchObject({
    ok: false, message: expect.stringMatching(/^injected (directory|checkpoint) sync failure$/),
  });
  expect(owner.child.kill('SIGKILL')).toBe(true);
  await owner.done;

  expect(await peer('a').ready).toEqual({ ok: true });
  const published = manifest();
  const after = JSON.parse(published);
  expect(after.checkpoint.position).toBe(before.checkpoint.position + advance);
  expect(after.generation).toBe(before.generation + advance);
  expect(after.meetings).toMatchObject(before.meetings);
  expect(Object.keys(after.meetings)).toHaveLength(1 + advance);
  expect(JSON.parse(readFileSync(join(home, '.manifest-state'), 'utf8')).manifest).toBe(published);
  expect(readFileSync(join(home, `.checkpoint.${after.generation}.json`), 'utf8')).toBe(published);
});

it('can retry legacy enrollment after the presence link sync fails', async () => {
  const { legacy } = await prepareLegacyStore();
  expect(await peer('a', { startupPause: 'fail-presence-sync' }).ready).toEqual({
    ok: false, message: 'injected directory sync failure',
  });
  expect(manifest()).toBe(legacy);
  expect(await peer('a').ready).toEqual({ ok: true });
  expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
});

it('reopens a legacy store after SIGKILL during a short presence token write', async () => {
  const { durablePath, legacy } = await prepareLegacyStore();
  const presencePath = join(home, '.presence');
  unlinkSync(presencePath);

  const migrating = peer('a', { startupPause: 'partial-presence-token' });
  await expectStartupPaused(migrating);
  expect(migrating.child.kill('SIGKILL')).toBe(true);
  expect(await migrating.done).toEqual([null, 'SIGKILL']);
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
  expect(existsSync(join(home, '.manifest-enrollment'))).toBe(false);
  const visibleToken = existsSync(presencePath);

  expect(await peer('a').ready).toEqual({ ok: true });
  expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
  expect(visibleToken).toBe(false);
});

it('retries legacy enrollment over a short public token left by an older writer', async () => {
  const { legacy } = await prepareLegacyStore();
  const presencePath = join(home, '.presence');
  const partialToken = readFileSync(presencePath, 'utf8').slice(0, 9);
  writeFileSync(presencePath, partialToken);

  expect(await peer('a').ready).toEqual({ ok: true });
  const token = readFileSync(presencePath, 'utf8');
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(manifest())).toEqual({ ...JSON.parse(legacy), presence: token, generation: 1, ...sealedFields });
});

it.each([
  'presence-token', 'enrollment-record-staged', 'enrollment-intent', 'presence-linked', 'presence-synced',
  'enrollment-record', 'enrollment-record-synced', 'staged', 'target-linked', 'undo-linked', 'written',
  'publishing-checkpoint', 'commit-proof', 'commit-record', 'checkpoint', 'checkpoint-synced', 'migration-record', 'unlinked',
])('reopens a legacy store after SIGKILL during enrollment at %s', async startupPause => {
  const { durablePath, legacy } = await prepareLegacyStore();
  const migrating = peer('a', { startupPause });
  await expectStartupPaused(migrating);
  expect(migrating.child.kill('SIGKILL')).toBe(true);
  expect(await migrating.done).toEqual([null, 'SIGKILL']);

  expect(await peer('a').ready).toEqual({ ok: true });
  const published = manifest();
  const record = JSON.parse(readFileSync(durablePath, 'utf8'));
  expect(JSON.parse(published)).toEqual({ ...JSON.parse(legacy), presence: record.presence.token, generation: 1, ...sealedFields });
  expect(record.manifest).toBe(published);
  expect(existsSync(join(home, '.manifest-enrollment'))).toBe(false);
});

it('refuses to resume enrollment with a changed legacy checkpoint', async () => {
  const { path, durablePath, legacy } = await prepareLegacyStore();
  const migrating = peer('a', { startupPause: 'presence-synced' });
  await expectStartupPaused(migrating);
  expect(migrating.child.kill('SIGKILL')).toBe(true);
  expect(await migrating.done).toEqual([null, 'SIGKILL']);

  const changed = JSON.parse(legacy);
  changed.checkpoint.epoch = 'replayed';
  writeFileSync(path, JSON.stringify(changed));
  expect(await peer('replayed').ready).toMatchObject({
    ok: false, message: expect.stringMatching(/manifest disagrees with its interrupted enrollment/i),
  });
  expect(existsSync(durablePath)).toBe(false);

  writeFileSync(path, legacy);
  expect(await peer('a').ready).toEqual({ ok: true });
});

it.each(['omitted meeting', 'older revision of the same meeting'])(
  'refuses to enroll a legacy snapshot with an %s', async variant => {
    const { path, durablePath, olderManifest, legacy } = await prepareLegacyStore();
    let stale = olderManifest;
    if (variant === 'older revision of the same meeting') {
      const candidate = JSON.parse(legacy);
      const [id] = Object.keys(JSON.parse(olderManifest).meetings);
      const [older] = readdirSync(join(home, id)).filter(name =>
        name.endsWith('.json') && name !== candidate.meetings[id] + '.json');
      expect(older).toBeDefined();
      candidate.meetings[id] = older.slice(0, -5);
      stale = JSON.stringify(candidate);
    }
    writeFileSync(path, stale);
    expect(await peer('a').ready).toMatchObject({ ok: false, message: expect.stringMatching(/store manifest/i) });
    expect(manifest()).toBe(stale);
    expect(existsSync(durablePath)).toBe(false);

    writeFileSync(path, legacy);
    expect(await peer('a').ready).toEqual({ ok: true });
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
  },
);

it('rejects replay of both caches after a checkpoint-only epoch change at the same position', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const path = join(home, 'manifest.json');
  const durablePath = join(home, '.manifest-state');
  const previous = manifest();
  const before = JSON.parse(previous);
  const staleRecord = readFileSync(durablePath, 'utf8');
  expect(owner.child.kill('SIGKILL')).toBe(true);
  await owner.done;

  const next = peer('b');
  expect(await next.ready).toEqual({ ok: true });
  const current = manifest();
  const after = JSON.parse(current);
  expect(after.checkpoint).toMatchObject({ position: before.checkpoint.position, epoch: 'b' });
  expect(after.meetings).toEqual(before.meetings);
  expect(after.generation).toBe(before.generation + 1);
  expect(next.child.kill('SIGKILL')).toBe(true);
  await next.done;

  writeFileSync(path, previous);
  writeFileSync(durablePath, staleRecord);
  expect(await peer('b').ready).toMatchObject({ ok: false, message: expect.stringMatching(/store manifest/i) });
  expect(manifest()).toBe(previous);
  expect(readFileSync(durablePath, 'utf8')).toBe(staleRecord);
  expect(readFileSync(join(home, `.checkpoint.${after.generation}.json`), 'utf8')).toBe(current);
});

it.each([['checkpoint'], ['commit'], ['checkpoint', 'commit']].map(artifacts => [artifacts.join(' and '), artifacts] as const))(
  'rejects replay of both caches after deleting the committed takeover %s', async (_, artifacts) => {
  const owner = peer('a');
  expect(await owner.ready).toEqual({ ok: true });
  expect(await requestCreate(owner.child)).toEqual({ ok: true });
  const path = join(home, 'manifest.json');
  const durablePath = join(home, '.manifest-state');
  const previous = manifest();
  const staleRecord = readFileSync(durablePath, 'utf8');
  const before = JSON.parse(previous);
  expect(before).toMatchObject({ generation: 2, checkpoint: { epoch: 'a' } });
  expect(owner.child.kill('SIGKILL')).toBe(true);
  expect(await owner.done).toEqual([null, 'SIGKILL']);

  const takeover = peer('b');
  expect(await takeover.ready).toEqual({ ok: true });
  const current = JSON.parse(manifest());
  expect(current).toMatchObject({ generation: 3, checkpoint: { epoch: 'b', position: before.checkpoint.position } });
  expect(current.meetings).toEqual(before.meetings);
  expect(takeover.child.kill('SIGKILL')).toBe(true);
  expect(await takeover.done).toEqual([null, 'SIGKILL']);

  for (const artifact of artifacts) unlinkSync(join(home, `.${artifact}.3.json`));
  writeFileSync(path, previous);
  writeFileSync(durablePath, staleRecord);
  expect(await peer('a').ready).toMatchObject({ ok: false, message: expect.stringMatching(/store manifest/i) });
  expect(manifest()).toBe(previous);
  expect(readFileSync(durablePath, 'utf8')).toBe(staleRecord);
  },
);

it('refuses matching old caches when only the newer committed meeting revision survives', async () => {
  const owner = peer('a', { count: 1 });
  expect(await owner.ready).toEqual({ ok: true });
  const path = join(home, 'manifest.json');
  const durablePath = join(home, '.manifest-state');
  const before = manifest();
  const staleRecord = readFileSync(durablePath, 'utf8');
  expect(await requestCreate(owner.child)).toEqual({ ok: true });
  const current = JSON.parse(manifest());
  const [id] = Object.keys(current.meetings).filter(id => !Object.hasOwn(JSON.parse(before).meetings, id));
  const revision = join(home, id, current.meetings[id] + '.json');
  const committed = readFileSync(revision, 'utf8');
  expect(owner.child.kill('SIGKILL')).toBe(true);
  await owner.done;

  unlinkSync(join(home, `.checkpoint.${current.generation}.json`));
  unlinkSync(join(home, `.commit.${current.generation}.json`));
  writeFileSync(path, before);
  writeFileSync(durablePath, staleRecord);
  expect(await peer('a').ready).toMatchObject({ ok: false, message: expect.stringMatching(/store manifest/i) });
  expect(manifest()).toBe(before);
  expect(readFileSync(revision, 'utf8')).toBe(committed);
});

it('refuses an unmarked complete legacy manifest when only a presence anchor survives', async () => {
  const { durablePath, legacy } = await prepareLegacyStore();
  const { dev, ino } = statSync(home, { bigint: true });
  linkSync(join(home, '.presence'), join(home, `.presence.${dev}:${ino}`));

  expect(await peer('a').ready).toMatchObject({ ok: false, message: expect.stringMatching(/store manifest/i) });
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

function markLegacyStore({ path, durablePath, legacy }: ReturnType<typeof convertToLegacy>) {
  const { dev, ino } = statSync(home, { bigint: true });
  const directory = `${dev}:${ino}`;
  const presencePath = join(home, '.presence');
  const presenceStat = statSync(presencePath, { bigint: true });
  const token = readFileSync(presencePath, 'utf8');
  const presence = { directory, inode: `${presenceStat.dev}:${presenceStat.ino}:${presenceStat.birthtimeNs}`, token };
  linkSync(presencePath, join(home, '.presence.' + directory));
  const marked = { ...JSON.parse(legacy), presence: token };
  const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const record = (bytes: string) => JSON.stringify({ manifest: bytes, presence });
  const publish = (previous: string | null, published: string) => {
    writeFileSync(join(home, '.manifest-head'), JSON.stringify({
      previous: previous && digest(record(previous)),
      candidate: { name: `.manifest-state.${randomUUID()}.tmp`, digest: digest(record(published)) },
    }));
    writeFileSync(path, published);
    writeFileSync(durablePath, record(published));
  };
  return { path, durablePath, marked, record, publish };
}

async function prepareMarkedLegacyStore() {
  return markLegacyStore(await prepareLegacyStore());
}

const legacyClock = { epoch: 'a', now: () => ({ monotonic: 0n, wall: 0n }) };
const legacyChair = { id: 'chair', kind: 'human' } as const;
const legacySeats: Operations['create_meeting']['seats'] = [
  { seat_id: 'a', principal: 'seat-a', connection: 'cli' },
  { seat_id: 'b', principal: 'seat-b', connection: 'cli' },
  { seat_id: 'c', principal: 'seat-c', connection: 'cli' },
];

async function createLegacyMeeting(core: Core, seats = legacySeats) {
  return (await core.create_meeting(legacyChair, {
    topic: 'legacy meeting', chair: { principal: legacyChair.id }, seats,
  })).meeting_id;
}

async function writeLegacyMeeting<T>(write: (core: Core) => Promise<T>, clock = legacyClock): Promise<T> {
  const writer = new Core({ home, clock });
  try {
    return await write(writer);
  } finally {
    writer.close();
  }
}

function legacyRevision(snapshot: string, meetingId: string) {
  return join(home, meetingId, JSON.parse(snapshot).meetings[meetingId] + '.json');
}

function retainBranchRevision(branchHome: string, meetingId: string) {
  const { meetings } = JSON.parse(readFileSync(join(branchHome, 'manifest.json'), 'utf8'));
  const revision = meetings[meetingId] + '.json';
  cpSync(join(branchHome, meetingId, revision), join(home, meetingId, revision));
}

it.each(['new round', 'only retained revision'])('rejects receipt without a submission in a legacy %s', async variant => {
  const { meetingId, created } = await writeLegacyMeeting(async writer => {
    const meetingId = await createLegacyMeeting(writer);
    const created = unmarkedManifest();
    await writer.open_round(legacyChair, { meeting_id: meetingId, round: 'R0' });
    return { meetingId, created };
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  if (variant === 'only retained revision') unlinkSync(legacyRevision(created, meetingId));
  const path = legacyRevision(legacy, meetingId);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.rounds[0]).toMatchObject({ summary: null, rows: [
    { state: 'pending', current_packet_id: null }, { state: 'pending' }, { state: 'pending' },
  ] });
  revision.rounds[0].rows[0].state = 'received';
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['round opening', 'sparse round with submission'])('migrates a legacy %s', async variant => {
  const { meetingId, opened, rows } = await writeLegacyMeeting(async writer => {
    const meetingId = await createLegacyMeeting(writer);
    const args = { meeting_id: meetingId, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const opened = unmarkedManifest();
    if (variant === 'sparse round with submission') await writer.submit_answer('seat-a', {
      ...args, seat_id: 'a', body: 'answer',
    });
    const { reception_table: rows } = await writer.get_state(legacyChair, { meeting_id: meetingId });
    expect(rows.map(row => row.state)).toEqual([
      variant === 'round opening' ? 'pending' : 'received', 'pending', 'pending',
    ]);
    return { meetingId, opened, rows };
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  if (variant === 'sparse round with submission') unlinkSync(legacyRevision(opened, meetingId));

  const reader = new Core({ home, clock: legacyClock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    expect(await reader.get_state(legacyChair, { meeting_id: meetingId })).toMatchObject({ reception_table: rows });
  } finally {
    reader.close();
  }
});

it.each(['unsent ACK', 'unknown packet', 'duplicate sent entry', 'notice for a pending seat', 'held note'])(
  'rejects legacy delivery with %s', async variant => {
    const { meetingId, heldNote, retained, sent } = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer);
      if (variant === 'notice for a pending seat' || variant === 'held note') {
        await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
      }
      const heldNote = variant === 'held note' ? (await writer.post_message(legacyChair, {
        meeting_id, body: { text: 'held until freeze' },
      })).packet_id : undefined;
      const retained = unmarkedManifest();
      let sent: string | undefined;
      if (variant === 'unsent ACK') {
        const args = { meeting_id, caller_seat_id: 'a' };
        const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
        sent = unmarkedManifest();
        await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids: [new_packets[0].header.packet_id] });
      }
      return { meetingId: meeting_id, heldNote, retained, sent };
    });
    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    const path = legacyRevision(retained, meetingId);
    const revision = JSON.parse(readFileSync(path, 'utf8'));
    const delivery = revision.delivery[0];
    const agenda = revision.packets[0].packet_id;
    expect(delivery).toMatchObject({ sent: [], ack: [], notices: [] });
    if (variant === 'unsent ACK') delivery.ack = [agenda];
    if (variant === 'unknown packet') delivery.sent = [randomUUID()];
    if (variant === 'duplicate sent entry') delivery.sent = [agenda, agenda];
    if (variant === 'notice for a pending seat') delivery.notices = ['R0'];
    if (variant === 'held note') delivery.sent = [heldNote];
    // The ACK prefix is compatible with the selected revision once the intermediate save is absent.
    if (sent) unlinkSync(legacyRevision(sent, meetingId));
    writeFileSync(path, JSON.stringify(revision));

    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
  },
);

it.each(['absent without audit', 'invalid waiver', 'received without confirmation', 'invalid attest hash', 'incorrect frozen metadata'])(
  'rejects a standalone legacy round with %s', async variant => {
    const { meetingId, earlier } = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }, legacySeats[1]]);
      const args = { meeting_id, round: 'R0' };
      const earlier = [unmarkedManifest()];
      await writer.open_round(legacyChair, args);
      if (variant === 'invalid waiver') {
        earlier.push(unmarkedManifest());
        await writer.waive_seat(legacyChair, { ...args, seat_id: 'a', reason_code: 'chair_judgment' });
      } else if (variant !== 'absent without audit') {
        earlier.push(unmarkedManifest());
        const { packet_id } = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'answer' });
        if (variant !== 'received without confirmation') {
          earlier.push(unmarkedManifest());
          await attestLegacyAnswer(writer, meeting_id, packet_id, 'confirmed');
          if (variant === 'incorrect frozen metadata') {
            earlier.push(unmarkedManifest());
            await writer.submit_answer('seat-b', { ...args, seat_id: 'b', body: 'answer', claims: [] });
          }
        }
      }
      return { meetingId: meeting_id, earlier };
    });
    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    for (const snapshot of earlier) unlinkSync(legacyRevision(snapshot, meetingId));
    const path = legacyRevision(legacy, meetingId);
    const revision = JSON.parse(readFileSync(path, 'utf8'));
    const row = revision.rounds[0].rows[0];
    if (variant === 'absent without audit') Object.assign(row, {
      state: 'absent', reason: { code: 'chair_declared', text: null },
    });
    if (variant === 'invalid waiver') {
      row.reason.code = 'invalid_code';
      revision.audit[0].detail.reason.code = 'invalid_code';
    }
    if (variant === 'received without confirmation') {
      row.state = 'received';
      Object.assign(revision.packets[1], { reception: 'received', verification: 'verified' });
    }
    if (variant === 'invalid attest hash') revision.packets[2].attest.body_sha = '0'.repeat(64);
    if (variant === 'incorrect frozen metadata') revision.packets[3].missing = [];
    writeFileSync(path, JSON.stringify(revision));

    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
  },
);

it.each(['sent', 'ack'] as const)('rejects a legacy %s entry added after agenda supersession', async field => {
  const { meetingId, oldAgenda } = await writeLegacyMeeting(async writer => {
    const args = { meeting_id: await createLegacyMeeting(writer), caller_seat_id: 'a' };
    const { new_packets } = await writer.get_packets('seat-b', { ...args, caller_seat_id: 'b' });
    if (field === 'ack') await writer.get_packets('seat-a', args);
    await writer.update_setup(legacyChair, { meeting_id: args.meeting_id, shared_materials: ['new agenda'] });
    await writer.get_packets('seat-a', args);
    return { meetingId: args.meeting_id, oldAgenda: new_packets[0].header.packet_id };
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  revision.delivery[0][field].push(oldAgenda);
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

function keepOnlyLegacyRevisions(meetingId: string, ...paths: string[]) {
  const directory = join(home, meetingId);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const retained = join(directory, name);
    if (!paths.includes(retained)) unlinkSync(retained);
  }
}

it.each([
  ['meeting timeout sweep', 3], ['share confirmation', 2], ['delivery and ACK', 4],
  ['batched delivery and ignored ACKs', 3], ['delivery to two seats', 3],
  ['audited dispatch failure', 2],
] as const)('requires the writer position for legacy %s', async (operation, position) => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const meetingId = await writeLegacyMeeting(async writer => {
    const { meeting_id } = await writer.create_meeting(legacyChair, {
      topic: 'legacy position accounting', chair: { principal: legacyChair.id }, meeting_timeout: 1,
      seats: [{ ...legacySeats[0], seat_specific_materials: [{ id: 'document' }] }, legacySeats[1]],
    });
    const args = { meeting_id, caller_seat_id: 'a' };
    switch (operation) {
      case 'meeting timeout sweep':
        await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
        tick = 2_000_000_000n;
        await writer.sweep();
        break;
      case 'share confirmation':
        await writer.confirm_share(legacyChair, { meeting_id, setup_version: 1,
          material_ref: 'seat:a:document', purpose: 'share_external' });
        break;
      case 'delivery and ACK': {
        const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
        await writer.post_message(legacyChair, { meeting_id, body: { text: 'batched with the ACK' } });
        await writer.get_packets('seat-a', {
          ...args, delivery_epoch, ack_packet_ids: [new_packets[0].header.packet_id, randomUUID()],
        });
        break;
      }
      case 'batched delivery and ignored ACKs': {
        const { packet_id } = await writer.post_message(legacyChair, { meeting_id, body: { text: 'unseen' } });
        const { new_packets } = await writer.get_packets('seat-a', {
          ...args, delivery_epoch: 2, ack_packet_ids: [packet_id, randomUUID()],
        });
        expect(new_packets).toHaveLength(2);
        break;
      }
      case 'delivery to two seats':
        await writer.get_packets('seat-a', args);
        await writer.get_packets('seat-b', { ...args, caller_seat_id: 'b' });
        break;
      case 'audited dispatch failure':
        await expect(writer.dispatch('council.open_round', { meeting_id, round: 'R1' }, legacyChair))
          .rejects.toMatchObject({ code: 'invalid_state' });
        break;
    }
    return meeting_id;
  }, clock);
  const fixture = convertToLegacy(unmarkedManifest());
  const snapshot = JSON.parse(fixture.legacy);
  expect(snapshot.checkpoint.position).toBe(position);
  const tooEarly = JSON.stringify({ ...snapshot, checkpoint: { ...snapshot.checkpoint, position: position - 1 } });
  const attempt = () => new Core({ home, clock }).close();
  for (const retained of [true, false]) {
    const selected = legacyRevision(fixture.legacy, meetingId);
    if (!retained) keepOnlyLegacyRevisions(meetingId, selected);
    writeFileSync(fixture.path, tooEarly);
    expect(attempt).toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(tooEarly);
    expect(existsSync(fixture.durablePath)).toBe(false);
  }
  writeFileSync(fixture.path, fixture.legacy);
  attempt();
  expect(JSON.parse(manifest())).toMatchObject({ generation: 1, checkpoint: { position } });
});

it.each([
  { history: 'one batched call', batches: [['first', 'second']], position: 2 },
  { history: 'two separate calls', batches: [['first'], ['second']], position: 3 },
  { history: 'a call before an epoch reset', batches: [['first', 'second']], rebind: true, position: 3 },
  { history: 'an old-format batched call', batches: [['first', 'second']], oldFormat: true, position: 2 },
])('requires the writer position for same-tick ignored ACKs from $history', async ({
  batches, position, rebind, oldFormat,
}) => {
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [legacySeats[0]]);
    for (const ack_packet_ids of batches) {
      await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a', delivery_epoch: 2, ack_packet_ids });
    }
    if (rebind) await writer.update_setup(legacyChair, {
      meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }],
    });
    return meeting_id;
  });
  const fixture = convertToLegacy(unmarkedManifest());
  const selected = legacyRevision(fixture.legacy, meetingId);
  keepOnlyLegacyRevisions(meetingId, selected);
  const revision = JSON.parse(readFileSync(selected, 'utf8'));
  expect(revision.audit).toMatchObject(['first', 'second'].map(packet_id => ({
    at: '1970-01-01T00:00:00.000Z', operation: 'get_packets', event: 'ignored_ack',
    detail: { packet_id, provided_epoch: 2 },
  })));
  if (oldFormat) {
    for (const entry of revision.audit) {
      const { packet_id, provided_epoch } = entry.detail;
      entry.detail = { packet_id, provided_epoch };
    }
    writeFileSync(selected, JSON.stringify(revision));
  }

  const snapshot = JSON.parse(fixture.legacy);
  expect(snapshot.checkpoint.position).toBe(position);
  snapshot.checkpoint.position = position - 1;
  const tooEarly = JSON.stringify(snapshot);
  writeFileSync(fixture.path, tooEarly);
  const attempt = () => new Core({ home, clock: legacyClock }).close();
  expect(attempt).toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(tooEarly);
  expect(existsSync(fixture.durablePath)).toBe(false);

  writeFileSync(fixture.path, fixture.legacy);
  attempt();
  expect(JSON.parse(manifest())).toMatchObject({ generation: 1, checkpoint: { position } });
});

it('uses separate positions for a wrong-epoch audit and a valid legacy ACK after a retained delivery', async () => {
  const { meetingId, delivered } = await writeLegacyMeeting(async writer => {
    const meetingId = await createLegacyMeeting(writer);
    const args = { meeting_id: meetingId, caller_seat_id: 'a' };
    const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
    const delivered = unmarkedManifest();
    const ack_packet_ids = [new_packets[0].header.packet_id];
    await writer.get_packets('seat-a', { ...args, delivery_epoch: delivery_epoch + 1, ack_packet_ids });
    await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids });
    return { meetingId, delivered };
  });
  const fixture = convertToLegacy(unmarkedManifest());
  keepOnlyLegacyRevisions(meetingId, legacyRevision(fixture.legacy, meetingId), legacyRevision(delivered, meetingId));
  const snapshot = JSON.parse(fixture.legacy);
  expect(snapshot.checkpoint.position).toBe(4);
  snapshot.checkpoint.position = 3;
  writeFileSync(fixture.path, JSON.stringify(snapshot));
  const attempt = () => new Core({ home, clock: legacyClock }).close();
  expect(attempt).toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  writeFileSync(fixture.path, fixture.legacy);
  attempt();
  expect(JSON.parse(manifest())).toMatchObject({ generation: 1, checkpoint: { position: 4 } });
});

it.each(['creation budget', 'shared opening', 'overbooked openings', 'interleaved',
  'out-of-order opening ticks', 'reopen', 'reopen with changed setup'] as const)(
  'validates the global legacy position sequence for %s', async variant => {
    let tick = 0n;
    const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
    const { first, second } = await writeLegacyMeeting(async writer => {
      if (variant === 'reopen' || variant === 'reopen with changed setup') {
        const { meeting_id: first } = await createLegacyMeetingAwaitingApproval(writer);
        const { new_meeting_id: second } = await writer.approve(legacyChair, {
          meeting_id: first, decision: 'reopen', reopen_points: ['continue'],
        });
        return { first, second: second! };
      }
      const first = await createLegacyMeeting(writer, [{ ...legacySeats[0], optional: true }]);
      const second = await createLegacyMeeting(writer);
      if (variant !== 'creation budget') {
        const deadline = { kind: 'relative', seconds: 1 };
        tick = 10n;
        await writer.open_round(legacyChair, { meeting_id: first, round: 'R0', deadline });
        tick = 20n;
        await writer.open_round(legacyChair, { meeting_id: second, round: 'R0', deadline });
      }
      return { first, second };
    }, clock);
    const fixture = convertToLegacy(unmarkedManifest());
    const snapshot = JSON.parse(fixture.legacy);
    if (variant === 'creation budget') snapshot.checkpoint.position = 1;
    if (variant === 'shared opening' || variant === 'overbooked openings') {
      const id = variant === 'shared opening' ? second : first;
      const path = legacyRevision(fixture.legacy, id);
      const revision = JSON.parse(readFileSync(path, 'utf8'));
      revision.timeoutOrder = revision.rounds[0].sweepOrder = variant === 'shared opening' ? 3 : 2;
      writeFileSync(path, JSON.stringify(revision));
      if (variant === 'overbooked openings') {
        const otherPath = legacyRevision(fixture.legacy, second);
        const other = JSON.parse(readFileSync(otherPath, 'utf8'));
        other.timeoutOrder = other.rounds[0].sweepOrder = 3;
        writeFileSync(otherPath, JSON.stringify(other));
      }
    }
    if (variant === 'out-of-order opening ticks') {
      for (const [id, position] of [[first, 4], [second, 3]] as const) {
        const path = legacyRevision(fixture.legacy, id);
        const revision = JSON.parse(readFileSync(path, 'utf8'));
        revision.timeoutOrder = revision.rounds[0].sweepOrder = position;
        writeFileSync(path, JSON.stringify(revision));
      }
    }
    if (variant === 'reopen with changed setup') {
      const path = legacyRevision(fixture.legacy, second);
      const revision = JSON.parse(readFileSync(path, 'utf8'));
      revision.setup.seats[0].quota--;
      writeFileSync(path, JSON.stringify(revision));
    }
    const legacy = JSON.stringify(snapshot);
    writeFileSync(fixture.path, legacy);
    const attempt = () => new Core({ home, clock }).close();
    if (variant === 'interleaved' || variant === 'reopen') {
      attempt();
      expect(JSON.parse(manifest())).toMatchObject({ generation: 1, meetings: {
        [first]: expect.any(String), [second]: expect.any(String),
      }, checkpoint: { position: variant === 'reopen' ? 6 : 4 } });
    } else {
      expect(attempt).toThrow('Council store manifest cannot establish the latest legacy meeting revision');
      expect(manifest()).toBe(legacy);
      expect(existsSync(fixture.durablePath)).toBe(false);
      if (variant === 'creation budget') {
        writeFileSync(fixture.path, fixture.legacy);
        attempt();
        expect(JSON.parse(manifest())).toMatchObject({ generation: 1, checkpoint: { position: 2 } });
      }
    }
  },
);

it('rejects two legacy revisions for one creation call', async () => {
  const meetingId = await writeLegacyMeeting(createLegacyMeeting);
  const fixture = convertToLegacy(unmarkedManifest());
  cpSync(legacyRevision(fixture.legacy, meetingId), join(home, meetingId, randomUUID() + '.json'));
  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(fixture.legacy);
  expect(existsSync(fixture.durablePath)).toBe(false);
});

it.each(['writer order', 'attest at waiver freeze', 'attest before retained waiver'])(
  'validates legacy freeze positions with %s', async variant => {
    const { meeting_id, beforeAttest, afterAttest } = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer, [
        { ...legacySeats[0], connection: 'web', optional: true }, legacySeats[1], { ...legacySeats[2], optional: true },
      ]);
      const args = { meeting_id, round: 'R0' };
      await writer.open_round(legacyChair, args);
      const { packet_id } = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'answer' });
      await writer.waive_seat(legacyChair, { ...args, seat_id: 'c', reason_code: 'chair_judgment' });
      const beforeAttest = unmarkedManifest();
      await attestLegacyAnswer(writer, meeting_id, packet_id, 'confirmed');
      const afterAttest = unmarkedManifest();
      expect(await writer.get_state(legacyChair, { meeting_id })).toMatchObject({
        meeting_state: 'OPEN', reception_table: [{ state: 'received' }, { state: 'pending' }, { state: 'waived' }],
      });
      await writer.waive_seat(legacyChair, { ...args, seat_id: 'b', reason_code: 'chair_judgment' });
      return { meeting_id, beforeAttest, afterAttest };
    });
    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    const path = legacyRevision(legacy, meeting_id);
    if (variant === 'attest before retained waiver') unlinkSync(legacyRevision(afterAttest, meeting_id));
    else keepOnlyLegacyRevisions(meeting_id, path);
    const revision = JSON.parse(readFileSync(path, 'utf8'));
    const attest = revision.packets.find((packet: { attest?: unknown }) => packet.attest).attest;
    expect(attest.position).toBeLessThan(revision.timeoutOrder);
    if (variant !== 'writer order') {
      attest.position = variant === 'attest at waiver freeze' ? revision.timeoutOrder : attest.position - 1;
      writeFileSync(path, JSON.stringify(revision));
      expect(() => new Core({ home, clock: legacyClock }).close())
        .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
      expect(manifest()).toBe(legacy);
      expect(existsSync(durablePath)).toBe(false);
      return;
    }
    const reader = new Core({ home, clock: legacyClock });
    try {
      expect(await reader.get_state(legacyChair, { meeting_id })).toMatchObject({
        meeting_state: 'GATE', reception_table: [{ state: 'received' }, { state: 'waived' }, { state: 'waived' }],
      });
    } finally {
      reader.close();
    }
  },
);

it.each(['writer order', 'required attest before recorded freeze'])(
  'validates legacy freeze attribution with %s', async variant => {
    const meeting_id = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer, [
        { ...legacySeats[0], connection: 'web' }, { ...legacySeats[1], optional: true },
      ]);
      const args = { meeting_id, round: 'R0' };
      await writer.open_round(legacyChair, args);
      const { packet_id } = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'answer' });
      await writer.waive_seat(legacyChair, { ...args, seat_id: 'b', reason_code: 'chair_judgment' });
      await writer.get_state(legacyChair, { meeting_id });
      await attestLegacyAnswer(writer, meeting_id, packet_id, 'confirmed');
      return meeting_id;
    });
    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    const path = legacyRevision(legacy, meeting_id);
    keepOnlyLegacyRevisions(meeting_id, path);
    const revision = JSON.parse(readFileSync(path, 'utf8'));
    const attest = revision.packets.at(-1).attest;
    expect(attest.position).toBe(revision.timeoutOrder);
    if (variant !== 'writer order') {
      attest.position--;
      writeFileSync(path, JSON.stringify(revision));
      expect(() => new Core({ home, clock: legacyClock }).close())
        .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
      expect(manifest()).toBe(legacy);
      expect(existsSync(durablePath)).toBe(false);
      return;
    }
    const reader = new Core({ home, clock: legacyClock });
    try {
      expect(await reader.get_state(legacyChair, { meeting_id })).toMatchObject({ meeting_state: 'GATE' });
    } finally {
      reader.close();
    }
  },
);

it.each(['material update', 'false reset', 'principal change', 'driver change', 'driver reorder', 'sparse round trip'])(
  'validates legacy delivery epochs after a %s', async variant => {
    const seats = [{ ...legacySeats[0], driver_principals: ['driver-1', 'driver-2'] }, legacySeats[1]];
    const { meeting_id, packet_id, beforeUpdate, intermediate } = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer, seats);
      const args = { meeting_id, caller_seat_id: 'a' };
      const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
      const packet_id = new_packets[0].header.packet_id;
      await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids: [packet_id] });
      const beforeUpdate = unmarkedManifest();
      if (variant === 'sparse round trip') {
        await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }] });
        const intermediate = unmarkedManifest();
        await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'seat-a' }] });
        return { meeting_id, packet_id, beforeUpdate, intermediate };
      }
      await writer.update_setup(legacyChair, {
        meeting_id, shared_materials: ['revised agenda'],
        ...(variant === 'principal change' ? { seats: [{ seat_id: 'a', principal: 'replacement' }] } : {}),
        ...(variant === 'driver change' ? { seats: [{ seat_id: 'a', driver_principals: ['driver-3'] }] } : {}),
        ...(variant === 'driver reorder' ? { seats: [{ seat_id: 'a', driver_principals: ['driver-2', 'driver-1'] }] } : {}),
      });
      return { meeting_id, packet_id, beforeUpdate };
    });
    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    if (intermediate) unlinkSync(legacyRevision(intermediate, meeting_id));
    const path = legacyRevision(legacy, meeting_id);
    const revision = JSON.parse(readFileSync(path, 'utf8'));
    const epoch = variant === 'sparse round trip' ? 3 : ['principal change', 'driver change'].includes(variant) ? 2 : 1;
    expect(revision.delivery[0]).toMatchObject({
      epoch, sent: epoch === 1 ? [packet_id] : [], ack: epoch === 1 ? [packet_id] : [],
    });
    if (variant === 'false reset') {
      const beforePath = legacyRevision(beforeUpdate, meeting_id);
      keepOnlyLegacyRevisions(meeting_id, beforePath, path);
      const before = JSON.parse(readFileSync(beforePath, 'utf8'));
      expect(revision.setup.seats[0]).toEqual(before.setup.seats[0]);
      expect(revision.setupVersion).toBe(before.setupVersion + 1);
      expect(revision.setup.shared_materials).not.toEqual(before.setup.shared_materials);
      expect(revision.delivery[0]).toEqual(before.delivery[0]);
      Object.assign(revision.delivery[0], { epoch: 2, sent: [], ack: [] });
      writeFileSync(path, JSON.stringify(revision));
      expect(() => new Core({ home, clock: legacyClock }).close())
        .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
      expect(manifest()).toBe(legacy);
      expect(existsSync(durablePath)).toBe(false);
      return;
    }
    const reader = new Core({ home, clock: legacyClock });
    try {
      expect(JSON.parse(manifest())).toMatchObject({ generation: 1 });
    } finally {
      reader.close();
    }
  },
);

it('rejects a legacy attest position that leaves no slot for an intervening note', async () => {
  const meeting_id = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [
      { ...legacySeats[0], connection: 'web', optional: true },
      { ...legacySeats[1], connection: 'web', principal: legacyChair.id },
    ]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const first = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'optional' });
    const second = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'b', body: 'required' });
    await attestLegacyAnswer(writer, meeting_id, first.packet_id, 'confirmed');
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'between attests' } });
    await attestLegacyAnswer(writer, meeting_id, second.packet_id, 'confirmed');
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  const [first, note, second] = revision.packets.slice(-3);
  expect(note.heldFor).toBeUndefined();
  expect(first.attest.position + 2).toBe(second.attest.position);
  first.attest.position++;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['writer order', 'no slot for the note'])('validates a legacy note between rounds with %s', async variant => {
  const meeting_id = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [
      { ...legacySeats[0], connection: 'web', principal: legacyChair.id },
    ]);
    const r0 = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, r0);
    const first = await writer.transcribe_web_seat(legacyChair, { ...r0, seat_id: 'a', body: 'answer' });
    await attestLegacyAnswer(writer, meeting_id, first.packet_id, 'confirmed');
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'between rounds' } });
    const r1 = { meeting_id, round: 'R1' };
    await writer.open_round(legacyChair, r1);
    const second = await writer.transcribe_web_seat(legacyChair, { ...r1, seat_id: 'a', body: 'critique' });
    await attestLegacyAnswer(writer, meeting_id, second.packet_id, 'confirmed');
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  const [first, note, , second] = revision.packets.slice(-4);
  expect(note.heldFor).toBeUndefined();
  expect(revision.rounds[1].sweepOrder).toBe(first.attest.position + 2);
  if (variant === 'writer order') {
    new Core({ home, clock: legacyClock }).close();
    expect(JSON.parse(manifest())).toMatchObject({ generation: 1 });
    return;
  }
  revision.rounds[1].sweepOrder--;
  second.attest.position--;
  revision.timeoutOrder--;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each([
  ['opening retained', 3], ['opening retained', 4],
  ['standalone', 3], ['standalone', 4],
  ['first retained', 4], ['first retained', 5],
])('validates a legacy post-freeze note with %s history at position %s', async (history, position) => {
  const firstRetained = history === 'first retained';
  const { meeting_id, opened, noted } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [legacySeats[0]]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const opened = unmarkedManifest();
    // Without the first retained snapshot, the later revision can place the R0 freeze earlier.
    if (firstRetained) await writer.get_state({ id: 'seat-a', kind: 'human' }, { meeting_id });
    await writer.waive_seat(legacyChair, { ...args, seat_id: 'a', reason_code: 'chair_judgment' });
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'after freeze' } });
    const noted = unmarkedManifest();
    if (firstRetained) await writer.open_round(legacyChair, { ...args, round: 'R1' });
    return { meeting_id, opened, noted };
  });
  const snapshot = JSON.parse(unmarkedManifest());
  const writerNotePosition = firstRetained ? 5 : 4;
  expect(JSON.parse(opened).checkpoint.position).toBe(2);
  expect(JSON.parse(noted).checkpoint.position).toBe(writerNotePosition);
  expect(snapshot.checkpoint.position).toBe(writerNotePosition + Number(firstRetained));
  snapshot.checkpoint.position = position + Number(firstRetained);
  if (firstRetained && position < writerNotePosition) {
    // Remove the checkpoint-only human observation when removing its call.
    snapshot.checkpoint.humanPrincipals = snapshot.checkpoint.humanPrincipals.filter((id: string) => id !== 'seat-a');
  }
  const { legacy, durablePath } = convertToLegacy(JSON.stringify(snapshot));
  const path = legacyRevision(legacy, meeting_id);
  const notedPath = legacyRevision(noted, meeting_id);
  if (history === 'opening retained') keepOnlyLegacyRevisions(meeting_id, legacyRevision(opened, meeting_id), path);
  else keepOnlyLegacyRevisions(meeting_id, notedPath, path);
  const revision = JSON.parse(readFileSync(notedPath, 'utf8'));
  expect(revision.timeoutOrder).toBe(writerNotePosition - 1);
  expect(revision.packets).toHaveLength(2);
  expect(revision.packets.at(-1).heldFor).toBeUndefined();

  if (position < writerNotePosition) {
    if (firstRetained) {
      const next = JSON.parse(readFileSync(path, 'utf8'));
      expect(next.rounds[1].sweepOrder).toBe(writerNotePosition + 1);
      next.rounds[1].sweepOrder = next.timeoutOrder = position + 1;
      writeFileSync(path, JSON.stringify(next));
    }
    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
    if (!firstRetained) return;
    // The selected revision alone is feasible. The retained freeze is what makes it invalid.
    unlinkSync(notedPath);
  }

  new Core({ home, clock: legacyClock }).close();
  expect(JSON.parse(manifest())).toMatchObject({ ...snapshot, generation: 1 });
});

it.each(['before the freeze', 'in the next round'])('migrates a seated chair note %s', async variant => {
  const { meeting_id, opened } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], principal: legacyChair.id }]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const opened = unmarkedManifest();
    const note = { meeting_id, body: { text: 'unheld note' } };
    if (variant === 'before the freeze') await writer.post_message(legacyChair, note);
    await writer.waive_seat(legacyChair, { ...args, seat_id: 'a', reason_code: 'chair_judgment' });
    if (variant === 'in the next round') {
      await writer.open_round(legacyChair, { ...args, round: 'R1' });
      await writer.post_message(legacyChair, note);
    }
    return { meeting_id, opened };
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, legacyRevision(opened, meeting_id), path);
  expect(JSON.parse(readFileSync(path, 'utf8')).packets.at(-1).heldFor).toBeUndefined();

  new Core({ home, clock: legacyClock }).close();
  expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
});

it.each(['writer order', 'opening at the retained note'])('validates a note after a retained freeze with %s', async variant => {
  const { meeting_id, frozen, noted } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [legacySeats[0]]);
    const waive = { meeting_id, seat_id: 'a', reason_code: 'chair_judgment' };
    await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
    await writer.waive_seat(legacyChair, { ...waive, round: 'R0' });
    const frozen = unmarkedManifest();
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'after freeze' } });
    const noted = unmarkedManifest();
    await writer.open_round(legacyChair, { meeting_id, round: 'R1' });
    await writer.waive_seat(legacyChair, { ...waive, round: 'R1' });
    return { meeting_id, frozen, noted };
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, path, legacyRevision(frozen, meeting_id), legacyRevision(noted, meeting_id));
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.rounds[1].sweepOrder).toBe(JSON.parse(noted).checkpoint.position + 1);
  if (variant === 'writer order') {
    new Core({ home, clock: legacyClock }).close();
    expect(JSON.parse(manifest())).toMatchObject({ generation: 1 });
    return;
  }
  revision.rounds[1].sweepOrder--;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['opening at creation', 'gate at the waiver freeze'])('rejects a standalone legacy %s', async variant => {
  const meeting_id = await writeLegacyMeeting(async writer => {
    const seats = variant === 'opening at creation' ? [{ ...legacySeats[0], optional: true }] : [legacySeats[0]];
    const meeting_id = await createLegacyMeeting(writer, seats);
    await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
    if (variant === 'gate at the waiver freeze') {
      await writer.waive_seat(legacyChair, { meeting_id, round: 'R0', seat_id: 'a', reason_code: 'chair_judgment' });
      await writer.open_round(legacyChair, { meeting_id, round: 'R1' });
      await writer.waive_seat(legacyChair, { meeting_id, round: 'R1', seat_id: 'a', reason_code: 'chair_judgment' });
      await writer.chair_gate(legacyChair, { meeting_id, result: 'pass' });
    }
    return meeting_id;
  });
  const snapshot = JSON.parse(unmarkedManifest());
  const path = legacyRevision(JSON.stringify(snapshot), meeting_id);
  if (variant === 'gate at the waiver freeze') snapshot.checkpoint.position--;
  const { legacy, durablePath } = convertToLegacy(JSON.stringify(snapshot));
  keepOnlyLegacyRevisions(meeting_id, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  if (variant === 'opening at creation') {
    expect(revision.rounds[0].sweepOrder).toBe(2);
    revision.rounds[0].sweepOrder = revision.timeoutOrder = 1;
    writeFileSync(path, JSON.stringify(revision));
  } else {
    expect(snapshot.checkpoint.position).toBe(revision.timeoutOrder);
  }

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['writer order', 'no slot for the retained waiver'])('validates a sequence of retained legacy revisions with %s', async variant => {
  const { meeting_id, beforeWaiver, afterWaiver } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [
      { ...legacySeats[0], connection: 'web', optional: true },
      { ...legacySeats[1], connection: 'web', optional: true },
      legacySeats[2],
      { seat_id: 'd', principal: 'seat-d', connection: 'cli', optional: true },
    ]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const first = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'first' });
    const second = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'b', body: 'second' });
    // This delivery leaves room for the optional waiver before the first attest
    // in a standalone replay, but the retained snapshots pin the reverse order.
    await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
    await attestLegacyAnswer(writer, meeting_id, first.packet_id, 'confirmed');
    const beforeWaiver = unmarkedManifest();
    await writer.waive_seat(legacyChair, { ...args, seat_id: 'd', reason_code: 'chair_judgment' });
    const afterWaiver = unmarkedManifest();
    await attestLegacyAnswer(writer, meeting_id, second.packet_id, 'confirmed');
    await writer.waive_seat(legacyChair, { ...args, seat_id: 'c', reason_code: 'chair_judgment' });
    return { meeting_id, beforeWaiver, afterWaiver };
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, path, legacyRevision(beforeWaiver, meeting_id), legacyRevision(afterWaiver, meeting_id));
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  const [first, second] = revision.packets.filter((packet: { attest?: unknown }) => packet.attest);
  expect(second.attest.position).toBe(first.attest.position + 2);
  if (variant === 'writer order') {
    new Core({ home, clock: legacyClock }).close();
    expect(JSON.parse(manifest())).toMatchObject({ generation: 1 });
    return;
  }
  second.attest.position--;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it('rejects a legacy chair decision appended to an already frozen round', async () => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const { meeting_id, frozen } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }, legacySeats[1]]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, { ...args, deadline: { kind: 'relative', seconds: 1 } });
    const { packet_id } = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'answer' });
    await attestLegacyAnswer(writer, meeting_id, packet_id, 'mismatch');
    await writer.get_packets('seat-b', { meeting_id, caller_seat_id: 'b' });
    tick = 2_000_000_000n;
    await writer.sweep();
    const frozen = unmarkedManifest();
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'after freeze' } });
    return { meeting_id, frozen };
  }, clock);
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.rounds[0]).toMatchObject({ swept: true, state: { phase: 'frozen' } });
  const reason = revision.rounds[0].rows[0].reason;
  expect(reason).toMatchObject({ code: 'attest_mismatch' });
  keepOnlyLegacyRevisions(meeting_id, path, legacyRevision(frozen, meeting_id));
  revision.audit.push({ operation: 'declare_absent', event: 'absent', at: '1970-01-01T00:00:00.000Z',
    detail: { round: 'R0', seat_id: 'a', reason } });
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['separate updates', 'one update'])('validates delivery of an old agenda after rebinding across %s', async variant => {
  const { meeting_id, oldAgenda, intermediate } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    await writer.update_setup(legacyChair, { meeting_id, meeting_timeout: 100 });
    const args = { meeting_id, caller_seat_id: 'a' };
    const { new_packets } = await writer.get_packets('seat-a', args);
    const oldAgenda = new_packets[0].header.packet_id;
    if (variant === 'one update') {
      await writer.update_setup(legacyChair, {
        meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }], shared_materials: ['new agenda'],
      });
      return { meeting_id, oldAgenda, intermediate: [] };
    }
    await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }] });
    const rebound = unmarkedManifest();
    await writer.get_packets('replacement', args);
    const delivered = unmarkedManifest();
    await writer.update_setup(legacyChair, { meeting_id, shared_materials: ['new agenda'] });
    return { meeting_id, oldAgenda, intermediate: [rebound, delivered] };
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  for (const snapshot of intermediate) unlinkSync(legacyRevision(snapshot, meeting_id));
  const path = legacyRevision(legacy, meeting_id);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  if (variant === 'one update') {
    expect(revision.delivery[0]).toMatchObject({ epoch: 2, sent: [] });
    revision.delivery[0].sent = [oldAgenda];
    writeFileSync(path, JSON.stringify(revision));
    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
    return;
  }
  expect(revision.delivery[0]).toMatchObject({ epoch: 2, sent: [oldAgenda] });
  const reader = new Core({ home, clock: legacyClock });
  reader.close();
  expect(JSON.parse(manifest())).toMatchObject({ generation: 1 });
});

it('rejects a standalone legacy delivery epoch containing an agenda superseded at reset', async () => {
  const { meetingId, oldAgenda } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    const { new_packets } = await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
    await writer.update_setup(legacyChair, {
      meeting_id, shared_materials: ['new agenda'], seats: [{ seat_id: 'a', principal: 'replacement' }],
    });
    return { meetingId: meeting_id, oldAgenda: new_packets[0].header.packet_id };
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  keepOnlyLegacyRevisions(meetingId, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.delivery[0]).toMatchObject({ epoch: 2, sent: [] });
  revision.delivery[0].sent = [oldAgenda];
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
});

it.each(['after known absence', 'in a later round'])('rejects legacy delivery without a notice %s', async variant => {
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, legacySeats.slice(0, 2));
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    await writer.declare_absent(legacyChair, { ...args, seat_id: 'a' });
    if (variant === 'in a later round') {
      await writer.submit_answer('seat-b', { ...args, seat_id: 'b', body: 'answer' });
      await writer.open_round(legacyChair, { ...args, round: 'R1' });
      await writer.submit_answer('seat-a', { ...args, round: 'R1', seat_id: 'a', body: 'critique' });
    }
    expect(await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' }))
      .toMatchObject({ notices: [{ round: 'R0' }] });
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  revision.delivery[0].notices = [];
  writeFileSync(path, JSON.stringify(revision));
  if (variant === 'in a later round') keepOnlyLegacyRevisions(meetingId, path);

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it('rejects a standalone legacy chair decision after the last required seat froze the round', async () => {
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [legacySeats[0], { ...legacySeats[1], optional: true }]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    await writer.declare_absent(legacyChair, { ...args, seat_id: 'b' });
    await writer.declare_absent(legacyChair, { ...args, seat_id: 'a' });
    return meeting_id;
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  keepOnlyLegacyRevisions(meetingId, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  revision.audit.reverse();
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
});

it('rejects a new legacy seat with a delivery epoch that skips its initial epoch', async () => {
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, legacySeats.slice(0, 2));
    await writer.update_setup(legacyChair, { meeting_id, seats: [legacySeats[2]] });
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.delivery[2]).toMatchObject({ seat_id: 'c', epoch: 1 });
  revision.delivery[2].epoch = 2;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it('migrates notices without packets and delivery of a superseded agenda and a released note', async () => {
  const { meetingId, heldNote } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, legacySeats.slice(0, 2));
    const b = { meeting_id, caller_seat_id: 'b' };
    const { new_packets, delivery_epoch } = await writer.get_packets('seat-b', b);
    await writer.get_packets('seat-b', { ...b, delivery_epoch, ack_packet_ids: [new_packets[0].header.packet_id] });
    await writer.update_setup(legacyChair, { meeting_id, shared_materials: ['new agenda'] });
    const r0 = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, r0);
    const { packet_id } = await writer.post_message(legacyChair, { meeting_id, body: { text: 'held until freeze' } });
    await writer.declare_absent(legacyChair, { ...r0, seat_id: 'a' });
    expect(await writer.get_packets('seat-a', { ...r0, caller_seat_id: 'a' }))
      .toMatchObject({ new_packets: [], notices: [{ round: 'R0', seat_id: 'a' }] });
    await writer.submit_answer('seat-b', { ...r0, seat_id: 'b', body: 'answer' });
    const released = await writer.get_packets('seat-b', b);
    expect(released.new_packets.map(packet => packet.header.packet_id)).toContain(packet_id);
    return { meetingId: meeting_id, heldNote: packet_id };
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const reader = new Core({ home, clock: legacyClock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    const seatA = { meeting_id: meetingId, caller_seat_id: 'a', round: 'R0' };
    expect(await reader.get_packets('seat-a', seatA)).toMatchObject({ new_packets: [], notices: [] });
    const seatB = { meeting_id: meetingId, caller_seat_id: 'b', delivery_epoch: 1, ack_packet_ids: [heldNote] };
    const { new_packets } = await reader.get_packets('seat-b', seatB);
    expect(new_packets.map(packet => packet.header.packet_id)).not.toContain(heldNote);
  } finally {
    reader.close();
  }
});

it.each(['unmarked', 'durable record', 'durable record and head digest'])(
  'migrates a delivery-only legacy revision with %s', async variant => {
    const { args, beforeDelivery, agendaId, deliveryEpoch } = await writeLegacyMeeting(async writer => {
      const args = { meeting_id: await createLegacyMeeting(writer), caller_seat_id: 'a' };
      const beforeDelivery = unmarkedManifest();
      const delivery = await writer.get_packets('seat-a', args);
      expect(delivery).toMatchObject({ new_packets: [{ header: { kind: 'agenda' } }], delivery_epoch: 1 });
      return { args, beforeDelivery, agendaId: delivery.new_packets[0].header.packet_id,
        deliveryEpoch: delivery.delivery_epoch };
    });
    const fixture = convertToLegacy(unmarkedManifest());
    const { delivery: before, ...older } = JSON.parse(readFileSync(legacyRevision(beforeDelivery, args.meeting_id), 'utf8'));
    const { delivery: after, ...newer } = JSON.parse(readFileSync(legacyRevision(fixture.legacy, args.meeting_id), 'utf8'));
    expect(newer).toEqual(older);
    expect(before[0].sent).toEqual([]);
    expect(after[0].sent).toEqual([agendaId]);
    if (variant !== 'unmarked') {
      const { path, durablePath, marked, record, publish } = markLegacyStore(fixture);
      const published = JSON.stringify(marked);
      if (variant === 'durable record and head digest') {
        publish(null, published);
      } else {
        writeFileSync(path, published);
        writeFileSync(durablePath, record(published));
      }
    }

    const reader = new Core({ home, clock: legacyClock });
    try {
      const published = manifest();
      expect(JSON.parse(published)).toMatchObject({ ...JSON.parse(fixture.legacy), generation: 1 });
      expect(JSON.parse(readFileSync(fixture.durablePath, 'utf8')).manifest).toBe(published);
      expect(readFileSync(proofPath(1), 'utf8')).toBe(published);
      expect(await reader.get_packets('seat-a', {
        ...args, delivery_epoch: deliveryEpoch, ack_packet_ids: [agendaId],
      })).toMatchObject({ new_packets: [] });
    } finally {
      reader.close();
    }
  },
);

it('rejects divergent legacy delivery histories even when one has more deliveries', async () => {
  const { meetingId, firstDelivery, intermediate } = await writeLegacyMeeting(async writer => {
    const meetingId = await createLegacyMeeting(writer);
    await writer.get_packets('seat-a', { meeting_id: meetingId, caller_seat_id: 'a' });
    const firstDelivery = unmarkedManifest();
    await writer.get_packets('seat-b', { meeting_id: meetingId, caller_seat_id: 'b' });
    const intermediate = unmarkedManifest();
    await writer.get_packets('seat-c', { meeting_id: meetingId, caller_seat_id: 'c' });
    return { meetingId, firstDelivery, intermediate };
  });
  const fixture = convertToLegacy(unmarkedManifest());
  unlinkSync(legacyRevision(intermediate, meetingId));
  const path = legacyRevision(fixture.legacy, meetingId);
  const branch = JSON.parse(readFileSync(path, 'utf8'));
  // Model a fork from meeting creation where only seats b and c fetched the agenda.
  branch.delivery[0].sent = [];
  writeFileSync(path, JSON.stringify(branch));

  for (const snapshot of [firstDelivery, fixture.legacy]) {
    writeFileSync(fixture.path, snapshot);
    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(snapshot);
    expect(existsSync(fixture.durablePath)).toBe(false);
  }
});

it.each(['conflicting timeouts', 'opposite setup and delivery order', 'disjoint seat deliveries',
  'a setup update after the round opened'])(
  'rejects retained legacy meeting revisions with %s', async conflict => {
    const branchHome = join(sandbox, 'meeting-branch');
    const meeting_id = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer);
      cpSync(home, branchHome, { recursive: true });
      if (conflict === 'disjoint seat deliveries') {
        await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
        await writer.get_packets('seat-b', { meeting_id, caller_seat_id: 'b' });
      } else if (conflict === 'a setup update after the round opened') {
        await writer.update_setup(legacyChair, { meeting_id, human_participants: ['observer'] });
        await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
      } else {
        await writer.update_setup(legacyChair, { meeting_id, meeting_timeout: 100 });
        await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }] });
      }
      return meeting_id;
    });

    const branch = new Core({ home: branchHome, clock: legacyClock });
    try {
      if (conflict === 'conflicting timeouts') {
        await branch.update_setup(legacyChair, { meeting_id, meeting_timeout: 200 });
      } else if (conflict === 'a setup update after the round opened') {
        // Open at the same position as the other branch, with the original setup.
        await createLegacyMeeting(branch);
        await branch.open_round(legacyChair, { meeting_id, round: 'R0' });
      } else {
        const seat = conflict === 'disjoint seat deliveries' ? 'b' : 'a';
        await branch.get_packets('seat-' + seat, { meeting_id, caller_seat_id: seat });
      }
    } finally {
      branch.close();
    }
    const { meetings } = JSON.parse(readFileSync(join(branchHome, 'manifest.json'), 'utf8'));
    const revision = meetings[meeting_id] + '.json';
    cpSync(join(branchHome, meeting_id, revision), join(home, meeting_id, revision));

    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
  },
);

it('migrates a sparse linear legacy history across a delivery reset', async () => {
  const { meeting_id, initial, beforeDelivery } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    const initial = unmarkedManifest();
    await writer.update_setup(legacyChair, { meeting_id, meeting_timeout: 100 });
    const beforeDelivery = unmarkedManifest();
    await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
    await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }] });
    return { meeting_id, initial, beforeDelivery };
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  unlinkSync(legacyRevision(initial, meeting_id));
  unlinkSync(legacyRevision(beforeDelivery, meeting_id));

  const reader = new Core({ home, clock: legacyClock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    expect(await reader.get_packets('replacement', { meeting_id, caller_seat_id: 'a' }))
      .toMatchObject({ delivery_epoch: 2, new_packets: [{ header: { kind: 'agenda' } }] });
  } finally {
    reader.close();
  }
});

it.each(['different ACKs', 'incomparable sent and ACK histories'])(
  'rejects %s in legacy delivery histories retained before a seat rebinding', async conflict => {
    const branchHome = join(sandbox, 'ack-branch');
    const differentAcks = conflict === 'different ACKs';
    const { args, delivery_epoch, firstPacketId, secondPacketId } = await writeLegacyMeeting(async writer => {
      const args = { meeting_id: await createLegacyMeeting(writer), caller_seat_id: 'a' };
      const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
      expect(delivery_epoch).toBe(1);
      const firstPacketId = new_packets[0].header.packet_id;
      const { packet_id: secondPacketId } = await writer.post_message(legacyChair, {
        meeting_id: args.meeting_id, body: { text: 'second packet' },
      });
      // Fork before the second delivery to make the sent and ACK lists advance on different branches.
      if (!differentAcks) cpSync(home, branchHome, { recursive: true });
      await writer.get_packets('seat-a', args);
      if (differentAcks) cpSync(home, branchHome, { recursive: true });

      const result = await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids: [firstPacketId] });
      expect(result.new_packets.map(({ header }) => header.packet_id)).toEqual([secondPacketId]);
      await writer.update_setup(legacyChair, { meeting_id: args.meeting_id,
        seats: [{ seat_id: 'a', principal: 'replacement' }] });
      return { args, delivery_epoch, firstPacketId, secondPacketId };
    });

    const branch = new Core({ home: branchHome, clock: legacyClock });
    try {
      const request = differentAcks ? { ack_packet_ids: [secondPacketId] }
        : { round: 'R0', ack_packet_ids: [firstPacketId] };
      const result = await branch.get_packets('seat-a', { ...args, delivery_epoch, ...request });
      expect(result.new_packets.map(({ header }) => header.packet_id)).toEqual(differentAcks ? [firstPacketId] : []);
    } finally {
      branch.close();
    }
    const { meetings } = JSON.parse(readFileSync(join(branchHome, 'manifest.json'), 'utf8'));
    const revision = meetings[args.meeting_id] + '.json';
    cpSync(join(branchHome, args.meeting_id, revision), join(home, args.meeting_id, revision));

    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    expect(() => new Core({ home, clock: legacyClock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
  },
);

it.each(['inserts before', 'replaces'])('rejects a legacy ACK history that %s an existing acknowledgement', async change => {
  const { meetingId, thirdPacketId } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'second packet' } });
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'third packet' } });
    const args = { meeting_id, caller_seat_id: 'a' };
    const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
    for (const { header } of new_packets.slice(0, 2)) {
      await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids: [header.packet_id] });
    }
    return { meetingId: meeting_id, thirdPacketId: new_packets[2].header.packet_id };
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const branch = JSON.parse(readFileSync(path, 'utf8'));
  expect(branch.delivery[0].ack).toHaveLength(2);
  const [first, second] = branch.delivery[0].ack;
  branch.delivery[0].ack = [second, change === 'inserts before' ? first : thirdPacketId];
  writeFileSync(path, JSON.stringify(branch));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it('rejects conflicting seat bindings in the same legacy delivery epoch', async () => {
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'first-owner' }] });
    await writer.update_setup(legacyChair, { meeting_id, meeting_timeout: 100 });
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const branch = JSON.parse(readFileSync(path, 'utf8'));
  // Fork from creation with a different rebinding followed by a timeout update.
  branch.setup.seats[0].principal = 'second-owner';
  writeFileSync(path, JSON.stringify(branch));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['acknowledgement', 'absence notice', 'seat rebinding'])(
  'migrates a legacy meeting after %s', async change => {
    const args = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer);
      const args = { meeting_id, caller_seat_id: 'a' };
      const { new_packets, delivery_epoch } = await writer.get_packets('seat-a', args);
      if (change === 'acknowledgement') {
        await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids: [new_packets[0].header.packet_id] });
      } else if (change === 'absence notice') {
        await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
        await writer.declare_absent(legacyChair, { meeting_id, round: 'R0', seat_id: 'a' });
        expect(await writer.get_packets('seat-a', args)).toMatchObject({ notices: [{ round: 'R0' }] });
      } else {
        await writer.get_packets('seat-a', { ...args, delivery_epoch, ack_packet_ids: [new_packets[0].header.packet_id] });
        await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }] });
      }
      return args;
    });
    const { legacy } = convertToLegacy(unmarkedManifest());
    const reader = new Core({ home, clock: legacyClock });
    try {
      expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
      const packets = await reader.get_packets(change === 'seat rebinding' ? 'replacement' : 'seat-a', args);
      if (change === 'acknowledgement') expect(packets.new_packets).toEqual([]);
      else if (change === 'absence notice') expect(packets.notices).toEqual([]);
      else expect(packets).toMatchObject({ delivery_epoch: 2, new_packets: [{ header: { kind: 'agenda' } }] });
    } finally {
      reader.close();
    }
  },
);

it('rejects replay of a pre-rebinding legacy manifest when the reset revision is retained', async () => {
  const beforeReset = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
    const snapshot = unmarkedManifest();
    await writer.update_setup(legacyChair, { meeting_id, seats: [{ seat_id: 'a', principal: 'replacement' }] });
    return snapshot;
  });
  const { durablePath } = convertToLegacy(beforeReset);

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(beforeReset);
  expect(existsSync(durablePath)).toBe(false);
});

it('rejects a standalone legacy deadline sweep before its deadline', async () => {
  const meeting_id = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, { ...args, deadline: { kind: 'relative', seconds: 1 } });
    await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'pending attestation' });
    await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.rounds[0]).toMatchObject({ deadline: { ns: '1000000000' }, swept: false });
  expect(JSON.parse(legacy).checkpoint.monotonic).toBe('0');
  revision.rounds[0].swept = true;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it('rejects a legacy sweep in a round that froze before its deadline', async () => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const meeting_id = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, { ...args, deadline: { kind: 'relative', seconds: 1 } });
    const { packet_id } = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'answer' });
    await writer.get_packets('seat-a', { meeting_id, caller_seat_id: 'a' });
    await attestLegacyAnswer(writer, meeting_id, packet_id, 'confirmed');
    tick = 2_000_000_000n;
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'after the deadline' } });
    return meeting_id;
  }, clock);
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  keepOnlyLegacyRevisions(meeting_id, path);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision.rounds[0]).toMatchObject({ deadline: { ns: '1000000000' }, swept: false, state: { phase: 'frozen' } });
  expect(JSON.parse(legacy).checkpoint.monotonic).toBe('2000000000');
  revision.rounds[0].swept = true;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['pending attest', 'post-sweep mismatch'])('migrates a legacy deadline sweep with a %s', async variant => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }, legacySeats[1]]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, { ...args, deadline: { kind: 'relative', seconds: 1 } });
    const { packet_id } = await writer.transcribe_web_seat(legacyChair,
      { ...args, seat_id: 'a', body: 'pending attestation' });
    tick = 2_000_000_000n;
    await writer.sweep();
    if (variant === 'post-sweep mismatch') await attestLegacyAnswer(writer, meeting_id, packet_id, 'mismatch');
    return meeting_id;
  }, clock);
  const { legacy } = convertToLegacy(unmarkedManifest());
  const reader = new Core({ home, clock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    const expected = variant === 'post-sweep mismatch' ? {
      meeting_state: 'GATE',
      reception_table: [{ state: 'absent', reason: { code: 'attest_mismatch' } }, { state: 'absent' }],
    } : {
      meeting_state: 'OPEN', reception_table: [{ state: 'transcribed_pending_attest' }, { state: 'absent' }],
    };
    expect(await reader.get_state(legacyChair, { meeting_id: meetingId })).toMatchObject(expected);
  } finally {
    reader.close();
  }
});

it('rejects absent and waived branches of the same open legacy round', async () => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const branchHome = join(sandbox, 'reception-branch');
  const { meeting_id, beforeSweep } = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }, legacySeats[1]]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, { ...args, deadline: { kind: 'relative', seconds: 1 } });
    await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'pending attestation' });
    cpSync(home, branchHome, { recursive: true });
    await writer.waive_seat(legacyChair, { ...args, seat_id: 'b', reason_code: 'chair_judgment' });
    const beforeSweep = unmarkedManifest();
    tick = 2_000_000_000n;
    await writer.sweep();
    expect(await writer.get_state(legacyChair, { meeting_id })).toMatchObject({
      meeting_state: 'OPEN', reception_table: [{ state: 'transcribed_pending_attest' }, { state: 'waived' }],
    });
    return { meeting_id, beforeSweep };
  }, clock);

  const branch = new Core({ home: branchHome, clock });
  try {
    await branch.sweep();
    expect(await branch.get_state(legacyChair, { meeting_id })).toMatchObject({
      meeting_state: 'OPEN', reception_table: [{ state: 'transcribed_pending_attest' }, { state: 'absent' }],
    });
  } finally {
    branch.close();
  }
  retainBranchRevision(branchHome, meeting_id);

  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  // Retain both post-sweep revisions without the waiver's intermediate checkpoint.
  unlinkSync(legacyRevision(beforeSweep, meeting_id));
  expect(() => new Core({ home, clock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['received', 'absent', 'waived'])('migrates open legacy reception from pending to %s', async state => {
  const args = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    const target = { meeting_id, round: 'R0', seat_id: 'a' };
    await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
    if (state === 'received') await writer.submit_answer('seat-a', { ...target, body: 'answer' });
    else if (state === 'absent') await writer.declare_absent(legacyChair, target);
    else await writer.waive_seat(legacyChair, { ...target, reason_code: 'chair_judgment' });
    return { meeting_id };
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const reader = new Core({ home, clock: legacyClock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    expect(await reader.get_state(legacyChair, args)).toMatchObject({
      meeting_state: 'OPEN', reception_table: [{ state }, { state: 'pending' }, { state: 'pending' }],
    });
  } finally {
    reader.close();
  }
});

async function createLegacyMeetingAwaitingApproval(writer: Core) {
  const args = { meeting_id: await createLegacyMeeting(writer, [{ ...legacySeats[0], optional: true }]) };
  for (const round of ['R0', 'R1']) await writer.open_round(legacyChair, { ...args, round });
  await writer.chair_gate(legacyChair, { ...args, result: 'pass' });
  await writer.synthesize(legacyChair, { ...args, body: {
    agreements: [], minority_opinions: [], reversal_conditions: [], recommendation: null, cited_materials: [],
  } });
  return args;
}

it.each(['approve directly', 'post a note before approving'])('migrates a legacy history that can %s', async change => {
  const args = await writeLegacyMeeting(async writer => {
    const args = await createLegacyMeetingAwaitingApproval(writer);
    if (change === 'post a note before approving') {
      await writer.post_message(legacyChair, { ...args, body: { text: 'note before approval' } });
    }
    await writer.approve(legacyChair, { ...args, decision: 'approve' });
    return args;
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const reader = new Core({ home, clock: legacyClock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    expect(await reader.get_state(legacyChair, args)).toMatchObject({ meeting_state: 'APPROVED' });
  } finally {
    reader.close();
  }
});

it('rejects legacy approval branches with different packet counts', async () => {
  const branchHome = join(sandbox, 'approval-branch');
  const { args, afterNote } = await writeLegacyMeeting(async writer => {
    const args = await createLegacyMeetingAwaitingApproval(writer);
    cpSync(home, branchHome, { recursive: true });
    await writer.post_message(legacyChair, { ...args, body: { text: 'note before approval' } });
    const afterNote = unmarkedManifest();
    await writer.approve(legacyChair, { ...args, decision: 'approve' });
    return { args, afterNote };
  });
  const branch = new Core({ home: branchHome, clock: legacyClock });
  try {
    await branch.approve(legacyChair, { ...args, decision: 'approve' });
  } finally {
    branch.close();
  }
  retainBranchRevision(branchHome, args.meeting_id);

  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  // The two retained branch endpoints are both approved.
  unlinkSync(legacyRevision(afterNote, args.meeting_id));
  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each(['a flash from an absent seat', 'a held note for a frozen round'])(
  'rejects legacy packet growth with %s', async packet => {
    const flash = packet === 'a flash from an absent seat';
    let tick = 0n;
    const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
    const branchHome = join(sandbox, 'round-packet-branch');
    const { meeting_id, afterPacket } = await writeLegacyMeeting(async writer => {
      const meeting_id = await createLegacyMeeting(writer, flash ?
        [{ ...legacySeats[0], connection: 'web' }, { ...legacySeats[1], flash: true }] : legacySeats);
      const args = { meeting_id, round: 'R0' };
      await writer.open_round(legacyChair, { ...args, deadline: { kind: 'relative', seconds: 1 } });
      if (flash) await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'pending attestation' });
      cpSync(home, branchHome, { recursive: true });
      if (flash) await writer.submit_flash('seat-b', { ...args, seat_id: 'b', body: 'flash', basis: 'basis' });
      else await writer.post_message(legacyChair, { meeting_id, body: { text: 'held note' } });
      const afterPacket = unmarkedManifest();
      tick = 2_000_000_000n;
      await writer.sweep();
      return { meeting_id, afterPacket };
    }, clock);

    const branch = new Core({ home: branchHome, clock });
    try {
      await branch.sweep();
    } finally {
      branch.close();
    }
    retainBranchRevision(branchHome, meeting_id);

    const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
    // Compare the post-sweep endpoints where the extra packet appears to be the only advance.
    unlinkSync(legacyRevision(afterPacket, meeting_id));
    expect(() => new Core({ home, clock }).close())
      .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
    expect(manifest()).toBe(legacy);
    expect(existsSync(durablePath)).toBe(false);
  },
);

const attestLegacyAnswer = (writer: Core, meeting_id: string, target_packet_id: string, result: 'confirmed' | 'mismatch') =>
  writer.submit_attest(legacyChair, {
    meeting_id, target_packet_id, method: 'verbatim_confirm', result,
    evidence: { method: 'verbatim_confirm', confirmer: legacyChair.id, target_packet_id },
  });

it('migrates legacy packet replacements, attest transitions and freeze metadata', async () => {
  const meeting_id = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }, legacySeats[1]]);
    await writer.update_setup(legacyChair, { meeting_id, shared_materials: ['document'] });
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const answer = { ...args, seat_id: 'a', body: 'answer' };
    const first = await writer.transcribe_web_seat(legacyChair, answer);
    await attestLegacyAnswer(writer, meeting_id, first.packet_id, 'mismatch');
    const second = await writer.transcribe_web_seat(legacyChair, { ...answer, supersedes: first.packet_id });
    await attestLegacyAnswer(writer, meeting_id, second.packet_id, 'confirmed');
    const third = await writer.transcribe_web_seat(legacyChair, { ...answer, supersedes: second.packet_id });
    await writer.submit_answer('seat-b', { ...args, seat_id: 'b', body: 'answer', claims: [] });
    await attestLegacyAnswer(writer, meeting_id, third.packet_id, 'confirmed');
    return meeting_id;
  });
  const { legacy } = convertToLegacy(unmarkedManifest());
  const reader = new Core({ home, clock: legacyClock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    expect(await reader.get_state(legacyChair, { meeting_id })).toMatchObject({
      meeting_state: 'GATE', reception_table: [{ state: 'received' }, { state: 'received' }],
    });
  } finally {
    reader.close();
  }
});

it.each(['result', 'position'] as const)('rejects changed %s on a shared legacy attest packet', async field => {
  const meeting_id = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [{ ...legacySeats[0], connection: 'web' }, legacySeats[1]]);
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    const { packet_id } = await writer.transcribe_web_seat(legacyChair, { ...args, seat_id: 'a', body: 'answer' });
    await attestLegacyAnswer(writer, meeting_id, packet_id, 'confirmed');
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'note after attest' } });
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meeting_id);
  const revision = JSON.parse(readFileSync(path, 'utf8'));
  const { attest } = revision.packets.find((packet: { attest?: unknown }) => packet.attest);
  if (field === 'result') attest.result = 'mismatch';
  else attest.position++;
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each([
  ['reset timeoutExceeded', { timeoutExceeded: false }],
  ['regress from OPEN to CREATED', { state: 'CREATED' }],
  ['change convenerHuman', { convenerHuman: false }],
  ['restart the timeout without a round transition', { timeoutAt: '3000000000' }],
  ['advance timeoutOrder without a round transition', { timeoutOrder: 4 }],
  ['add a rejection reason to an open meeting', { rejectionReason: 'rejected' }],
  ['add an unknown revision field', { unknown: true }],
])('rejects a legacy revision that can append a note and %s', async (_change, mutation) => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer);
    await writer.update_setup(legacyChair, { meeting_id, meeting_timeout: 1 });
    await writer.open_round(legacyChair, { meeting_id, round: 'R0' });
    tick = 2_000_000_000n;
    await writer.sweep();
    await writer.post_message(legacyChair, { meeting_id, body: { text: 'note after timeout' } });
    return meeting_id;
  }, clock);
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const revision: Meeting = JSON.parse(readFileSync(path, 'utf8'));
  expect(revision).toMatchObject({ state: 'OPEN', convenerHuman: true, timeoutExceeded: true,
    timeoutAt: null, timeoutOrder: 3 });
  writeFileSync(path, JSON.stringify({ ...revision, ...mutation }));

  expect(() => new Core({ home, clock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it.each([
  ['absent', 0], ['received', 1], ['total', 0], ['waived', 1], ['quorum_met', true],
] as const)('rejects a changed %s in the first frozen legacy summary', async (field, value) => {
  const meetingId = await writeLegacyMeeting(async writer => {
    const meeting_id = await createLegacyMeeting(writer, [legacySeats[0]]);
    await writer.update_setup(legacyChair, { meeting_id, quorum: 1 });
    const args = { meeting_id, round: 'R0' };
    await writer.open_round(legacyChair, args);
    await writer.declare_absent(legacyChair, { ...args, seat_id: 'a' });
    return meeting_id;
  });
  const { legacy, durablePath } = convertToLegacy(unmarkedManifest());
  const path = legacyRevision(legacy, meetingId);
  const revision = JSON.parse(readFileSync(path, 'utf8')) as { rounds: RoundRecord[] };
  const round = revision.rounds[0];
  expect(round.summary).toEqual({ total: 1, received: 0, absent: 1, waived: 0, quorum_met: false });
  round.summary = { ...round.summary!, [field]: value };
  writeFileSync(path, JSON.stringify(revision));

  expect(() => new Core({ home, clock: legacyClock }).close())
    .toThrow('Council store manifest cannot establish the latest legacy meeting revision');
  expect(manifest()).toBe(legacy);
  expect(existsSync(durablePath)).toBe(false);
});

it('migrates a legacy history that restarts an expired timer and reaches rejection via R2', async () => {
  let tick = 0n;
  const clock = { ...legacyClock, now: () => ({ monotonic: tick, wall: tick }) };
  const args = await writeLegacyMeeting(async writer => {
    const args = { meeting_id: await createLegacyMeeting(writer, [legacySeats[0]]) };
    await writer.update_setup(legacyChair, { ...args, meeting_timeout: 1 });
    await writer.open_round(legacyChair, { ...args, round: 'R0', deadline: { kind: 'relative', seconds: 10 } });
    tick = 2_000_000_000n;
    await writer.sweep();
    await writer.declare_absent(legacyChair, { ...args, round: 'R0', seat_id: 'a' });
    await writer.open_round(legacyChair, { ...args, round: 'R1' });
    await writer.declare_absent(legacyChair, { ...args, round: 'R1', seat_id: 'a' });
    await writer.chair_gate(legacyChair, { ...args, result: 'fail',
      unresolved_points: ['point'], next_round_scope: ['scope'] });
    await writer.declare_absent(legacyChair, { ...args, round: 'R2', seat_id: 'a' });
    await writer.synthesize(legacyChair, { ...args, body: {
      agreements: [], minority_opinions: [], reversal_conditions: [], recommendation: null, cited_materials: [],
    } });
    await writer.approve(legacyChair, { ...args, decision: 'reject' });
    return args;
  }, clock);
  const { legacy } = convertToLegacy(unmarkedManifest());
  const reader = new Core({ home, clock });
  try {
    expect(JSON.parse(manifest())).toMatchObject({ ...JSON.parse(legacy), generation: 1 });
    expect(await reader.get_state(legacyChair, args)).toMatchObject({ meeting_state: 'REJECTED', timeout_exceeded: true });
  } finally {
    reader.close();
  }
});

it('refuses to migrate a legacy checkpoint-only rollback when the old publication record conflicts', async () => {
  const { path, durablePath, marked, record, publish } = await prepareMarkedLegacyStore();
  const stale = JSON.stringify(marked);
  const published = JSON.stringify({ ...marked, checkpoint: { ...marked.checkpoint, epoch: 'b' } });
  publish(stale, published);
  writeFileSync(path, stale);
  writeFileSync(durablePath, record(stale));

  expect(await peer('b').ready).toMatchObject({ ok: false, message: expect.stringMatching(/store manifest/i) });
  expect(manifest()).toBe(stale);

  writeFileSync(path, published);
  writeFileSync(durablePath, record(published));
  expect(await peer('b').ready).toEqual({ ok: true });
  expect(JSON.parse(manifest())).toEqual({ ...JSON.parse(published), generation: 1, ...sealedFields });
});

it('reopens a copied legacy store after its first cache rename fails to sync', async () => {
  const { marked, publish } = await prepareMarkedLegacyStore();
  publish(null, JSON.stringify(marked));
  const copy = join(sandbox, 'legacy-copy');
  cpSync(home, copy, { recursive: true });
  expect(await peer('a', { root: copy, startupPause: 'fail-publication-sync' }).ready).toEqual({
    ok: false, message: 'injected directory sync failure',
  });
  expect(await peer('a', { root: copy }).ready).toEqual({ ok: true });
  const published = readFileSync(join(copy, 'manifest.json'), 'utf8');
  expect(JSON.parse(published)).toEqual({ ...marked, generation: 1, ...sealedFields });
  expect(readFileSync(join(copy, '.checkpoint.1.json'), 'utf8')).toBe(published);
});

it('loads all meetings without holding their files open together', async () => {
  const writer = peer('a', { count: 20 });
  expect(await writer.ready).toEqual({ ok: true });
  const published = manifest();
  expect(Object.keys(JSON.parse(published).meetings)).toHaveLength(20);
  expect(await peer('a', { maxFiles: 64 }).ready).toEqual({ ok: true });
  expect(manifest()).toBe(published);
}, forced ? 90_000 : 15_000);

it('keeps all 40 same-epoch meetings and sweeps their deadlines', async () => {
  const peers = Array.from({ length: 4 }, () => peer('a', { count: 10 }));
  expect(await Promise.all(peers.map(p => p.ready))).toEqual(Array(4).fill({ ok: true }));
  const before = Object.entries(JSON.parse(manifest()).meetings);
  expect(before).toHaveLength(40);
  const readMeeting = ([id, revision]: [string, unknown]) =>
    JSON.parse(readFileSync(join(home, id, revision + '.json'), 'utf8'));
  expect(new Set(before.map(entry => readMeeting(entry).rounds[0].sweepOrder)).size).toBe(40);
  expect(await peer('a', { tick: '10000000000' }).ready).toEqual({ ok: true });
  expect(Object.entries(JSON.parse(manifest()).meetings).map(entry => readMeeting(entry).rounds[0].rows[0].state))
    .toEqual(Array(40).fill('pending'));
  expect(await peer('a', { tick: '10000000001' }).ready).toEqual({ ok: true });
  expect(Object.entries(JSON.parse(manifest()).meetings).map(entry => readMeeting(entry).rounds[0].rows[0].state))
    .toEqual(Array(40).fill('absent'));
}, forced ? 240_000 : 30_000);
