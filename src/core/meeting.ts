import { randomUUID } from 'node:crypto';
import { packetSha } from '../packet/index.js';
import type { HashablePacketHeader, Packet, PacketBodies, PacketHashInput, PacketKind } from '../packet/index.js';
import { compare, instant, iso, packetTimestamp, parseAbsolute, seconds } from './clock.js';
import type { ClockSample, Deadline, Instant } from './clock.js';
import { answer } from './model.js';
import type { Meeting, Missing, ReceptionRow, RoundRecord, StoredPacket } from './model.js';
import type { Round, StoredSeatConfig } from './types.js';
import { blank, fail, requireArgument } from './validation.js';

export const currentRound = (m: Meeting) => m.rounds.at(-1);
export const findRound = (m: Meeting, round: Round | null) => m.rounds.find(r => r.state.round === round);
export const findPacket = (m: Meeting, id: string | null) => m.packets.find(p => p.packet.header.packet_id === id);
export const findSeat = (m: Pick<Meeting, 'setup'>, id: string | null) => m.setup.seats.find(s => s.seat_id === id);
export const findRow = (r: RoundRecord | undefined, id: string | null) => r?.rows.find(row => row.seat_id === id);
export const open = (m: Meeting, r: RoundRecord | undefined) => m.state === 'OPEN' && r !== undefined && r === currentRound(m);
export const pending = (row: ReceptionRow | undefined) =>
  row?.state === 'pending' || row?.state === 'transcribed_pending_attest';
export const initialReceptionRows = (setup: Meeting['setup'], round: Round): ReceptionRow[] =>
  setup.seats.map(({ seat_id }) => ({
    seat_id, round, state: 'pending', reason: null, current_packet_id: null, invalidated_packet_id: null,
  }));
export const bound = (seat: StoredSeatConfig | undefined, id: string) =>
  !!seat && (seat.principal === id || !!seat.driver_principals?.includes(id));
export function sameSeatBinding(before: StoredSeatConfig, after: StoredSeatConfig): boolean {
  const oldDrivers = new Set(before.driver_principals);
  const newDrivers = new Set(after.driver_principals);
  return before.principal === after.principal && oldDrivers.size === newDrivers.size &&
    [...oldDrivers].every(driver => newDrivers.has(driver));
}
export const anySeat = (m: Meeting, id: string) => m.setup.seats.some(s => bound(s, id));
export const policy = (s: StoredSeatConfig) => s.sharing_policy ?? 'share_with_confirmation';
export const ok = { status: 'ok' } as const;

export function audit(m: Meeting, when: ClockSample, operation: string, event: string, detail?: unknown): void {
  m.audit.push({ at: iso(when.wall), operation, event, ...(detail === undefined ? {} : { detail }) });
}

export function append<K extends PacketKind>(
  m: Meeting, now: ClockSample, kind: K, location: Pick<HashablePacketHeader<K>, 'round' | 'seat_id' | 'supersedes'>,
  body: PacketBodies[K], metadata: Partial<Omit<StoredPacket, 'packet'>> = {},
) {
  const header = { ...location, meeting_id: m.id, created_at: packetTimestamp(now.wall), kind };
  const packet_id = randomUUID();
  const packet_sha = packetSha({ header, body } as PacketHashInput);
  const packet = { header: { ...header, packet_id, packet_sha }, body };
  const previous = findPacket(m, location.supersedes);
  if (previous) {
    previous.version = 'superseded';
    if (answer(previous) && previous.reception !== 'invalidated') previous.reception = 'superseded';
  }
  m.packets.push({
    packet: packet as Packet, seq: m.packets.length + 1, version: 'current', verification: 'not_applicable', reception: 'not_applicable',
    missing: [], ...metadata,
  });
  return packet;
}

export function stateError(m: Meeting): never {
  return fail('invalid_state', { meeting_state: m.state });
}

export function receptionDetail(r: RoundRecord | undefined, row: ReceptionRow | undefined) {
  return { reception_state: row?.state ?? null, round_frozen: r?.state.phase === 'frozen' };
}

export function absence(row: ReceptionRow, fallback: 'chair_declared' | 'deadline_no_submission') {
  row.state = 'absent';
  row.reason = { code: row.invalidated_packet_id === null ? fallback : 'attest_mismatch', text: null };
}

export function missingFields(packet: StoredPacket): Missing[] {
  const claims = answer(packet)?.claims;
  if (!claims) return [];
  if (claims.length === 0) return ['claims'];
  return (['statement', 'reversal_condition'] as const).filter(field =>
    claims.some(claim => blank(claim[field])));
}

export function startTimeout(m: Meeting, at: bigint) {
  const created = BigInt(m.created);
  m.timeoutAt = String((at > created ? at : created) + seconds(m.setup.meeting_timeout));
}

export function requiredReceptionSeats(setup: Meeting['setup']): ReadonlySet<string> {
  return new Set(setup.seats.filter(seat => !seat.optional).map(seat => seat.seat_id));
}

export function receptionReadyToFreeze(rows: readonly ReceptionRow[], required: ReadonlySet<string>): boolean {
  return !rows.some(row => required.has(row.seat_id) && pending(row));
}

export function frozenReceptionSummary(m: Pick<Meeting, 'setup'>, r: RoundRecord): RoundRecord['summary'] {
  const required = requiredReceptionSeats(m.setup);
  if (!receptionReadyToFreeze(r.rows, required)) return null;
  return {
    total: r.rows.length,
    received: r.rows.filter(row => row.state === 'received').length,
    absent: r.rows.filter(row => row.state === 'absent' || row.state === 'pending').length,
    waived: r.rows.filter(row => row.state === 'waived').length,
    quorum_met: r.state.quorum === null ? null :
      r.rows.filter(row => required.has(row.seat_id) && row.state === 'received').length >= r.state.quorum,
  };
}

export function freeze(m: Meeting, r: RoundRecord, now: ClockSample, position: number) {
  const summary = frozenReceptionSummary(m, r);
  if (summary === null) return;
  r.state.phase = 'frozen';
  r.summary = summary;
  for (const row of r.rows) {
    const packet = findPacket(m, row.current_packet_id);
    if (row.state === 'received' && packet) packet.missing = missingFields(packet);
  }
  m.state = r.state.round === 'R2' ? 'SYNTHESIZING' : 'GATE';
  startTimeout(m, now.monotonic);
  m.timeoutOrder = position;
}

export function checkOverride(value: Deadline | undefined, now: ClockSample) {
  if (value?.kind === 'absolute') requireArgument(compare(parseAbsolute(value.at)!, instant(now.wall)) >= 0);
}

export function startRound(m: Meeting, round: Round, override: Deadline | undefined, now: ClockSample, position: number) {
  const settings = m.setup.round_settings[round];
  let config = override ?? settings?.deadline;
  if (!override && config?.kind === 'absolute' && compare(parseAbsolute(config.at)!, instant(now.wall)) <= 0) {
    audit(m, now, 'open_round', 'skipped_saved_deadline', { round, deadline: config.at });
    config = null;
  }
  const previous = currentRound(m)?.relativeSeconds;
  if (!config && previous != null) config = { kind: 'relative', seconds: previous };
  let deadline: Instant | null = null;
  let deadline_at: string | null = null;
  if (config?.kind === 'relative') {
    deadline = instant(now.monotonic + seconds(config.seconds));
    deadline_at = iso(now.wall + seconds(config.seconds));
  } else if (config?.kind === 'absolute') {
    const wall = parseAbsolute(config.at)!;
    deadline = instant(BigInt(wall.ns) - now.wall + now.monotonic, wall.tail);
    deadline_at = config.at;
  }
  const r: RoundRecord = {
    state: { round, phase: 'open', opened_at: iso(now.wall), deadline_at, quorum: settings?.quorum ?? m.setup.quorum ?? null },
    deadline, relativeSeconds: config?.kind === 'relative' ? config.seconds : null, swept: false, sweepOrder: position,
    summary: null,
    rows: initialReceptionRows(m.setup, round),
  };
  m.rounds.push(r);
  m.state = 'OPEN';
  startTimeout(m, now.monotonic);
  m.timeoutOrder = position;
  freeze(m, r, now, position);
  return r.state;
}

export function frozenAnswer(m: Meeting, p: StoredPacket): boolean {
  if (!answer(p)) return false;
  const r = findRound(m, p.packet.header.round);
  const row = findRow(r, p.packet.header.seat_id);
  return r?.state.phase === 'frozen' && row?.state === 'received' &&
    row.current_packet_id === p.packet.header.packet_id;
}
