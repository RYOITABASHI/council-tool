import { readFileSync } from 'node:fs';

/** A clock sample in nanoseconds. Wall time is measured from the Unix epoch. */
export interface ClockSample {
  monotonic: bigint;
  wall: bigint;
}

export interface Clock {
  /** Identifies a shared monotonic origin. Required by cores using a transactional store. */
  epoch?: string;
  now(): ClockSample;
}

function bootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

const epoch = bootId();
export const systemClock: Clock = {
  ...(epoch === undefined ? {} : { epoch }),
  now: () => ({ monotonic: process.hrtime.bigint(), wall: BigInt(Date.now()) * 1_000_000n }),
};

export type Deadline = { kind: 'absolute'; at: string } | { kind: 'relative'; seconds: number };

/** The fractional tail preserves ISO precision finer than a clock tick. */
export interface Instant {
  ns: string;
  tail: string;
}

export const instant = (ns: bigint, tail = ''): Instant => ({ ns: String(ns), tail });
export const seconds = (value: number) => BigInt(value) * 1_000_000_000n;

export function compare(left: Instant, right: Instant): number {
  const delta = BigInt(left.ns) - BigInt(right.ns);
  if (delta !== 0n) return delta < 0n ? -1 : 1;
  return left.tail < right.tail ? -1 : left.tail > right.tail ? 1 : 0;
}

export function parseAbsolute(value: string): Instant | undefined {
  const parts = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || parts[0] !== value) return;
  const local = parts[1] + 'T' + parts[2];
  const localMs = Date.parse(local + 'Z');
  const epoch = Date.parse(local + parts[4]);
  if (!Number.isFinite(epoch) || !Number.isFinite(localMs) ||
      new Date(localMs).toISOString().slice(0, 19) !== local) return;
  const fraction = (parts[3] ?? '').padEnd(9, '0');
  return instant(BigInt(epoch) * 1_000_000n + BigInt(fraction.slice(0, 9)),
    fraction.slice(9).replace(/0+$/, ''));
}

export function packetTimestamp(ns: bigint): string {
  const ms = (ns >= 0n ? ns : ns - 999_999n) / 1_000_000n;
  return new Date(Number(ms)).toISOString();
}

export function iso(ns: bigint): string {
  const second = (ns >= 0n ? ns : ns - 999_999_999n) / 1_000_000_000n;
  const fractional = (ns - second * 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  const fraction = '.' + fractional.padEnd(3, '0') + 'Z';
  const ms = second * 1000n;
  if (ms >= -8_640_000_000_000_000n && ms <= 8_640_000_000_000_000n) {
    return new Date(Number(ms)).toISOString().replace(/\.000Z$/, fraction);
  }
  // Relative periods have no upper bound. Gregorian dates repeat every 400 years.
  const cycle = 146_097n * 86_400n;
  const base = new Date(Number((second % cycle) * 1000n)).toISOString();
  const year = BigInt(base.slice(0, 4)) + (second / cycle) * 400n;
  const expanded = (year < 0n ? '-' : '+') + (year < 0n ? -year : year).toString().padStart(6, '0');
  return expanded + base.slice(4).replace(/\.000Z$/, fraction);
}
