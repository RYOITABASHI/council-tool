import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
  mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type FileIdentity = { dev: bigint; ino: bigint };

export function sameIdentity(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return a?.dev === b?.dev && a?.ino === b?.ino;
}

export function identityAt(path: string) {
  try {
    return lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
  }
}

export function descriptorPath(fd: number): string {
  return '/proc/self/fd/' + fd;
}

export function entryName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('Invalid council store entry name');
  }
  return name;
}

export function openRegular(path: string, flags = constants.O_RDONLY, mode?: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Council store entry is not a regular file: ' + path);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function stageFile(path: string, bytes: string) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = openRegular(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  const identity = fstatSync(fd, { bigint: true });
  const close = () => {
    try {
      if (sameIdentity(identity, identityAt(temporary))) unlinkSync(temporary);
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    return { path: temporary, identity, close };
  } catch (error) {
    close();
    throw error;
  }
}

type EntryIdentity = NonNullable<ReturnType<typeof identityAt>>;
type Dependency = { identity: EntryIdentity; label: string };
type StoreDirectory = { fd: number; path: string; relative: string };

function sameEntry(expected: EntryIdentity, actual: EntryIdentity | undefined): boolean {
  return actual !== undefined && sameIdentity(expected, actual) && expected.birthtimeNs === actual.birthtimeNs &&
    (expected.isDirectory() || expected.ctimeNs === actual.ctimeNs);
}

const revisionPattern = /^(?:([1-9]\d*)-)?[0-9a-f-]{36}\.json$/;

export function revisionGeneration(name: string): number {
  const generation = Number(revisionPattern.exec(name)?.[1] ?? 0);
  if (!Number.isSafeInteger(generation)) throw new Error('Invalid council store manifest meeting revision generation');
  return generation;
}

export class StoreFiles {
  readonly root: StoreDirectory;
  readonly dependencies = new Map<string, Dependency>();

  constructor(fd: number) {
    this.root = { fd, path: descriptorPath(fd), relative: '' };
  }

  inDirectory<T>(parent: StoreDirectory, name: string, work: (dir: StoreDirectory) => T, create = false): T {
    const relative = join(parent.relative, entryName(name));
    const path = join(parent.path, name);
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      this.track(relative, fstatSync(fd, { bigint: true }), 'data directory');
      return work({ fd, relative, path: descriptorPath(fd) });
    } finally {
      closeSync(fd);
    }
  }

  private track(relative: string, identity: EntryIdentity, label: string): void {
    const previous = this.dependencies.get(relative);
    if (previous) {
      this.checkEntry(previous, identity);
    } else {
      this.dependencies.set(relative, { identity, label });
    }
  }

  read<T>(parent: StoreDirectory, name: string, label: string): T {
    return JSON.parse(this.readBytes(parent, name, label)) as T;
  }

  private readBytes(parent: StoreDirectory, name: string, label: string): string {
    const relative = join(parent.relative, entryName(name));
    const fd = openRegular(join(parent.path, name));
    try {
      this.track(relative, fstatSync(fd, { bigint: true }), label);
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  }

  write(parent: StoreDirectory, name: string, value: unknown, label: string, reuse = false): void {
    const relative = join(parent.relative, entryName(name));
    const path = join(parent.path, name);
    const bytes = JSON.stringify(value);
    const existing = reuse ? identityAt(path) : undefined;
    if (existing) {
      this.track(relative, existing, label);
      if (JSON.stringify(this.read(parent, name, label)) !== bytes) {
        throw new Error('Council store ' + label + ' contents changed');
      }
      return;
    }
    const staged = stageFile(path, bytes);
    try {
      // Immutable revisions and packets must never replace an existing inode.
      linkSync(staged.path, path);
    } finally {
      staged.close();
    }
    const actual = identityAt(path);
    if (!actual || !sameIdentity(staged.identity, actual) || staged.identity.birthtimeNs !== actual.birthtimeNs) {
      throw new Error('Council store ' + label + ' identity changed during transaction');
    }
    this.track(relative, actual, label);
  }

  private checkEntry({ identity, label }: Dependency, actual: EntryIdentity | undefined): void {
    if (!sameEntry(identity, actual)) {
      throw new Error('Council store ' + label + ' identity changed during transaction');
    }
  }

  check(dependencies = this.dependencies): void {
    // Data files are immutable. Retain their identity and timestamps, while
    // keeping descriptors open only for the directory chain being accessed.
    for (const [relative, dependency] of dependencies) {
      this.checkEntry(dependency, identityAt(join(this.root.path, relative)));
    }
  }

  forEachMeetingRevision(visit: (dir: StoreDirectory, name: string) => void): void {
    for (const entry of readdirSync(this.root.path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      this.inDirectory(this.root, entry.name, dir => {
        for (const name of readdirSync(dir.path)) {
          if (revisionPattern.test(name)) visit(dir, name);
        }
      });
    }
  }

  checkRevisionGeneration(generation: number): void {
    this.forEachMeetingRevision((_, name) => {
      if (revisionGeneration(name) > generation) {
        throw new Error('Council store manifest checkpoint is older than a committed meeting revision');
      }
    });
  }

  readRevision<T>(dir: StoreDirectory, name: string, allowPending: boolean): T {
    const pending = allowPending && !identityAt(join(dir.path, name));
    return this.read<T>(dir, pending ? name + '.pending' : name, 'meeting revision');
  }

  publishRevision(dir: StoreDirectory, name: string): void {
    const pendingName = name + '.pending';
    const pending = join(dir.path, pendingName);
    const identity = identityAt(pending);
    if (!identity) return;
    const path = join(dir.path, name);
    const existing = identityAt(path);
    const relative = join(dir.relative, name);
    const pendingRelative = join(dir.relative, pendingName);
    const dependency = this.dependencies.get(existing ? relative : pendingRelative);
    if (!dependency || (existing && !sameIdentity(existing, identity))) {
      throw new Error('Council store meeting revision changed during publication');
    }
    this.checkEntry(dependency, identity);
    if (!existing) linkSync(pending, path);
    // The final name proves this revision's generation was committed.
    // Keep the recoverable pending name until the link is durable.
    fsyncSync(dir.fd);
    unlinkSync(pending);
    const actual = identityAt(path);
    if (!actual || !sameIdentity(identity, actual) || identity.birthtimeNs !== actual.birthtimeNs) {
      throw new Error('Council store meeting revision changed during publication');
    }
    this.dependencies.delete(pendingRelative);
    this.dependencies.set(relative, { ...dependency, identity: actual });
  }

  hasUnexpectedPresenceAnchor(enrollingDirectory?: string): boolean {
    const names = readdirSync(this.root.path).filter(name => name.startsWith('.presence.'));
    const allowed = enrollingDirectory === undefined ? undefined : '.presence.' + enrollingDirectory;
    return names.some(name => name !== allowed) ||
      (identityAt(join(this.root.path, '.presence'))?.nlink ?? 0n) > BigInt(1 + names.length);
  }

  checkpointGeneration(): number {
    let generation = 0;
    for (const name of readdirSync(this.root.path)) {
      const match = /^\.(?:checkpoint|commit|commit-proof)\.([1-9]\d*)\.json$/.exec(name);
      if (!match) continue;
      const candidate = Number(match[1]);
      if (!Number.isSafeInteger(candidate)) throw new Error('Invalid council store manifest checkpoint generation');
      generation = Math.max(generation, candidate);
    }
    return generation;
  }

  readCheckpoint(generation: number): string {
    let bytes: string | undefined;
    for (const [name, label] of [
      [this.proofName(generation), 'manifest commit proof'],
      [this.checkpointName(generation), 'manifest checkpoint'],
      [this.commitName(generation), 'manifest commit record'],
    ] as const) {
      if (!identityAt(join(this.root.path, name))) continue;
      const candidate = this.readBytes(this.root, name, label);
      if (bytes !== undefined && bytes !== candidate) {
        throw new Error('Council store manifest checkpoint disagrees with its commit evidence');
      }
      bytes = candidate;
    }
    if (bytes === undefined) throw new Error('Council store manifest checkpoint is missing');
    return bytes;
  }

  ensureCheckpointArtifacts(generation: number, bytes: string): void {
    if (!this.dependencies.has(this.proofName(generation))) {
      // Backfill the independent copy for a validated checkpoint from an older store.
      this.publishCheckpointProof(generation, bytes, () => this.check());
    }
    const checkpoint = this.checkpointName(generation);
    const commit = this.commitName(generation);
    const haveCheckpoint = this.dependencies.has(checkpoint);
    const haveCommit = this.dependencies.has(commit);
    if (haveCheckpoint && haveCommit) return;
    const checkpointPath = join(this.root.path, checkpoint);
    const commitPath = join(this.root.path, commit);
    const source = haveCheckpoint ? checkpoint : commit;
    const dependency = this.dependencies.get(source);
    // If only the proof survived, restore both aliases on a fresh inode.
    const staged = dependency ? undefined : stageFile(checkpointPath, bytes);
    const path = staged?.path ?? join(this.root.path, source);
    const identity = staged?.identity ?? dependency!.identity;
    try {
      if (dependency) this.checkEntry(dependency, identityAt(path));
      if (!haveCheckpoint) linkSync(path, checkpointPath);
      if (!haveCommit) linkSync(path, commitPath);
      fsyncSync(this.root.fd);
    } finally {
      staged?.close();
    }
    const actual = identityAt(checkpointPath);
    if (!actual || !sameIdentity(identity, actual) || actual.birthtimeNs !== identity.birthtimeNs ||
        !sameEntry(actual, identityAt(commitPath))) {
      throw new Error('Council store manifest checkpoint changed during recovery');
    }
    this.dependencies.set(checkpoint, { identity: actual, label: 'manifest checkpoint' });
    this.dependencies.set(commit, { identity: actual, label: 'manifest commit record' });
    if (this.readCheckpoint(generation) !== bytes) {
      throw new Error('Council store manifest checkpoint contents changed during recovery');
    }
  }

  publishCheckpoint(generation: number, bytes: string, check: () => void, linked: () => void): void {
    const name = this.checkpointName(generation);
    const path = join(this.root.path, name);
    const staged = stageFile(path, bytes);
    try {
      // The proof commits the generation on its own inode. Sync the name
      // before exposing either alias or publishing any meeting revision.
      this.publishCheckpointProof(generation, bytes, check, linked);
      linkSync(staged.path, join(this.root.path, this.commitName(generation)));
      linkSync(staged.path, path);
      fsyncSync(this.root.fd);
    } finally {
      staged.close();
    }
    const actual = identityAt(path);
    if (!actual || !sameIdentity(staged.identity, actual) || staged.identity.birthtimeNs !== actual.birthtimeNs ||
        this.readCheckpoint(generation) !== bytes) {
      throw new Error('Council store manifest checkpoint artifact changed during publication');
    }
  }

  private publishCheckpointProof(generation: number, bytes: string, check: () => void, linked?: () => void): void {
    const name = this.proofName(generation);
    const path = join(this.root.path, name);
    const staged = stageFile(path, bytes);
    try {
      check();
      linkSync(staged.path, path);
      linked?.();
      fsyncSync(this.root.fd);
    } finally {
      staged.close();
    }
    const actual = identityAt(path);
    if (!actual || !sameIdentity(staged.identity, actual) || staged.identity.birthtimeNs !== actual.birthtimeNs) {
      throw new Error('Council store manifest commit proof changed during publication');
    }
    this.track(name, actual, 'manifest commit proof');
  }

  private proofName(generation: number): string {
    return `.commit-proof.${generation}.json`;
  }

  private checkpointName(generation: number): string {
    return `.checkpoint.${generation}.json`;
  }

  private commitName(generation: number): string {
    return `.commit.${generation}.json`;
  }
}

type UndoRecord = { dev: string; ino: string; bytes: string };
export type PresenceBinding = { directory: string; inode: string; token: string };
export type DurableRecord = { manifest: string | null; presence: PresenceBinding };
export type DurableSnapshot = { record: DurableRecord; identity: EntryIdentity };

function replaceContents(fd: number, contents: string): void {
  const bytes = Buffer.from(contents);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written === 0) throw new Error('Could not write council store manifest');
    offset += written;
  }
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
}

export class ManifestFile {
  readonly path: string;
  private readonly initPath: string;
  private readonly undoPath: string;
  private readonly targetPath: string;
  private readonly durablePath: string;
  private readonly enrollmentPath: string;
  private readonly legacyPublicationPath: string;

  constructor(directory: string, directoryKey: string, private readonly directoryFd: number) {
    this.path = join(directory, 'manifest.json');
    this.initPath = join(directory, '.manifest-init.' + directoryKey);
    this.undoPath = join(directory, '.manifest-undo.' + directoryKey);
    this.targetPath = join(directory, '.manifest-target.' + directoryKey);
    this.durablePath = join(directory, '.manifest-state');
    this.enrollmentPath = join(directory, '.manifest-enrollment');
    this.legacyPublicationPath = join(directory, '.manifest-head');
  }

  hasLegacyPublication(): boolean {
    return identityAt(this.legacyPublicationPath) !== undefined;
  }

  checkLegacyPublication(durable: DurableSnapshot): void {
    let fd: number;
    try {
      fd = openRegular(this.legacyPublicationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const publication = JSON.parse(readFileSync(fd, 'utf8')) as {
        previous?: string | null; candidate?: { digest?: string };
      } | null;
      const recorded = publication?.candidate === undefined ? publication?.previous : publication.candidate?.digest;
      this.checkDurable(durable);
      const state = openRegular(this.durablePath);
      try {
        const digest = createHash('sha256').update(readFileSync(state)).digest('hex');
        this.checkDurable(durable);
        // Compatibility for the old format only. A conflict prevents
        // migration, and the old record can never select a checkpoint.
        if (recorded !== digest) {
          throw new Error('Council store manifest checkpoint conflicts with its legacy publication record');
        }
      } finally {
        closeSync(state);
      }
    } finally {
      closeSync(fd);
    }
  }

  readDurable(): DurableSnapshot | undefined {
    return this.readRecord(this.durablePath);
  }

  readEnrollment(): DurableSnapshot | undefined {
    return this.readRecord(this.enrollmentPath);
  }

  private readRecord(path: string): DurableSnapshot | undefined {
    let fd: number;
    try {
      fd = openRegular(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const identity = fstatSync(fd, { bigint: true });
      const record = JSON.parse(readFileSync(fd, 'utf8')) as DurableRecord | null;
      const binding = record?.presence;
      if (!record || (record.manifest !== null && typeof record.manifest !== 'string') ||
          !binding || typeof binding.directory !== 'string' || !/^\d+:\d+$/.test(binding.directory) ||
          typeof binding.inode !== 'string' || !/^\d+:\d+:-?\d+$/.test(binding.inode) ||
          typeof binding.token !== 'string' || !/^[0-9a-f-]{36}$/.test(binding.token)) {
        throw new Error('Invalid council store manifest checkpoint record');
      }
      const snapshot = { identity, record };
      this.checkRecord(path, snapshot);
      return snapshot;
    } finally {
      closeSync(fd);
    }
  }

  checkDurable(snapshot: DurableSnapshot | undefined): void {
    this.checkRecord(this.durablePath, snapshot);
  }

  checkEnrollment(snapshot: DurableSnapshot | undefined): void {
    this.checkRecord(this.enrollmentPath, snapshot);
  }

  private checkRecord(path: string, snapshot: DurableSnapshot | undefined): void {
    const actual = identityAt(path);
    if (snapshot ? !sameEntry(snapshot.identity, actual) : actual !== undefined) {
      throw new Error('Council store manifest checkpoint record changed during transaction');
    }
  }

  writeDurable(record: DurableRecord, prior: DurableSnapshot | undefined, check: () => void,
    renamed?: () => void): DurableSnapshot {
    return this.writeRecord(this.durablePath, record, () => {
      check();
      this.checkDurable(prior);
    }, renamed);
  }

  stageEnrollment(record: DurableRecord, check: () => void): DurableSnapshot {
    return this.writeRecord(this.enrollmentPath, record, () => {
      check();
      this.checkDurable(undefined);
      this.checkEnrollment(undefined);
    });
  }

  completeEnrollment(enrollment: DurableSnapshot, check: () => void, renamed: () => void): DurableSnapshot {
    check();
    this.checkDurable(undefined);
    this.checkEnrollment(enrollment);
    // Publishing the initial binding consumes the intent in the same rename.
    return this.renameRecord(this.enrollmentPath, this.durablePath, enrollment, renamed);
  }

  private writeRecord(path: string, record: DurableRecord, check: () => void, renamed?: () => void): DurableSnapshot {
    const staged = stageFile(path, JSON.stringify(record));
    try {
      check();
      return this.renameRecord(staged.path, path, { identity: staged.identity, record }, renamed);
    } finally {
      staged.close();
    }
  }

  private renameRecord(from: string, to: string, snapshot: DurableSnapshot, renamed?: () => void): DurableSnapshot {
    renameSync(from, to);
    renamed?.();
    fsyncSync(this.directoryFd);
    const identity = identityAt(to);
    if (!identity || !sameIdentity(snapshot.identity, identity) || snapshot.identity.birthtimeNs !== identity.birthtimeNs) {
      throw new Error('Council store manifest checkpoint record changed during transaction');
    }
    return { ...snapshot, identity };
  }

  validateBeforeLock(validate: (bytes: string | undefined) => unknown): void {
    const pendingWrite = () => identityAt(this.targetPath) || identityAt(this.undoPath) || identityAt(this.initPath);
    const validateCurrent = () => {
      const current = this.open();
      try {
        validate(current?.bytes);
      } finally {
        if (current) closeSync(current.fd);
      }
    };
    if (pendingWrite()) return;
    try {
      validateCurrent();
    } catch (error) {
      // A cooperating writer may have started or finished a journaled
      // update during this optimistic read. Validate again under the lock.
      if (pendingWrite()) return;
      try {
        validateCurrent();
      } catch {
        if (!pendingWrite()) throw error;
      }
    }
  }

  open() {
    let fd: number;
    try {
      fd = openRegular(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const identity = fstatSync(fd, { bigint: true });
      this.check(identity);
      return { fd, identity, bytes: readFileSync(fd, 'utf8') };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  initialize() {
    // A null manifest represents a store whose first checkpoint is unpublished.
    const fd = openRegular(this.initPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const identity = fstatSync(fd, { bigint: true });
    try {
      writeFileSync(fd, 'null');
      fsyncSync(fd);
      try {
        linkSync(this.initPath, this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Council store manifest identity changed during transaction');
        }
        throw error;
      }
    } finally {
      closeSync(fd);
      if (sameIdentity(identity, identityAt(this.initPath))) unlinkSync(this.initPath);
    }
    fsyncSync(this.directoryFd);
    const snapshot = this.open();
    if (!snapshot || !sameIdentity(identity, snapshot.identity)) {
      if (snapshot) closeSync(snapshot.fd);
      throw new Error('Council store manifest identity changed during transaction');
    }
    return snapshot;
  }

  check(identity: FileIdentity | undefined): void {
    const actual = identityAt(this.path);
    const links = actual && sameIdentity(actual, identityAt(this.targetPath)) ? 2n : 1n;
    if (!sameIdentity(actual, identity) || (actual !== undefined && actual.nlink !== links)) {
      throw new Error('Council store manifest identity changed during transaction');
    }
  }

  checkContents(snapshot: NonNullable<ReturnType<ManifestFile['open']>> | undefined, bytes = snapshot?.bytes): void {
    this.check(snapshot?.identity);
    if (snapshot && readFileSync(descriptorPath(snapshot.fd), 'utf8') !== bytes) {
      throw new Error('Council store manifest contents changed during transaction');
    }
  }

  recover(durable: DurableSnapshot | undefined, published: string, verify: () => void,
    updateRecord?: (current: NonNullable<ReturnType<ManifestFile['open']>>) => void): void {
    const target = identityAt(this.targetPath);
    const undo = identityAt(this.undoPath);
    if (target || undo) {
      if (!durable || !target?.isFile() || (updateRecord && !undo)) {
        throw new Error('Council store manifest journal cannot recover its checkpoint');
      }
      if (undo) {
        const fd = openRegular(this.undoPath);
        try {
          this.checkUndo(undo);
          const record = JSON.parse(readFileSync(fd, 'utf8')) as UndoRecord | null;
          if (!record || String(target.dev) !== record.dev || String(target.ino) !== record.ino ||
              typeof record.bytes !== 'string' ||
              (updateRecord && record.bytes !== (durable.record.manifest ?? 'null'))) {
            throw new Error('Council store manifest journal target changed before recovery');
          }
        } finally {
          closeSync(fd);
        }
      }
      const current = this.open();
      if (!current) throw new Error('Council store manifest disappeared before recovery');
      try {
        this.checkTarget(target);
        this.checkDurable(durable);
        if (sameIdentity(current.identity, target)) {
          this.restoreManifest(current, published, target, durable, verify);
        } else if (current.bytes !== published) {
          // Recovery never overwrites a replacement inode. Its contents
          // must already match the newest committed checkpoint.
          throw new Error('Council store manifest replacement disagrees with the committed checkpoint');
        }
        updateRecord?.({ ...current, bytes: published });
        this.check(current.identity);
      } finally {
        closeSync(current.fd);
      }
      if (undo) {
        this.checkUndo(undo);
        this.checkTarget(target);
        unlinkSync(this.undoPath);
        fsyncSync(this.directoryFd);
      }
      this.checkTarget(target);
      unlinkSync(this.targetPath);
      fsyncSync(this.directoryFd);
    }
    const init = identityAt(this.initPath);
    if (init) {
      if (!init.isFile()) throw new Error('Council store manifest initializer changed');
      unlinkSync(this.initPath);
      fsyncSync(this.directoryFd);
    }
  }

  private restoreManifest(current: NonNullable<ReturnType<ManifestFile['open']>>, published: string,
    target: FileIdentity, durable: DurableSnapshot, verify: () => void): void {
    if (current.bytes === published) return;
    verify();
    this.checkDurable(durable);
    this.checkTarget(target);
    this.checkContents(current);
    const fd = openSync(descriptorPath(current.fd), constants.O_RDWR);
    try {
      replaceContents(fd, published);
    } finally {
      closeSync(fd);
    }
  }

  private checkUndo(identity: FileIdentity): void {
    if (!sameIdentity(identity, identityAt(this.undoPath))) {
      throw new Error('Council store manifest journal identity changed during transaction');
    }
  }

  private checkTarget(identity: FileIdentity): void {
    if (!sameIdentity(identity, identityAt(this.targetPath))) {
      throw new Error('Council store manifest journal target changed during transaction');
    }
  }

  publish(snapshot: NonNullable<ReturnType<ManifestFile['open']>>, previousDurable: DurableSnapshot,
    record: DurableRecord & { manifest: string }, publishCheckpoint: (check: () => void, linked: () => void) => void,
    check: (durable: DurableSnapshot, committed: boolean) => void, renamed?: () => void): DurableSnapshot {
    const { fd, identity, bytes: previous } = snapshot;
    const { manifest: bytes } = record;
    const undo: UndoRecord = { dev: String(identity.dev), ino: String(identity.ino), bytes: previous };
    const staged = stageFile(this.path, JSON.stringify(undo));
    let committed = false;
    let finished = false;
    try {
      this.check(identity);
      const target = openSync(descriptorPath(fd), constants.O_RDWR);
      let anchored = false;
      let dirty = false;
      try {
        linkSync(this.path, this.targetPath);
        anchored = true;
        this.checkTarget(identity);
        linkSync(staged.path, this.undoPath);
        fsyncSync(this.directoryFd);
        this.checkUndo(staged.identity);
        check(previousDurable, false);
        this.checkContents(snapshot);
        dirty = true;
        replaceContents(target, bytes);
        publishCheckpoint(() => {
          check(previousDurable, false);
          this.checkUndo(staged.identity);
          this.checkTarget(identity);
          this.checkContents(snapshot, bytes);
        }, () => { committed = true; });
        const published = this.writeDurable(record, previousDurable, () => {
          check(previousDurable, true);
          this.checkContents(snapshot, bytes);
        }, renamed);
        check(published, true);
        this.checkContents(snapshot, bytes);
        this.checkUndo(staged.identity);
        this.checkTarget(identity);
        unlinkSync(this.undoPath);
        fsyncSync(this.directoryFd);
        finished = true;
        return published;
      } catch (error) {
        // Once the commit proof has been linked, leave the journal in place so
        // reopening can finish updating the caches from the checkpoint.
        if (!committed) {
          if (dirty) replaceContents(target, previous);
          if (sameIdentity(staged.identity, identityAt(this.undoPath))) {
            unlinkSync(this.undoPath);
            fsyncSync(this.directoryFd);
          }
        }
        throw error;
      } finally {
        closeSync(target);
        if (anchored && (!committed || finished) && !identityAt(this.undoPath) &&
            sameIdentity(identity, identityAt(this.targetPath))) {
          unlinkSync(this.targetPath);
        }
      }
    } finally {
      staged.close();
    }
  }
}
