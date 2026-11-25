import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * One-shot first-run pairing (see pairing-design.md).
 *
 * The facade answers POST /pairing/claim only while "armed". Arming is
 * requested by the Fold launch scripts (COUNCIL_PAIRING_ARM=1) and is granted
 * only when no claimed record exists for the current token generation. A
 * successful claim disarms in memory before anything else happens and is
 * persisted to COUNCIL_HOME, so the same token is never handed out again —
 * not even across facade restarts or by a second facade sharing the home.
 * A new token (new generation) re-arms on the next launch.
 *
 * Records live in COUNCIL_HOME/pairing-claimed/, one file per claimed token
 * generation, named by the generation (a one-way, domain-separated
 * fingerprint) and created exclusively. Existence alone means "claimed": the
 * content is never trusted or even read, the token value is never stored,
 * and earlier generations stay claimed after a rotation.
 */

export const PAIRING_RECORD_DIR = 'pairing-claimed';
/** Single-file layout from an unreleased draft; its presence fails closed. */
export const LEGACY_PAIRING_RECORD_FILE = 'pairing-claimed.json';

export function tokenGeneration(token: string): string {
  return createHash('sha256').update('council-tool/pairing/v1\0').update(token).digest('hex');
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type ClaimedState = 'claimed' | 'unclaimed' | 'unknown';

/** lstat only: never opens the entry, so a FIFO or device cannot block startup. */
function claimedState(recordPath: string): ClaimedState {
  try {
    lstatSync(recordPath);
    return 'claimed';
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unclaimed' : 'unknown';
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return address === '::1';
}

/** A Host header naming this device by a loopback literal (port optional). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const match = /^(?:\[::1\]|localhost|127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])){3})(?::([0-9]{1,5}))?$/i.exec(host);
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65535);
}

/**
 * Whether a request may claim: it must arrive over loopback, address this
 * device by a loopback Host (defeats DNS rebinding from a browser on the same
 * device), and carry no browser cross-site markers (Origin / Sec-Fetch-Site).
 * A native app's HTTP client sends neither marker.
 */
export function isClaimRequestAllowed(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (!isLoopbackHostHeader(request.headers.host)) return false;
  if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) return false;
  return true;
}

export interface Pairing {
  /** Whether the facade currently answers POST /pairing/claim. */
  readonly armed: () => boolean;
  /**
   * Consume the arm. Returns true when this call won the one shot and the
   * claimed record was persisted; the caller may then send the token.
   * Returns false when not armed or when persisting failed (fail closed:
   * the arm is consumed either way, and the token is never sent unpersisted).
   */
  readonly claim: () => boolean;
}

export function createPairing(env: NodeJS.ProcessEnv, token: string): Pairing {
  const home = resolve(env.COUNCIL_HOME ?? join(homedir(), '.council-tool'));
  const recordDir = join(home, PAIRING_RECORD_DIR);
  const generation = tokenGeneration(token);
  const recordPath = join(recordDir, generation);
  // Any entry at the record path (whatever its type or content) and any
  // error other than "absent" fail closed: no arm, rather than risk a second
  // hand-out of an already claimed token.
  let armed = env.COUNCIL_PAIRING_ARM === '1' && claimedState(recordPath) === 'unclaimed' &&
    claimedState(join(home, LEGACY_PAIRING_RECORD_FILE)) === 'unclaimed';

  return {
    armed: () => armed,
    claim: () => {
      if (!armed) return false;
      // Disarm synchronously first: no concurrent request can win a second shot.
      armed = false;
      let fd: number | undefined;
      try {
        mkdirSync(recordDir, { recursive: true, mode: 0o700 });
        // Exclusive create is the cross-process one-shot: a second facade on
        // the same home loses here even if it was armed too.
        fd = openSync(recordPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeSync(fd, JSON.stringify({ claimed: true, token_generation: generation }) + '\n');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        // Persist the record's entry and the record directory's own entry in
        // COUNCIL_HOME before the token leaves, so a crash cannot drop the claim.
        for (const dir of [recordDir, home]) syncDirectory(dir);
        return true;
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* best effort */ }
        }
        // A partially written record still exists and keeps this generation
        // claimed (fail closed). No token material is logged, only the kind.
        console.error(`pairing: claim record could not be persisted (${(error as NodeJS.ErrnoException)?.code ?? 'error'}); pairing disarmed`);
        return false;
      }
    },
  };
}

/** The base URL the app should use afterwards, built from the bound address and port. */
export function pairingBaseUrl(bound: { address: string; port: number } | null, env: NodeJS.ProcessEnv): string {
  const configuredPort = Number(env.COUNCIL_HTTP_PORT || 8790);
  const port = bound?.port ?? configuredPort;
  let host = bound?.address ?? (env.COUNCIL_HTTP_HOST || '127.0.0.1');
  // A wildcard bind is reached from this device over loopback (claims only come from loopback).
  if (host === '0.0.0.0' || host === '::' || host === '' || host === '::ffff:0.0.0.0') host = '127.0.0.1';
  if (host.includes(':')) host = `[${host}]`;
  return `http://${host}:${port}`;
}
