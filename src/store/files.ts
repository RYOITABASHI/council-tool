import {
  closeSync, constants, copyFileSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
  mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  const close = (retain = false) => {
    try {
      if (!retain && sameIdentity(identity, identityAt(temporary))) unlinkSync(temporary);
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    return { path: temporary, identity: fstatSync(fd, { bigint: true }), close };
  } catch (error) {
    close();
    throw error;
  }
}

type EntryIdentity = NonNullable<ReturnType<typeof identityAt>>;
type Dependency = { identity: EntryIdentity; label: string; digest?: string | undefined; exclusive?: boolean };
type StoreDirectory = { fd: number; path: string; relative: string };

export function contentDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const linkCapabilities = new Map<string, boolean>();
const copyCapabilities = new Set<string>();
const unavailableLinkErrors = new Set(['EACCES', 'EPERM', 'EOPNOTSUPP', 'ENOSYS']);
const nonceAttribute = 'user.council_store_identity';
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

function statFd(fd: number): EntryIdentity {
  return fstatSync(fd, { bigint: true });
}

function directoryKey(fd: number): string {
  const stat = statFd(fd);
  return `${stat.dev}:${stat.ino}`;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export function probeLinkCapability(dirFd: number): boolean {
  const key = directoryKey(dirFd);
  const cached = linkCapabilities.get(key);
  if (cached !== undefined) return cached;
  const source = join(descriptorPath(dirFd), '.link-probe-' + randomUUID() + '.src');
  const destination = source.slice(0, -4) + '.dst';
  const fd = openRegular(source, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  const own = statFd(fd);
  let available = true;
  try {
    writeFileSync(fd, 'council link capability');
    fsyncSync(fd);
    try {
      linkSync(source, destination);
    } catch (error) {
      if (!unavailableLinkErrors.has(errno(error) ?? '')) throw error;
      available = false;
    }
    if (available) {
      for (const path of [source, destination]) {
        const entry = identityAt(path);
        if (!entry?.isFile() || !sameIdentity(entry, own) || entry.nlink !== 2n) {
          throw new Error('Council store link probe identity changed');
        }
      }
    }
  } finally {
    try {
      for (const path of [destination, source]) {
        if (sameIdentity(own, identityAt(path))) unlinkSync(path);
      }
      fsyncSync(dirFd);
    } finally {
      closeSync(fd);
    }
  }
  linkCapabilities.set(key, available);
  return available;
}

function verifiedFile(fd: number, path: string, expected: EntryIdentity, digest: string): void {
  const actual = statFd(fd);
  const entry = identityAt(path);
  if (!actual.isFile() || !entry?.isFile() || actual.nlink !== 1n || entry.nlink !== 1n ||
      (actual.mode & 0o7777n) !== 0o600n || !sameEntry(expected, actual) || !sameEntry(actual, entry) ||
      contentDigest(readFileSync(descriptorPath(fd))) !== digest) {
    throw new Error('Council store verified file identity or contents changed: ' + path);
  }
  const after = statFd(fd);
  const live = identityAt(path);
  if (!sameEntry(actual, after) || !sameEntry(actual, live) || after.nlink !== 1n || live?.nlink !== 1n ||
      after.mode !== actual.mode || live.mode !== actual.mode) {
    throw new Error('Council store verified file identity changed: ' + path);
  }
}

export function copyExclusive(source: string, expected: EntryIdentity, destination: string, parentFd: number,
  digest: string, verified?: (identity: EntryIdentity) => void): EntryIdentity {
  const from = openRegular(source);
  try {
    verifiedFile(from, source, expected, digest);
    copyFileSync(descriptorPath(from), destination, constants.COPYFILE_EXCL);
    const entry = identityAt(destination);
    const to = openRegular(destination);
    try {
      const actual = statFd(to);
      if (!entry?.isFile() || !sameEntry(actual, entry) || sameIdentity(actual, expected) ||
          actual.nlink !== 1n || actual.size !== expected.size) {
        throw new Error('Council store copied file identity changed: ' + destination);
      }
      if ((actual.mode & 0o7777n) !== 0o600n) fchmodSync(to, 0o600);
      verifiedFile(to, destination, actual, digest);
      verified?.(actual);
      fsyncSync(to);
      fsyncSync(parentFd);
      verifiedFile(from, source, expected, digest);
      verifiedFile(to, destination, actual, digest);
      return statFd(to);
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(from);
  }
}

export function identityNonce(fd: number, check: () => void, install?: string): string | undefined {
  const args = install === undefined ? ['--only-values', '-n', nonceAttribute] : ['-n', nonceAttribute, '-v', install];
  const operation = install === undefined ? 'read' : 'install';
  check();
  const result = spawnSync(install === undefined ? '/bin/getfattr' : '/bin/setfattr',
    [...args, '--', descriptorPath(3)],
    { stdio: ['ignore', 'pipe', 'pipe', fd], env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' });
  check();
  const stderr = result.stderr ?? '';
  if ((result.error && errno(result.error) === 'ENOENT') ||
      /(?:Operation not supported|ENOTSUP|EOPNOTSUPP)\s*$/.test(stderr)) {
    throw new Error('Council store xattr ' + operation + ' unavailable: ' + (result.error?.message ?? stderr.trim()));
  }
  if (!result.error && !result.signal && result.status === 1 && install === undefined &&
      /^(?:getfattr: )?\/proc\/self\/fd\/3: (?:user\.council_store_identity: )?No such attribute\n?$/.test(stderr) &&
      result.stdout === '') return undefined;
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('Council store xattr ' + operation + ' failed: ' +
      (result.error?.message ?? (stderr.trim() || result.signal || String(result.status))));
  }
  if (install !== undefined) return;
  if (result.stdout.length !== 36 || !uuidPattern.test(result.stdout)) {
    throw new Error('Council store xattr identity nonce is malformed');
  }
  return result.stdout;
}

function probeCopyCapability(dirFd: number, checkDirectory: () => void): void {
  const key = directoryKey(dirFd);
  if (copyCapabilities.has(key)) return;
  try {
    const base = join(descriptorPath(dirFd), '.copy-probe-' + randomUUID());
    const source = stageFile(base, 'council copy capability');
    const owned = new Map<string, EntryIdentity>();
    try {
      const occupied = stageFile(base, 'occupied');
      try {
        try {
          copyFileSync(source.path, occupied.path, constants.COPYFILE_EXCL);
          throw new Error('exclusive copy replaced an occupied destination');
        } catch (error) {
          if (errno(error) !== 'EEXIST') throw error;
        }
        for (const staged of [source, occupied]) {
          if (!sameEntry(staged.identity, identityAt(staged.path))) throw new Error('occupied copy changed identity');
        }
      } finally {
        occupied.close();
      }
      const bytes = contentDigest('council copy capability');
      const copy = base + '.dst';
      const identity = copyExclusive(source.path, source.identity, copy, dirFd, bytes,
        identity => { owned.set(copy, identity); });
      const nonce = randomUUID();
      const renamed = base + '.renamed';
      let fd = openRegular(copy, constants.O_RDWR);
      const check = (path: string) => {
        checkDirectory();
        verifiedFile(fd, path, identity, bytes);
      };
      try {
        identityNonce(fd, () => check(copy), nonce);
        fsyncSync(fd);
        renameSync(copy, renamed);
        owned.set(renamed, identity);
        fsyncSync(dirFd);
        closeSync(fd);
        fd = -1;
        fd = openRegular(renamed);
        if (identityNonce(fd, () => check(renamed)) !== nonce) throw new Error('xattr nonce probe readback failed');
      } finally {
        if (fd !== -1) closeSync(fd);
      }
    } finally {
      try {
        for (const [path, identity] of owned) {
          if (sameIdentity(identity, identityAt(path))) unlinkSync(path);
        }
      } finally {
        source.close();
        fsyncSync(dirFd);
      }
    }
  } catch (error) {
    throw new Error('Council store fallback self-probe failed: ' + (error as Error).message, { cause: error });
  }
  copyCapabilities.add(key);
}

export function sameEntry(expected: EntryIdentity, actual: EntryIdentity | undefined): boolean {
  // btrfs can advance ctime after a write even when the file is untouched between stats.
  return actual !== undefined && sameIdentity(expected, actual) &&
    (expected.isDirectory() || (expected.mtimeNs === actual.mtimeNs && expected.size === actual.size));
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

  constructor(fd: number, readonly noLink = false, private readonly checkDirectory = () => {}) {
    this.root = { fd, path: descriptorPath(fd), relative: '' };
  }

  requireCopySupport(): void {
    this.checkDirectory();
    probeCopyCapability(this.root.fd, this.checkDirectory);
  }

  inDirectory<T>(parent: StoreDirectory, name: string, work: (dir: StoreDirectory) => T, create = false): T {
    const relative = join(parent.relative, entryName(name));
    const path = join(parent.path, name);
    if (create) {
      if (this.noLink) this.requireCopySupport();
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

  private track(relative: string, identity: EntryIdentity, label: string, digest?: string, exclusive = false): void {
    const previous = this.dependencies.get(relative);
    if (previous) {
      this.checkEntry(previous, identity);
      if (digest === undefined) return;
      if (previous.digest !== undefined && previous.digest !== digest) {
        throw new Error('Council store ' + label + ' contents changed during transaction');
      }
    }
    this.dependencies.set(relative, { identity, label, digest, exclusive: exclusive || previous?.exclusive === true });
  }

  read<T>(parent: StoreDirectory, name: string, label: string): T {
    return JSON.parse(this.readBytes(parent, name, label)) as T;
  }

  private readBytes(parent: StoreDirectory, name: string, label: string, trackContents = false): string {
    const relative = join(parent.relative, entryName(name));
    const fd = openRegular(join(parent.path, name));
    try {
      const identity = fstatSync(fd, { bigint: true });
      const bytes = readFileSync(fd);
      this.track(relative, identity, label, trackContents ? contentDigest(bytes) : undefined);
      return bytes.toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  private verifiedBytes(parent: StoreDirectory, name: string, label: string, digest: string,
    { singleLink = true, checkModeAfterDigest = false } = {}): string | undefined {
    const path = join(parent.path, entryName(name));
    const entry = identityAt(path);
    if (!entry) return;
    const wrongMode = singleLink && (entry.mode & 0o7777n) !== 0o600n;
    if (!entry.isFile() || (singleLink && entry.nlink !== 1n) || (wrongMode && !checkModeAfterDigest)) {
      throw new Error('Council store ' + label + ' identity changed');
    }
    const fd = openRegular(path);
    try {
      const actual = statFd(fd);
      const bytes = readFileSync(fd);
      const after = statFd(fd);
      const live = identityAt(path);
      if (!sameEntry(entry, actual) || !sameEntry(actual, after) || !sameEntry(actual, live) ||
          (singleLink && (actual.nlink !== 1n || after.nlink !== 1n || live?.nlink !== 1n))) {
        throw new Error('Council store ' + label + ' identity changed');
      }
      const matches = contentDigest(bytes) === digest;
      if (singleLink && (!checkModeAfterDigest || matches) &&
          (wrongMode || entry.mode !== actual.mode || actual.mode !== after.mode || actual.mode !== live?.mode)) {
        throw new Error('Council store ' + label + ' identity changed');
      }
      if (!matches) return;
      this.track(join(parent.relative, name), actual, label, digest, singleLink);
      return bytes.toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  private receipt(parent: StoreDirectory, prefix: string, pattern: RegExp) {
    const names = readdirSync(parent.path).filter(name => name.startsWith(prefix) && !name.endsWith('.invalid'));
    if (names.length === 0) return;
    const name = names[0]!;
    const match = pattern.exec(name.slice(prefix.length));
    const identity = identityAt(join(parent.path, name));
    if (names.length !== 1 || !match || !identity?.isDirectory() || (identity.mode & 0o777n) !== 0o700n) {
      throw new Error('Invalid council store receipt: ' + name);
    }
    const path = join(parent.path, name);
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(identity, statFd(fd)) || readdirSync(descriptorPath(fd)).length ||
          !sameIdentity(identity, identityAt(path))) throw new Error('Invalid council store receipt: ' + name);
    } finally {
      closeSync(fd);
    }
    this.track(join(parent.relative, name), identity, 'receipt');
    return { name, identity, digest: match[1]!, attempt: match[2] };
  }

  private seal(parent: StoreDirectory, name: string, label: string, visible?: () => void): void {
    const path = join(parent.path, name);
    mkdirSync(path, { mode: 0o700 });
    visible?.();
    const identity = identityAt(path);
    if (!identity?.isDirectory() || (identity.mode & 0o777n) !== 0o700n) {
      throw new Error('Council store ' + label + ' identity changed');
    }
    fsyncSync(parent.fd);
    if (!sameIdentity(identity, identityAt(path))) throw new Error('Council store ' + label + ' identity changed');
    this.track(join(parent.relative, name), identity, label);
  }

  private copy(parent: StoreDirectory, name: string, source: string, identity: EntryIdentity,
    digest: string, label: string): void {
    this.requireCopySupport();
    const actual = copyExclusive(source, identity, join(parent.path, name), parent.fd, digest);
    this.track(join(parent.relative, name), actual, label, digest, true);
  }

  private syncTrackedCopy(parent: StoreDirectory, name: string, digest: string): void {
    const path = join(parent.path, name);
    const dependency = this.dependencies.get(join(parent.relative, name))!;
    const fd = openRegular(path);
    try {
      verifiedFile(fd, path, dependency.identity, digest);
      fsyncSync(fd);
      fsyncSync(parent.fd);
      verifiedFile(fd, path, dependency.identity, digest);
    } finally {
      closeSync(fd);
    }
  }

  private quarantine(parent: StoreDirectory, name: string, digest: string, label: string, authorize: () => void): void {
    const path = join(parent.path, name);
    const candidate = identityAt(path);
    if (!candidate) return;
    this.requireCopySupport();
    authorize();
    this.check();
    this.checkStagedContents();
    if (!candidate.isFile() || candidate.nlink !== 1n || this.dependencies.has(join(parent.relative, name))) {
      throw new Error('Council store ' + label + ' identity changed during repair');
    }
    const fd = openRegular(path);
    try {
      if (!sameEntry(candidate, statFd(fd))) throw new Error('Council store ' + label + ' changed during repair');
      const bytes = readFileSync(fd);
      if (contentDigest(bytes) === digest ||
          !sameEntry(candidate, statFd(fd)) || !sameEntry(candidate, identityAt(path)) ||
          identityAt(path)?.nlink !== 1n) {
        throw new Error('Council store ' + label + ' changed during repair');
      }
      renameSync(path, path + '.' + randomUUID() + '.invalid');
      fsyncSync(parent.fd);
    } finally {
      closeSync(fd);
    }
  }

  private packetReceipt(dir: StoreDirectory, name: string) {
    const receipt = this.receipt(dir, '.packet-receipt.' + entryName(name) + '.',
      /^([0-9a-f]{64})\.([0-9a-f-]{36}|adopted-[0-9a-f]{64})$/);
    if (!receipt) return;
    const adopted = receipt.attempt?.startsWith('adopted-') ? receipt.attempt.slice('adopted-'.length) : undefined;
    return { ...receipt, adopted };
  }

  readPacket<T>(dir: StoreDirectory, name: string, expected?: string): T {
    const receipt = this.packetReceipt(dir, name);
    if (!receipt) {
      if (expected !== undefined) throw new Error('Council store packet receipt is missing');
      return this.read<T>(dir, name, 'packet');
    }
    if (expected !== undefined && expected !== receipt.digest) throw new Error('Council store packet receipt disagrees');
    const bytes = this.verifiedBytes(dir, name, 'packet', receipt.digest, { singleLink: !receipt.adopted }) ??
      (receipt.adopted ? undefined :
        this.verifiedBytes(dir, '.packet-stage.' + receipt.attempt, 'packet stage', receipt.digest));
    if (bytes === undefined) throw new Error('Council store packet contents disagree with its receipt');
    return JSON.parse(bytes) as T;
  }

  writePacket(dir: StoreDirectory, name: string, value: unknown, authorize: () => void,
    committedDigest: () => string | undefined): string | undefined {
    const path = join(dir.path, entryName(name));
    const bytes = JSON.stringify(value);
    const digest = contentDigest(bytes);
    const receipt = this.packetReceipt(dir, name);
    if (receipt) {
      if (receipt.adopted) {
        const existing = this.verifiedBytes(dir, name, 'packet', receipt.digest, { singleLink: false });
        if (existing === undefined || receipt.adopted !== digest) {
          throw new Error('Council store legacy packet contents changed');
        }
      } else {
        const occupied = identityAt(path);
        if (occupied && (!occupied.isFile() || occupied.nlink !== 1n)) {
          throw new Error('Foreign or unexplained packet at ' + name);
        }
        const existing = this.verifiedBytes(dir, name, 'packet', receipt.digest, { checkModeAfterDigest: true });
        if (receipt.digest !== digest) throw new Error('Council store packet receipt disagrees');
        if (existing === undefined) {
          const stage = '.packet-stage.' + receipt.attempt;
          if (this.verifiedBytes(dir, stage, 'packet stage', digest) === undefined) {
            throw new Error('Council store packet stage contents disagree with its receipt');
          }
          if (this.packetReceipt(dir, name)?.name !== receipt.name) {
            throw new Error('Council store packet receipt changed before retry');
          }
          fsyncSync(dir.fd);
          if (!sameIdentity(receipt.identity, identityAt(join(dir.path, receipt.name)))) {
            throw new Error('Council store packet receipt changed before retry');
          }
          const boundDigest = committedDigest() ?? this.dependencies.get(join(dir.relative, name))?.digest;
          if (boundDigest !== undefined && boundDigest !== receipt.digest) {
            throw new Error('Council store packet conflicts with the digest committed for it');
          }
          if (occupied) this.quarantine(dir, name, digest, 'packet', authorize);
          this.copy(dir, name, join(dir.path, stage), this.dependencies.get(join(dir.relative, stage))!.identity,
            digest, 'packet');
        } else {
          // A matching copy may have stopped before either sync.
          this.syncTrackedCopy(dir, name, digest);
        }
      }
      return receipt.digest;
    }
    if (!this.noLink) {
      this.write(dir, name, value, 'packet', true);
      return;
    }
    this.requireCopySupport();
    if (identityAt(path)) {
      const existing = this.readBytes(dir, name, 'packet', true);
      if (JSON.stringify(JSON.parse(existing)) !== bytes) throw new Error('Council store legacy packet contents changed');
      this.checkStagedContents();
      const adopted = this.dependencies.get(join(dir.relative, name))!.digest!;
      // The legacy bytes and their validated serialization can have
      // different digests. The receipt preserves both for future reuse.
      this.seal(dir, '.packet-receipt.' + name + '.' + adopted + '.adopted-' + digest, 'packet receipt');
      return adopted;
    }
    const attempt = randomUUID();
    const stage = '.packet-stage.' + attempt;
    const source = join(dir.path, stage);
    const fd = openRegular(source, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let identity: EntryIdentity;
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      identity = statFd(fd);
      fsyncSync(dir.fd);
    } finally {
      closeSync(fd);
    }
    this.seal(dir, '.packet-receipt.' + name + '.' + digest + '.' + attempt, 'packet receipt');
    this.copy(dir, name, source, identity, digest, 'packet');
    return digest;
  }

  write(parent: StoreDirectory, name: string, value: unknown, label: string, reuse = false): void {
    const relative = join(parent.relative, entryName(name));
    const path = join(parent.path, name);
    const bytes = JSON.stringify(value);
    const existing = reuse ? identityAt(path) : undefined;
    if (existing) {
      this.track(relative, existing, label);
      if (JSON.stringify(JSON.parse(this.readBytes(parent, name, label, true))) !== bytes) {
        throw new Error('Council store ' + label + ' contents changed');
      }
      return;
    }
    if (this.noLink) this.requireCopySupport();
    const staged = stageFile(path, bytes);
    try {
      // Immutable revisions and packets must never replace an existing inode.
      if (this.noLink) {
        this.copy(parent, name, staged.path, staged.identity, contentDigest(bytes), label);
        return;
      }
      linkSync(staged.path, path);
    } finally {
      staged.close();
    }
    const actual = identityAt(path);
    if (!actual || !sameIdentity(staged.identity, actual)) {
      throw new Error('Council store ' + label + ' identity changed during transaction');
    }
    this.track(relative, actual, label, contentDigest(bytes));
  }

  private checkEntry({ identity, label, exclusive }: Dependency, actual: EntryIdentity | undefined): void {
    if (!sameEntry(identity, actual) ||
        (exclusive && (!actual?.isFile() || actual.nlink !== 1n || (actual.mode & 0o7777n) !== 0o600n))) {
      throw new Error('Council store ' + label + ' identity changed during transaction');
    }
  }

  private contentsMatch(path: string, dependency: Dependency): boolean {
    const fd = openRegular(path);
    try {
      this.checkEntry(dependency, fstatSync(fd, { bigint: true }));
      const digest = contentDigest(readFileSync(fd));
      this.checkEntry(dependency, identityAt(path));
      return digest === dependency.digest;
    } finally {
      closeSync(fd);
    }
  }

  checkStagedContents(): void {
    for (const [relative, dependency] of this.dependencies) {
      if (dependency.digest !== undefined && !this.contentsMatch(join(this.root.path, relative), dependency)) {
        throw new Error('Council store ' + dependency.label + ' contents changed during publication');
      }
    }
  }

  check(dependencies = this.dependencies): void {
    // Data files are immutable. Retain their identity and timestamps, while
    // keeping descriptors open only for the directory chain being accessed.
    for (const [relative, dependency] of dependencies) {
      this.checkEntry(dependency, identityAt(join(this.root.path, relative)));
    }
  }

  forEachMeetingRevision(visit: (dir: StoreDirectory, name: string) => void,
    visitReceipt?: (dir: StoreDirectory, name: string) => void): void {
    for (const entry of readdirSync(this.root.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || /^\.(?:proof-attempt|commit-seal|manifest-attempt-v2|manifest-init)\./.test(entry.name)) continue;
      this.inDirectory(this.root, entry.name, dir => {
        for (const name of readdirSync(dir.path)) {
          if (revisionPattern.test(name)) visit(dir, name);
          else if (name.startsWith('.revision-receipt.')) visitReceipt?.(dir, name);
        }
      });
    }
  }

  checkRevisionGeneration(generation: number): void {
    this.forEachMeetingRevision((_, name) => {
      if (revisionGeneration(name) > generation) {
        throw new Error('Council store manifest checkpoint is older than a committed meeting revision');
      }
    }, (dir, name) => {
      const match = /^\.revision-receipt\.(.+\.json)\.([0-9a-f]{64})$/.exec(name);
      if (!match || !revisionPattern.test(match[1]!) || !identityAt(join(dir.path, name))?.isDirectory()) {
        throw new Error('Invalid council store revision receipt');
      }
      if (revisionGeneration(match[1]!) > generation) {
        throw new Error('Council store manifest checkpoint is older than a committed meeting revision receipt');
      }
    });
  }

  private revisionReceipt(dir: StoreDirectory, name: string) {
    return this.receipt(dir, '.revision-receipt.' + entryName(name) + '.', /^([0-9a-f]{64})$/);
  }

  readRevision<T>(dir: StoreDirectory, name: string, allowPending: boolean, digest?: string): T {
    const receipt = this.revisionReceipt(dir, name);
    if (receipt || digest !== undefined) {
      // When fallback recovery finishes a v1 pending revision, its receipt
      // supplies the digest that the original checkpoint format lacked.
      if (allowPending) digest ??= receipt?.digest;
      if (digest === undefined || !digestPattern.test(digest) || (receipt && receipt.digest !== digest)) {
        throw new Error('Council store meeting revision receipt disagrees with its checkpoint');
      }
      const final = this.verifiedBytes(dir, name, 'meeting revision', digest);
      if (final === undefined && !receipt && identityAt(join(dir.path, name))) {
        throw new Error('Unexplained council store final meeting revision');
      }
      const bytes = final ??
        (allowPending ? this.verifiedBytes(dir, name + '.pending', 'meeting revision', digest) : undefined);
      if (bytes === undefined) throw new Error('Council store meeting revision contents disagree with its checkpoint');
      return JSON.parse(bytes) as T;
    }
    const pending = allowPending && !identityAt(join(dir.path, name));
    return JSON.parse(this.readBytes(dir, pending ? name + '.pending' : name, 'meeting revision', allowPending)) as T;
  }

  publishRevision(dir: StoreDirectory, name: string, digest: string | undefined, authorize: () => void): void {
    if (digest !== undefined) {
      this.publishVerifiedRevision(dir, name, digest, authorize);
      return;
    }
    const pendingName = name + '.pending';
    const pending = join(dir.path, pendingName);
    const identity = identityAt(pending);
    if (!identity) return;
    const path = join(dir.path, name);
    const existing = identityAt(path);
    const relative = join(dir.relative, name);
    const pendingRelative = join(dir.relative, pendingName);
    const receipt = this.revisionReceipt(dir, name);
    if (receipt) {
      this.publishVerifiedRevision(dir, name, receipt.digest, authorize);
      return;
    }
    const dependency = this.dependencies.get(existing ? relative : pendingRelative);
    if (dependency?.digest === undefined || (existing && !sameIdentity(existing, identity))) {
      throw new Error('Council store meeting revision changed during publication');
    }
    this.checkEntry(dependency, identity);
    if (!this.contentsMatch(pending, dependency)) {
      if (!existing && !identityAt(path)) {
        // The checkpoint can already be durable. Keep the rejected bytes
        // outside the active pending name so recovery cannot publish them.
        this.checkEntry(dependency, identityAt(pending));
        renameSync(pending, pending + '.' + randomUUID() + '.invalid');
        fsyncSync(dir.fd);
      }
      throw new Error('Council store meeting revision contents changed during publication');
    }
    if (!existing && this.noLink) {
      this.publishVerifiedRevision(dir, name, dependency.digest, authorize);
      return;
    } else if (!existing) {
      linkSync(pending, path);
    }
    // The final name proves this revision's generation was committed.
    // Keep the recoverable pending name until the link is durable.
    fsyncSync(dir.fd);
    unlinkSync(pending);
    const actual = identityAt(path);
    if (!actual || !sameIdentity(identity, actual)) {
      throw new Error('Council store meeting revision changed during publication');
    }
    this.dependencies.delete(pendingRelative);
    this.dependencies.set(relative, { ...dependency, identity: actual });
  }

  private publishVerifiedRevision(dir: StoreDirectory, name: string, digest: string, authorize: () => void): void {
    const receipt = this.revisionReceipt(dir, name);
    if (receipt && receipt.digest !== digest) throw new Error('Council store meeting revision receipt disagrees');
    const pendingName = name + '.pending';
    const pendingRelative = join(dir.relative, pendingName);
    const pending = join(dir.path, pendingName);
    const final = this.verifiedBytes(dir, name, 'meeting revision', digest);
    const identity = identityAt(pending);
    if (identity || receipt) this.requireCopySupport();
    if (final === undefined) {
      if (!identity || this.verifiedBytes(dir, pendingName, 'meeting revision', digest) === undefined) {
        throw new Error('Council store meeting revision contents changed during publication');
      }
      const fd = openRegular(pending);
      try {
        verifiedFile(fd, pending, identity, digest);
        fsyncSync(fd);
        fsyncSync(dir.fd);
        verifiedFile(fd, pending, identity, digest);
      } finally {
        closeSync(fd);
      }
      if (!receipt) {
        // An occupied final without a receipt cannot be attributed to an
        // interrupted exclusive copy.
        if (identityAt(join(dir.path, name))) throw new Error('Unexplained council store final meeting revision');
        this.seal(dir, '.revision-receipt.' + name + '.' + digest, 'revision receipt');
      } else {
        this.quarantine(dir, name, digest, 'meeting revision', authorize);
      }
      this.copy(dir, name, pending, identity, digest, 'meeting revision');
    } else if (identity && !receipt) {
      throw new Error('Unexplained council store final meeting revision');
    }
    if (identity) {
      const fd = openRegular(pending);
      try {
        verifiedFile(fd, pending, identity, digest);
        if (this.verifiedBytes(dir, name, 'meeting revision', digest) === undefined) {
          throw new Error('Council store final meeting revision changed during publication');
        }
        this.syncTrackedCopy(dir, name, digest);
        verifiedFile(fd, pending, identity, digest);
        unlinkSync(pending);
        fsyncSync(dir.fd);
        this.dependencies.delete(pendingRelative);
      } finally {
        closeSync(fd);
      }
    }
    const completed = this.revisionReceipt(dir, name);
    if (completed) {
      if (completed.digest !== digest || !sameIdentity(completed.identity, identityAt(join(dir.path, completed.name)))) {
        throw new Error('Council store revision receipt changed during publication');
      }
      rmdirSync(join(dir.path, completed.name));
      fsyncSync(dir.fd);
      this.dependencies.delete(join(dir.relative, completed.name));
    }
  }

  hasUnexpectedPresenceAnchor(enrollingDirectory?: string, legacy = false): boolean {
    const names = readdirSync(this.root.path).filter(name => name.startsWith('.presence.'));
    const allowed = enrollingDirectory === undefined ? undefined : '.presence.' + enrollingDirectory;
    const presence = identityAt(join(this.root.path, '.presence'));
    const witness = allowed ? identityAt(join(this.root.path, allowed)) : undefined;
    return names.some(name => name !== allowed) || (legacy ?
      (presence?.nlink ?? 0n) > BigInt(1 + names.length) :
      (presence !== undefined && (!presence.isFile() || presence.nlink !== 1n)) ||
      (witness !== undefined && (!witness.isFile() || witness.nlink !== 1n || sameIdentity(presence, witness))));
  }

  private checkpointSeal(generation: number) {
    return this.receipt(this.root, `.commit-seal.${generation}.`,
      /^([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  }

  checkpointGeneration(): number {
    const candidates = new Map<number, string[]>();
    for (const name of readdirSync(this.root.path)) {
      const match = /^\.(?:checkpoint|commit|commit-proof)\.([1-9]\d*)\.json$/.exec(name) ??
        /^\.commit-seal\.([1-9]\d*)\./.exec(name);
      if (!match) continue;
      const candidate = Number(match[1]);
      if (!Number.isSafeInteger(candidate)) {
        if (name.startsWith('.commit-seal.')) continue;
        throw new Error('Invalid council store manifest checkpoint generation');
      }
      const names = candidates.get(candidate) ?? [];
      names.push(name);
      candidates.set(candidate, names);
    }
    // Discovery must not track dependencies on evidence it may discard.
    const discovery = new StoreFiles(this.root.fd);
    for (const generation of [...candidates.keys()].sort((a, b) => b - a)) {
      const names = candidates.get(generation)!;
      if (names.some(name => name.startsWith('.commit-proof.'))) return generation;
      if (names.some(name => name.startsWith('.commit-seal.'))) {
        try {
          const seal = discovery.checkpointSeal(generation);
          if (seal && discovery.readSealedProof(seal, generation) !== undefined) return generation;
        } catch {
          // Invalid sealed evidence cannot advance discovery.
        }
      }
      for (const name of names) {
        if (name.startsWith('.commit-seal.')) continue;
        const fd = openRegular(join(this.root.path, name));
        try {
          if (!this.isSealedManifest(readFileSync(fd, 'utf8'))) return generation;
        } finally {
          closeSync(fd);
        }
      }
    }
    return 0;
  }

  private isSealedManifest(bytes: string): boolean {
    try {
      return (JSON.parse(bytes) as { proofScheme?: unknown } | null)?.proofScheme === 'sealed';
    } catch {
      // Malformed evidence is still selected and fails closed during read.
      return false;
    }
  }

  private readSealedProof(seal: NonNullable<ReturnType<StoreFiles['checkpointSeal']>>,
    generation: number): string | undefined {
    const bytes = this.inDirectory(this.root, '.proof-attempt.' + seal.attempt, dir =>
      this.verifiedBytes(dir, 'proof.json', 'manifest commit proof', seal.digest));
    if (bytes === undefined) return;
    try {
      const proof = JSON.parse(bytes) as { generation?: unknown } | null;
      if (Number.isSafeInteger(proof?.generation) && proof?.generation === generation) return bytes;
    } catch {
      // Invalid JSON cannot establish the proof's generation.
    }
    throw new Error('Council store sealed manifest commit proof has an invalid generation');
  }

  readCheckpoint(generation: number): string {
    const seal = this.checkpointSeal(generation);
    if (seal) {
      const bytes = this.readSealedProof(seal, generation);
      if (bytes === undefined) throw new Error('Council store sealed manifest commit proof is damaged');
      if (identityAt(join(this.root.path, this.proofName(generation))) &&
          this.readBytes(this.root, this.proofName(generation), 'legacy manifest commit proof', true) !== bytes) {
        throw new Error('Council store manifest checkpoint disagrees with its commit evidence');
      }
      return bytes;
    }
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
    if (this.isSealedManifest(bytes)) throw new Error('Council store manifest commit seal is missing');
    return bytes;
  }

  ensureCheckpointArtifacts(generation: number, bytes: string, authorize: () => void, recovering = false): void {
    const seal = this.checkpointSeal(generation);
    if (seal || this.noLink) {
      // Check the legacy evidence before making the seal authoritative.
      if (this.readCheckpoint(generation) !== bytes) throw new Error('Council store manifest checkpoint changed');
      if (!seal) {
        if ([this.checkpointName(generation), this.commitName(generation), this.proofName(generation)]
          .every(name => this.dependencies.has(name))) return;
        this.publishSealedProof(generation, bytes, () => {
          authorize();
          this.check();
          if (this.readCheckpoint(generation) !== bytes) throw new Error('Council store manifest checkpoint changed');
        });
      }
      this.copyCheckpointSiblings(generation, bytes, () => {
        authorize();
        if (this.readCheckpoint(generation) !== bytes) throw new Error('Council store manifest checkpoint changed');
      }, recovering);
      return;
    }
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
    if (!actual || !sameIdentity(identity, actual) ||
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
    if (this.noLink) {
      this.publishSealedProof(generation, bytes, check, linked);
      this.copyCheckpointSiblings(generation, bytes);
      return;
    }
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
    if (!actual || !sameIdentity(staged.identity, actual) ||
        this.readCheckpoint(generation) !== bytes) {
      throw new Error('Council store manifest checkpoint artifact changed during publication');
    }
  }

  private publishSealedProof(generation: number, bytes: string, check: () => void, visible?: () => void): void {
    this.requireCopySupport();
    const attempt = randomUUID();
    const directory = '.proof-attempt.' + attempt;
    const staged = stageFile(join(this.root.path, this.checkpointName(generation)), bytes);
    const digest = contentDigest(bytes);
    try {
      mkdirSync(join(this.root.path, directory), { mode: 0o700 });
      this.inDirectory(this.root, directory, dir =>
        this.copy(dir, 'proof.json', staged.path, staged.identity, digest, 'manifest commit proof'));
      fsyncSync(this.root.fd);
      check();
      if (this.checkpointSeal(generation)) throw new Error('Council store manifest commit seal already exists');
      this.seal(this.root, `.commit-seal.${generation}.${digest}.${attempt}`, 'manifest commit seal', visible);
      if (this.readCheckpoint(generation) !== bytes) throw new Error('Council store manifest commit proof changed');
    } finally {
      staged.close();
    }
  }

  private copyCheckpointSiblings(generation: number, bytes: string, repair?: () => void, recovering = false): void {
    const digest = contentDigest(bytes);
    const singleLink = this.isSealedManifest(bytes);
    for (const [name, label] of [
      [this.commitName(generation), 'manifest commit record'],
      [this.checkpointName(generation), 'manifest checkpoint'],
    ] as const) {
      if (repair && this.verifiedBytes(this.root, name, label, digest, { singleLink }) !== undefined) {
        if (!recovering) continue;
        const dependency = this.dependencies.get(name)!;
        const path = join(this.root.path, name);
        const fd = openRegular(path);
        try {
          if (!sameEntry(dependency.identity, statFd(fd))) throw new Error('Council store ' + label + ' identity changed');
          fsyncSync(fd);
          fsyncSync(this.root.fd);
          if (!this.contentsMatch(path, dependency)) throw new Error('Council store ' + label + ' contents changed');
        } finally {
          closeSync(fd);
        }
        continue;
      }
      this.requireCopySupport();
      if (repair) {
        repair();
        // A process can die immediately after creating the seal.
        fsyncSync(this.root.fd);
      }
      const staged = stageFile(join(this.root.path, name), bytes);
      try {
        if (repair) this.quarantine(this.root, name, digest, label, repair);
        this.copy(this.root, name, staged.path, staged.identity, digest, label);
      } finally {
        staged.close();
      }
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
    if (!actual || !sameIdentity(staged.identity, actual)) {
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
export type PresenceBinding = { directory: string; inode: string; token: string } &
  ({ scheme?: undefined; claim?: undefined } | { scheme: 'recorded'; claim: string });
export type DurableRecord = { manifest: string | null; presence: PresenceBinding };
export type DurableSnapshot = { record: DurableRecord; identity: EntryIdentity };
type JournalTarget = UndoRecord & { nonce: string; attempt: string; attemptDev: string; attemptIno: string };
type JournalUndo = Omit<UndoRecord, 'bytes'> & { nonce: string; targetDev: string; targetIno: string; digest: string };
type JournalFile = { path: string; identity: EntryIdentity; digest: string; bytes: string };
type PreparedTarget = { file: JournalFile; seal: string; identity: EntryIdentity };
type JournalV2 = { directory: string; identity: EntryIdentity; target: JournalFile; record: JournalTarget;
  armed: EntryIdentity | undefined; undo: EntryIdentity | undefined; undoPath: string; armedPath: string };

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
  private readonly targetV2Path: string;
  private readonly attemptPrefix: string;
  private readonly undoV2Name: string;
  private readonly durablePath: string;
  private readonly enrollmentPath: string;
  private readonly legacyPublicationPath: string;

  constructor(private readonly directory: string, directoryKey: string, private readonly directoryFd: number,
    private readonly files = new StoreFiles(directoryFd), private readonly checkDirectory = () => {}) {
    this.path = join(directory, 'manifest.json');
    this.initPath = join(directory, '.manifest-init.' + directoryKey);
    this.undoPath = join(directory, '.manifest-undo.' + directoryKey);
    this.targetPath = join(directory, '.manifest-target.' + directoryKey);
    this.targetV2Path = join(directory, '.manifest-target-v2.' + directoryKey);
    this.attemptPrefix = '.manifest-attempt-v2.' + directoryKey + '.';
    this.undoV2Name = '.manifest-undo-v2.' + directoryKey;
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
          typeof binding.token !== 'string' || !/^[0-9a-f-]{36}$/.test(binding.token) ||
          (binding.scheme === 'recorded' ? typeof binding.claim !== 'string' || !uuidPattern.test(binding.claim) :
            binding.scheme !== undefined || binding.claim !== undefined)) {
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

  replaceEnrollment(prior: DurableSnapshot, record: DurableRecord, check: () => void): DurableSnapshot {
    const old = prior.record.presence;
    const next = record.presence;
    if (old.scheme !== undefined || next.scheme !== 'recorded' || old.directory !== next.directory ||
        old.token !== next.token || old.inode.split(':').slice(0, 2).join(':') !== next.inode.split(':').slice(0, 2).join(':') ||
        prior.record.manifest !== record.manifest) {
      throw new Error('Invalid council store manifest enrollment transition');
    }
    return this.writeRecord(this.enrollmentPath, record, () => {
      check();
      this.checkDurable(undefined);
      this.checkEnrollment(prior);
      if (identityAt(join(this.directory, '.presence.' + old.directory))) {
        throw new Error('Council store presence identity changed');
      }
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
    if (!identity || !sameIdentity(snapshot.identity, identity)) {
      throw new Error('Council store manifest checkpoint record changed during transaction');
    }
    return { ...snapshot, identity };
  }

  validateBeforeLock(validate: (bytes: string | undefined) => unknown): void {
    const pendingWrite = () => identityAt(this.targetPath) || identityAt(this.undoPath) ||
      identityAt(this.targetV2Path) || identityAt(this.initPath);
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

  open(init?: ReturnType<ManifestFile['classifyInit']>) {
    if (init) return;
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
    if (this.files.noLink) return this.initializeExclusive();
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

  private initializeExclusive() {
    this.files.requireCopySupport();
    this.check(undefined);
    // An empty directory is the v2 intent for the one allowed value, null.
    // Its publication has no marker-content write window.
    mkdirSync(this.initPath, { mode: 0o700 });
    const marker = identityAt(this.initPath);
    if (!marker?.isDirectory()) throw new Error('Council store manifest initializer changed');
    this.checkInitMarker(marker);
    fsyncSync(this.directoryFd);
    this.checkInitMarker(marker);
    let fd: number;
    try {
      fd = openRegular(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      // This attempt knows it did not create the occupied manifest.
      this.removeInit(marker);
      throw new Error('Council store manifest identity changed during transaction');
    }
    try {
      const created = statFd(fd);
      this.check(created);
      writeFileSync(fd, 'null');
      fsyncSync(fd);
      fsyncSync(this.directoryFd);
      this.check(created);
      if (readFileSync(descriptorPath(fd), 'utf8') !== 'null') {
        throw new Error('Council store manifest contents changed during initialization');
      }
      this.removeInit(marker);
      const snapshot = this.open();
      if (!snapshot || !sameIdentity(created, snapshot.identity) || snapshot.bytes !== 'null') {
        if (snapshot) closeSync(snapshot.fd);
        throw new Error('Council store manifest identity changed during transaction');
      }
      return snapshot;
    } finally {
      closeSync(fd);
    }
  }

  private checkInitMarker(marker: EntryIdentity): void {
    if (marker.isDirectory()) {
      const fd = openSync(this.initPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if ((marker.mode & 0o777n) !== 0o700n || !sameIdentity(marker, statFd(fd)) ||
            readdirSync(descriptorPath(fd)).length !== 0 || !sameIdentity(marker, identityAt(this.initPath))) {
          throw new Error('Council store manifest initializer changed');
        }
      } finally {
        closeSync(fd);
      }
      return;
    }
    if (!marker.isFile()) throw new Error('Council store manifest initializer changed');
    const markerFd = openRegular(this.initPath);
    try {
      if (!sameEntry(marker, statFd(markerFd)) || readFileSync(markerFd, 'utf8') !== 'null' ||
          !sameEntry(marker, identityAt(this.initPath))) throw new Error('Council store manifest initializer changed');
    } finally {
      closeSync(markerFd);
    }
  }

  classifyInit(generation: number, durable: DurableSnapshot | undefined, enrollment?: DurableSnapshot, readOnly = false) {
    const marker = identityAt(this.initPath);
    if (!marker) return;
    this.checkInitMarker(marker);
    const live = identityAt(this.path);
    const alias = marker.isFile() && live !== undefined && sameIdentity(live, marker);
    if (marker.isFile() && marker.nlink !== (alias ? 2n : 1n)) throw new Error('Council store manifest initializer changed');
    const names = readdirSync(this.directory);
    const journals = names.some(name => /^\.manifest-(?:target|undo|attempt)(?:-v2)?\./.test(name));
    const armed = !alias && durable && (identityAt(this.targetPath) && identityAt(this.undoPath) ||
      identityAt(this.targetV2Path) && this.readJournalV2()?.armed);
    // Any armed journal must be validated independently of initialization.
    if (armed && !readOnly) return;
    if (generation !== 0 || journals || this.hasLegacyPublication() ||
        (durable && durable.record.manifest !== null) || (enrollment && enrollment.record.manifest !== null) ||
        (!durable && this.files.hasUnexpectedPresenceAnchor(enrollment?.record.presence.directory,
          enrollment !== undefined && enrollment.record.presence.scheme === undefined))) {
      throw new Error('Council store manifest initializer conflicts with checkpoint evidence');
    }
    const revisionConflict = () => {
      throw new Error('Council store manifest initializer conflicts with a meeting revision');
    };
    this.files.forEachMeetingRevision(revisionConflict, revisionConflict);
    if (!live) return { marker, live, alias };
    const fd = openRegular(this.path);
    try {
      if (!sameEntry(live, statFd(fd)) || live.nlink !== (alias ? 2n : 1n) ||
          !['', 'n', 'nu', 'nul', 'null'].includes(readFileSync(fd, 'utf8')) ||
          !sameEntry(live, identityAt(this.path))) {
        throw new Error('Council store manifest initializer conflicts with live manifest');
      }
    } finally {
      closeSync(fd);
    }
    return { marker, live, alias };
  }

  private removeInit(identity: EntryIdentity): void {
    this.checkInitMarker(identity);
    if (identity.isDirectory()) rmdirSync(this.initPath);
    else unlinkSync(this.initPath);
    fsyncSync(this.directoryFd);
  }

  check(identity: FileIdentity | undefined): void {
    const actual = identityAt(this.path);
    const links = actual && sameIdentity(actual, identityAt(this.targetPath)) ? 2n : 1n;
    if (!sameIdentity(actual, identity) || (actual !== undefined && (!actual.isFile() || actual.nlink !== links))) {
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
    updateRecord?: (current: NonNullable<ReturnType<ManifestFile['open']>>, verifyNonce?: () => void) => void,
    init?: ReturnType<ManifestFile['classifyInit']>): void {
    const marker = init?.marker ?? identityAt(this.initPath);
    if (marker && this.files.noLink) this.files.requireCopySupport();
    const target = identityAt(this.targetPath);
    const undo = identityAt(this.undoPath);
    let modern: JournalV2 | undefined;
    try {
      modern = this.readJournalV2();
    } catch (error) {
      if (target || undo || updateRecord || !durable || !this.recoverIncompleteTarget(durable, published, verify)) {
        throw error;
      }
    }
    if (modern && (target || undo)) throw new Error('Conflicting council store manifest journal formats');
    if (modern) this.recoverV2(modern, durable, published, verify, updateRecord);
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
    if (init) {
      this.checkDirectory();
      this.checkDurable(durable);
      const { marker, live, alias } = init;
      this.checkInitMarker(marker);
      if (live ? !sameEntry(live, identityAt(this.path)) : identityAt(this.path) !== undefined) {
        throw new Error('Council store manifest initializer changed before recovery');
      }
      if (live && !alias) {
        const fd = openRegular(this.path, constants.O_RDWR);
        try {
          const bytes = readFileSync(descriptorPath(fd), 'utf8');
          if (bytes !== 'null') {
            verify();
            this.checkInitMarker(marker);
            if (!['', 'n', 'nu', 'nul'].includes(bytes) || !sameEntry(live, statFd(fd)) ||
                !sameEntry(live, identityAt(this.path)) || statFd(fd).nlink !== 1n ||
                readFileSync(descriptorPath(fd), 'utf8') !== bytes) {
              throw new Error('Council store manifest initializer changed before recovery');
            }
            replaceContents(fd, 'null');
          } else {
            fsyncSync(fd);
          }
          this.check(live);
          fsyncSync(this.directoryFd);
        } finally {
          closeSync(fd);
        }
      }
      this.removeInit(marker);
    } else if (marker) {
      if (!target && !modern) throw new Error('Council store manifest initializer changed');
      this.removeInit(marker);
    }
  }

  private readJournalFile(path: string): JournalFile {
    const fd = openRegular(path);
    try {
      const identity = statFd(fd);
      const bytes = readFileSync(fd);
      const digest = contentDigest(bytes);
      verifiedFile(fd, path, identity, digest);
      return { path, identity, bytes: bytes.toString('utf8'), digest };
    } finally {
      closeSync(fd);
    }
  }

  private checkJournalFile(file: JournalFile): void {
    const fd = openRegular(file.path);
    try {
      verifiedFile(fd, file.path, file.identity, file.digest);
    } finally {
      closeSync(fd);
    }
  }

  private parseJournalTarget(file: JournalFile): JournalTarget {
    const record = JSON.parse(file.bytes) as JournalTarget | null;
    if (!record || typeof record.bytes !== 'string' || !/^\d+$/.test(record.dev) || !/^\d+$/.test(record.ino) ||
        !uuidPattern.test(record.nonce) || !uuidPattern.test(record.attempt) ||
        !/^\d+$/.test(record.attemptDev) || !/^\d+$/.test(record.attemptIno)) {
      throw new Error('Invalid council store manifest journal target');
    }
    return record;
  }

  private preparedTarget(directory: string): PreparedTarget | undefined {
    const seals = readdirSync(directory).filter(name => name.startsWith('.target-ready.'));
    if (!seals.length) return;
    const name = seals[0]!;
    const digest = name.slice('.target-ready.'.length);
    const seal = join(directory, name);
    const identity = identityAt(seal);
    if (seals.length !== 1 || !digestPattern.test(digest) || !identity?.isDirectory() ||
        (identity.mode & 0o777n) !== 0o700n) throw new Error('Invalid council store journal target seal');
    const file = this.readJournalFile(join(directory, 'manifest.json.' + digest + '.tmp'));
    if (file.digest !== digest) throw new Error('Council store journal target stage contents changed');
    return { file, seal, identity };
  }

  private removePreparedTarget(prepared: PreparedTarget, fd: number): void {
    this.checkJournalFile(prepared.file);
    if (!sameIdentity(prepared.identity, identityAt(prepared.seal))) {
      throw new Error('Council store journal target seal changed');
    }
    rmdirSync(prepared.seal);
    fsyncSync(fd);
    unlinkSync(prepared.file.path);
    fsyncSync(fd);
  }

  private recoverIncompleteTarget(durable: DurableSnapshot, published: string, verify: () => void): boolean {
    if (!identityAt(this.targetV2Path) || published !== (durable.record.manifest ?? 'null')) return false;
    const candidates: { prepared: PreparedTarget; directory: string; identity: EntryIdentity }[] = [];
    for (const name of readdirSync(this.directory)) {
      if (name === this.undoV2Name) return false;
      if (!name.startsWith(this.attemptPrefix)) continue;
      const directory = join(this.directory, name);
      const identity = identityAt(directory);
      if (!identity?.isDirectory() || (identity.mode & 0o777n) !== 0o700n ||
          identityAt(join(directory, 'armed')) || identityAt(join(directory, this.undoV2Name))) return false;
      const prepared = this.preparedTarget(directory);
      if (!prepared) continue;
      const record = this.parseJournalTarget(prepared.file);
      if (name !== this.attemptPrefix + record.attempt || String(identity.dev) !== record.attemptDev ||
          String(identity.ino) !== record.attemptIno || record.bytes !== published) return false;
      candidates.push({ prepared, directory, identity });
    }
    if (candidates.length !== 1) return false;
    const { prepared, directory, identity } = candidates[0]!;
    const current = this.open();
    if (!current) return false;
    let target: number | undefined;
    let fd: number | undefined;
    try {
      target = openRegular(this.targetV2Path);
      const own = statFd(target);
      const partial = readFileSync(target);
      const complete = Buffer.from(prepared.file.bytes);
      if (current.bytes !== published || partial.length >= complete.length ||
          !partial.equals(complete.subarray(0, partial.length))) return false;
      this.files.requireCopySupport();
      verify();
      this.checkDirectory();
      this.checkDurable(durable);
      this.checkContents(current);
      this.checkJournalFile(prepared.file);
      fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameIdentity(identity, statFd(fd)) || !sameIdentity(identity, identityAt(directory)) ||
          identityAt(join(directory, 'armed')) || identityAt(join(directory, this.undoV2Name)) ||
          !sameIdentity(prepared.identity, identityAt(prepared.seal))) return false;
      verifiedFile(target, this.targetV2Path, own, contentDigest(partial));
      renameSync(this.targetV2Path, this.targetV2Path + '.' + randomUUID() + '.invalid');
      fsyncSync(this.directoryFd);
      this.removePreparedTarget(prepared, fd);
      if (readdirSync(descriptorPath(fd)).length === 0 && sameIdentity(identity, identityAt(directory))) {
        rmdirSync(directory);
        fsyncSync(this.directoryFd);
      }
      return true;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (target !== undefined) closeSync(target);
      closeSync(current.fd);
    }
  }

  private readJournalV2(): JournalV2 | undefined {
    const targetIdentity = identityAt(this.targetV2Path);
    const target = targetIdentity && this.readJournalFile(this.targetV2Path);
    const record = target && this.parseJournalTarget(target);
    if (target && !sameEntry(targetIdentity!, target.identity)) throw new Error('Invalid council store manifest journal target');
    const expected = record && this.attemptPrefix + record.attempt;
    for (const name of readdirSync(this.directory)) {
      if (name === this.undoV2Name) throw new Error('Council store manifest journal undo has no attempt');
      if (!name.startsWith(this.attemptPrefix) || name === expected) continue;
      const path = join(this.directory, name);
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (identityAt(join(descriptorPath(fd), 'armed')) || identityAt(join(descriptorPath(fd), this.undoV2Name))) {
          throw new Error('Council store manifest journal undo has no target');
        }
      } finally {
        closeSync(fd);
      }
    }
    if (!record || !target) return;
    const directory = join(this.directory, expected!);
    const identity = identityAt(directory);
    if (!identity?.isDirectory() || (identity.mode & 0o777n) !== 0o700n ||
        String(identity.dev) !== record.attemptDev || String(identity.ino) !== record.attemptIno) {
      throw new Error('Council store manifest journal attempt identity changed');
    }
    const undoPath = join(directory, this.undoV2Name);
    const armedPath = join(directory, 'armed');
    const undo = identityAt(undoPath);
    const armed = identityAt(armedPath);
    if ((armed && (!armed.isFile() || armed.nlink !== 1n || armed.size !== 0n || !undo)) ||
        (undo && (!undo.isFile() || undo.nlink !== 1n))) {
      throw new Error('Council store manifest journal cannot recover its checkpoint');
    }
    return { directory, identity, target, record, armed, undo, undoPath, armedPath };
  }

  private journalUndo(journal: JournalV2): JournalFile {
    const undo = this.readJournalFile(journal.undoPath);
    const binding = JSON.parse(undo.bytes) as JournalUndo | null;
    const { target, record } = journal;
    if (!journal.undo || !sameEntry(journal.undo, undo.identity) || !binding ||
        binding.dev !== record.dev || binding.ino !== record.ino || binding.nonce !== record.nonce ||
        binding.targetDev !== String(target.identity.dev) || binding.targetIno !== String(target.identity.ino) ||
        binding.digest !== target.digest) {
      throw new Error('Council store manifest journal target changed before recovery');
    }
    return undo;
  }

  private checkJournal(journal: JournalV2, undo?: JournalFile): void {
    this.checkDirectory();
    this.checkJournalFile(journal.target);
    const armed = identityAt(journal.armedPath);
    const currentUndo = identityAt(journal.undoPath);
    if (!sameIdentity(journal.identity, identityAt(journal.directory)) ||
        !sameIdentity(journal.armed, armed) || (armed && (armed.nlink !== 1n || armed.size !== 0n || !armed.isFile())) ||
        !sameIdentity(journal.undo, currentUndo) || (currentUndo && (!currentUndo.isFile() || currentUndo.nlink !== 1n)) ||
        (journal.undo && !sameEntry(journal.undo, currentUndo))) {
      throw new Error('Council store manifest journal identity changed during transaction');
    }
    if (undo) this.checkJournalFile(undo);
  }

  private removeJournal(journal: JournalV2, undo?: JournalFile): void {
    const fd = openSync(journal.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(journal.identity, statFd(fd))) throw new Error('Council store manifest journal attempt changed');
      this.checkJournal(journal, undo);
      if (journal.armed) {
        unlinkSync(journal.armedPath);
        fsyncSync(fd);
        journal.armed = undefined;
      }
      this.checkJournal(journal, undo);
      if (journal.undo) {
        unlinkSync(journal.undoPath);
        fsyncSync(fd);
        journal.undo = undefined;
      }
      this.checkJournal(journal);
      const prepared = this.preparedTarget(journal.directory);
      if (prepared) {
        if (prepared.file.digest !== journal.target.digest) throw new Error('Council store journal target stage changed');
        this.removePreparedTarget(prepared, fd);
      }
      unlinkSync(journal.target.path);
      fsyncSync(this.directoryFd);
      if (readdirSync(descriptorPath(fd)).length === 0 && sameIdentity(journal.identity, identityAt(journal.directory))) {
        rmdirSync(journal.directory);
        fsyncSync(this.directoryFd);
      }
    } finally {
      closeSync(fd);
    }
  }

  private manifestNonce(fd: number, snapshot: NonNullable<ReturnType<ManifestFile['open']>>, bytes: string,
    install?: string): string | undefined {
    return identityNonce(fd, () => {
      this.checkDirectory();
      const identity = statFd(fd);
      if (!identity.isFile() || identity.nlink !== 1n || !sameIdentity(identity, snapshot.identity)) {
        throw new Error('Council store manifest identity changed during transaction');
      }
      this.checkContents(snapshot, bytes);
      if (readFileSync(descriptorPath(fd), 'utf8') !== bytes || !sameEntry(identity, statFd(fd))) {
        throw new Error('Council store manifest contents changed during transaction');
      }
      this.check(snapshot.identity);
    }, install);
  }

  private recoverV2(journal: JournalV2, durable: DurableSnapshot | undefined, published: string, verify: () => void,
    updateRecord: Parameters<ManifestFile['recover']>[3]): void {
    if (!durable || (updateRecord && (!journal.armed || journal.record.bytes !== (durable.record.manifest ?? 'null')))) {
      throw new Error('Council store manifest journal cannot recover its checkpoint');
    }
    const current = this.open();
    if (!current) throw new Error('Council store manifest disappeared before recovery');
    try {
      const undo = journal.armed ? this.journalUndo(journal) : undefined;
      this.checkJournal(journal, undo);
      this.checkDurable(durable);
      if (!journal.armed && current.bytes !== published) {
        throw new Error('Council store unarmed manifest journal cannot replace live contents');
      }
      this.files.requireCopySupport();
      const assertNonce = (bytes: string, fd = current.fd) => this.manifestNonce(fd, current, bytes) === journal.record.nonce &&
        String(current.identity.dev) === journal.record.dev && String(current.identity.ino) === journal.record.ino;
      const rewrote = current.bytes !== published;
      if (rewrote) {
        verify();
        this.checkDurable(durable);
        this.checkJournal(journal, undo);
        const fd = openSync(descriptorPath(current.fd), constants.O_RDWR);
        try {
          if (!assertNonce(current.bytes, fd)) {
            throw new Error('Council store manifest replacement disagrees with the committed checkpoint');
          }
          replaceContents(fd, published);
        } finally {
          closeSync(fd);
        }
      } else if (journal.armed) {
        // A replacement with checkpoint bytes stays in place, even when
        // its identity nonce is absent or differs from the original.
        assertNonce(current.bytes);
      }
      updateRecord?.({ ...current, bytes: published }, () => {
        this.checkJournal(journal, undo);
        if (rewrote && !assertNonce(published)) throw new Error('Council store manifest journal nonce changed');
      });
      this.checkContents(current, published);
      this.removeJournal(journal, undo);
    } finally {
      closeSync(current.fd);
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

  private publishV2(snapshot: NonNullable<ReturnType<ManifestFile['open']>>, previousDurable: DurableSnapshot,
    record: DurableRecord & { manifest: string }, publishCheckpoint: (check: () => void, linked: () => void) => void,
    check: (durable: DurableSnapshot, committed: boolean) => void, renamed?: () => void): DurableSnapshot {
    this.files.requireCopySupport();
    this.checkContents(snapshot);
    if (identityAt(this.targetPath) || identityAt(this.undoPath) || this.readJournalV2()) {
      throw new Error('Council store manifest journal already exists');
    }
    const fd = openSync(descriptorPath(snapshot.fd), constants.O_RDWR);
    const previous = snapshot.bytes;
    const bytes = record.manifest;
    let journal: JournalV2 | undefined;
    let undo: JournalFile | undefined;
    let committed = false;
    let dirty = false;
    try {
      let nonce = this.manifestNonce(fd, snapshot, previous);
      if (nonce === undefined) {
        nonce = randomUUID();
        this.manifestNonce(fd, snapshot, previous, nonce);
        if (this.manifestNonce(fd, snapshot, previous) !== nonce) {
          throw new Error('Council store manifest identity nonce changed');
        }
      }
      fsyncSync(fd);
      this.checkContents(snapshot);
      const attempt = randomUUID();
      const directory = join(this.directory, this.attemptPrefix + attempt);
      mkdirSync(directory, { mode: 0o700 });
      const attemptFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const identity = statFd(attemptFd);
        if (!sameIdentity(identity, identityAt(directory))) throw new Error('Council store manifest journal attempt changed');
        const data = {
          dev: String(snapshot.identity.dev), ino: String(snapshot.identity.ino), nonce, bytes: previous,
          attempt, attemptDev: String(identity.dev), attemptIno: String(identity.ino),
        };
        const targetBytes = JSON.stringify(data);
        const digest = contentDigest(targetBytes);
        const stage = join(directory, 'manifest.json.' + digest + '.tmp');
        const stageFd = openRegular(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          writeFileSync(stageFd, targetBytes);
          fsyncSync(stageFd);
        } finally {
          closeSync(stageFd);
        }
        mkdirSync(join(directory, '.target-ready.' + digest), { mode: 0o700 });
        fsyncSync(attemptFd);
        fsyncSync(this.directoryFd);
        const prepared = this.preparedTarget(directory)!;
        let target: JournalFile;
        try {
          const own = copyExclusive(stage, prepared.file.identity, this.targetV2Path, this.directoryFd, digest);
          target = { path: this.targetV2Path, identity: own, bytes: targetBytes, digest };
        } catch (error) {
          if (errno(error) === 'EEXIST') this.removePreparedTarget(prepared, attemptFd);
          throw error;
        }
        const undoPath = join(directory, this.undoV2Name);
        const armedPath = join(directory, 'armed');
        journal = { directory, identity, record: data, target, undo: undefined, armed: undefined, undoPath, armedPath };
        this.removePreparedTarget(prepared, attemptFd);
        const undoBytes = JSON.stringify({
          dev: data.dev, ino: data.ino, nonce, targetDev: String(target.identity.dev),
          targetIno: String(target.identity.ino), digest: target.digest,
        } satisfies JournalUndo);
        const stagedUndo = stageFile(undoPath, undoBytes);
        try {
          const digest = contentDigest(undoBytes);
          const own = copyExclusive(stagedUndo.path, stagedUndo.identity, undoPath, attemptFd, digest);
          undo = { path: undoPath, identity: own, digest, bytes: undoBytes };
          journal.undo = own;
        } finally {
          stagedUndo.close();
        }
        this.checkJournal(journal, undo);
        const armed = openRegular(armedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          journal.armed = statFd(armed);
          fsyncSync(armed);
          fsyncSync(attemptFd);
        } finally {
          closeSync(armed);
        }
      } finally {
        closeSync(attemptFd);
      }
      const verifyJournal = (expected: string) => {
        this.checkJournal(journal!, undo);
        if (this.manifestNonce(fd, snapshot, expected) !== nonce) {
          throw new Error('Council store manifest identity nonce changed');
        }
      };
      check(previousDurable, false);
      verifyJournal(previous);
      dirty = true;
      replaceContents(fd, bytes);
      publishCheckpoint(() => {
        check(previousDurable, false);
        verifyJournal(bytes);
      }, () => { committed = true; });
      const published = this.writeDurable(record, previousDurable, () => {
        check(previousDurable, true);
        verifyJournal(bytes);
      }, renamed);
      check(published, true);
      verifyJournal(bytes);
      this.removeJournal(journal, undo);
      return published;
    } catch (error) {
      if (!committed) {
        // Recovery evidence survives a failed rollback or cleanup sync.
        if (dirty) {
          replaceContents(fd, previous);
          if (readFileSync(descriptorPath(fd), 'utf8') !== previous) {
            throw new Error('Council store manifest rollback contents changed');
          }
          this.checkContents(snapshot);
        }
        if (journal) this.removeJournal(journal, undo);
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  publish(snapshot: NonNullable<ReturnType<ManifestFile['open']>>, previousDurable: DurableSnapshot,
    record: DurableRecord & { manifest: string }, publishCheckpoint: (check: () => void, linked: () => void) => void,
    check: (durable: DurableSnapshot, committed: boolean) => void, renamed?: () => void): DurableSnapshot {
    if (this.files.noLink) return this.publishV2(snapshot, previousDurable, record, publishCheckpoint, check, renamed);
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
