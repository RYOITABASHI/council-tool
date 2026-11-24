import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compare, instant, seconds } from '../core/clock.js';
import {
  absence, bound, findRow, findSeat, frozenReceptionSummary, initialReceptionRows, missingFields, pending,
  receptionReadyToFreeze, requiredReceptionSeats, sameSeatBinding,
} from '../core/meeting.js';
import { answer } from '../core/model.js';
import type { Meeting, ReceptionRow, RoundRecord, StoredPacket } from '../core/model.js';
import { ERROR_CODES, ROUNDS } from '../core/types.js';
import type { Round } from '../core/types.js';
import { mergeSetup, record, validate } from '../core/validation.js';
import { inputPacketAllowed } from '../core/views.js';
import { bodySha } from '../packet/index.js';
import { contentDigest, copyExclusive, descriptorPath, identityAt, identityNonce, ManifestFile, openRegular,
  probeLinkCapability, revisionGeneration, sameEntry, sameIdentity, stageFile, StoreFiles } from './files.js';
import { legacyPositionsFit } from './legacy-positions.js';
import type { LegacyPositionCursor, LegacyPositionHistory, LegacyPositionStep } from './legacy-positions.js';
import type { DurableSnapshot, FileIdentity, PresenceBinding } from './files.js';

export interface Checkpoint {
  monotonic: string;
  position: number;
  offset: string;
  epoch?: string;
  wall: string;
  /** Authenticated human principals observed by cores without a host resolver. */
  humanPrincipals?: string[];
}

export const storePollIntervalMs = 250;

export interface Store {
  /** Forward the expected epoch when opening or loading a shared backend. */
  load(expectedEpoch?: string): { meetings: Meeting[]; checkpoint?: Checkpoint };
  /** Any path that locks a shared backend must validate its clock epoch before locking. */
  transaction?<T>(work: () => T): T;
  /** Whether the published snapshot has changed since the last load or commit. */
  hasChanges?(): boolean;
  /**
   * Publish the checkpoint even when there are no meeting revisions to write.
   * A store that opens a shared backend here must validate the epoch before locking.
   */
  commit(changed: readonly Meeting[], checkpoint: Checkpoint): void;
}

export function requireClockEpoch(epoch: unknown): asserts epoch is string {
  if (typeof epoch !== 'string' || epoch.length === 0) {
    throw new Error('Shared council store requires a monotonic clock epoch (non-empty string)');
  }
}

function matchClockEpoch(actual: unknown, expected: unknown): void {
  requireClockEpoch(actual);
  requireClockEpoch(expected);
  if (actual !== expected) throw new Error('Shared council store clock epochs do not match');
}

type StoreAccess = {
  epoch: string | undefined;
  presence: StorePresence;
  observeFileStore: (store: FileStore) => void;
};
let access: StoreAccess | undefined;

/** Keep the expected epoch across synchronous adapters that drop load arguments. */
export function withStoreAccess<T>(context: StoreAccess, work: () => T): T {
  const previous = access;
  access = context;
  try {
    return work();
  } finally {
    access = previous;
  }
}

type Manifest = {
  checkpoint: Checkpoint;
  meetings: Record<string, string>;
  presence?: string;
  generation?: number;
  revisionDigests?: Record<string, string>;
  proofScheme?: 'sealed';
};
type CommittedManifest = Manifest & { presence: string; generation: number };
type PacketRevision = Omit<StoredPacket, 'packet'> & { packet_id: string; packet_digest?: string };
type MeetingFile = Omit<Meeting, 'packets'> & {
  generation?: number;
  packets: PacketRevision[];
};
type ReadPacket = (id: string) => StoredPacket['packet'];

function historyAtOrBefore<T>(before: readonly T[], after: readonly T[]): boolean {
  return before.length <= after.length && before.every((entry, index) => isDeepStrictEqual(entry, after[index]));
}

function latestAgendaVersions(agendaIds: readonly string[], setupVersion: number): Map<string, number> {
  // Each agenda replacement needs its own setup update.
  return new Map(agendaIds.map((id, index) => [id, setupVersion - (agendaIds.length - 1 - index)]));
}

function legacyDeliveryAtOrBefore(older: MeetingFile, newer: MeetingFile, readPacket: ReadPacket): boolean {
  const setupUpdates = newer.setupVersion - older.setupVersion;
  const previousSeats = new Map(older.delivery.map(delivery => [delivery.seat_id, delivery]));
  const bySeat = new Map(newer.delivery.map(delivery => [delivery.seat_id, delivery]));
  if (setupUpdates === 0 && older.delivery.length !== newer.delivery.length) return false;
  for (const before of older.delivery) {
    const after = bySeat.get(before.seat_id);
    if (!after || after.epoch < before.epoch || after.epoch - before.epoch > setupUpdates) return false;
    const { epoch: oldEpoch, sent: oldSent, ack: oldAck, notices: oldNotices, ...oldSeatDelivery } = before;
    const { epoch, sent, ack, notices, ...seatDelivery } = after;
    if (!isDeepStrictEqual(oldSeatDelivery, seatDelivery)) return false;
    if (setupUpdates > 0) {
      const oldSeat = findSeat(older, before.seat_id);
      const newSeat = findSeat(newer, before.seat_id);
      if (!oldSeat || !newSeat) return false;
      const sameBinding = sameSeatBinding(oldSeat, newSeat);
      const resets = epoch - oldEpoch;
      // One reset requires a different binding. Two or more can return to the original binding.
      if ((resets === 0 && !sameBinding) || (resets === 1 && sameBinding)) return false;
    }
    if (epoch > oldEpoch) continue;
    // Within one epoch the writer keeps entries in first-seen order.
    if (!historyAtOrBefore(oldSent, sent) || !historyAtOrBefore(oldAck, ack) ||
        !historyAtOrBefore(oldNotices, notices)) return false;
  }
  const agendas = (revision: MeetingFile) => revision.packets.filter(({ packet_id }) =>
    readPacket(packet_id).header.kind === 'agenda').map(({ packet_id }) => packet_id);
  const oldAgendas = agendas(older);
  const newAgendas = agendas(newer);
  if (newAgendas.length - oldAgendas.length > setupUpdates) return false;
  const supersededAgendas = new Set(oldAgendas.slice(0, -1));
  const agendaVersions = latestAgendaVersions(newAgendas, newer.setupVersion);
  return newer.delivery.every(({ seat_id, epoch, sent, ack, notices }) => {
    const previous = previousSeats.get(seat_id);
    // Adding a seat starts its delivery at epoch 1.
    if (!previous && epoch > setupUpdates) return false;
    const sameEpoch = previous?.epoch === epoch;
    const newSent = sent.slice(sameEpoch ? previous.sent.length : 0);
    const newAck = ack.slice(sameEpoch ? previous.ack.length : 0);
    if (newSent.length === 0 && newAck.length === 0) return true;
    const earliestEpochVersion = older.setupVersion + epoch - (previous?.epoch ?? 0);
    const available = (id: string) => !supersededAgendas.has(id) &&
      earliestEpochVersion <= (agendaVersions.get(id) ?? newer.setupVersion);
    return newSent.every(available) && newAck.every(available) &&
      older.rounds.every(round => findRow(round, seat_id)?.state !== 'absent' || notices.includes(round.state.round));
  });
}

type LegacyReceptionChange = { seatIndex: number; row?: ReceptionRow; position?: number };
type LegacyPacketStep =
  | { kind: 'reception'; round: Round; change: LegacyReceptionChange }
  | { kind: 'agenda' | 'note' | 'gate_decision' | 'synthesis' };
type LegacyReplay = { packets: LegacyPacketStep[]; entries: StoredPacket[] };
type LegacyRevision = { revision: MeetingFile; replay: LegacyReplay };

function replayLegacyReceptionPacket(setup: Meeting['setup'], rows: ReceptionRow[],
  { packet_id, attest }: PacketRevision, packet: StoredPacket['packet'],
  packets: Map<string, PacketRevision>): LegacyReceptionChange | undefined {
  const { kind, seat_id, supersedes } = packet.header;
  if (kind === 'note' || (kind === 'flash' && seat_id === 'chair')) return { seatIndex: -1 };
  const seatIndex = rows.findIndex(entry => entry.seat_id === seat_id);
  const row = rows[seatIndex];
  if (!row || row.state === 'absent' || row.state === 'waived') return;
  const seat = findSeat({ setup }, seat_id)!;
  if (kind === 'flash') return seat.flash ? { seatIndex } : undefined;
  if (kind === 'attest') {
    if (!attest || row.state !== 'transcribed_pending_attest' || row.current_packet_id !== attest.target_packet_id) return;
    const target = packets.get(attest.target_packet_id);
    if (attest.result === 'confirmed') {
      row.state = 'received';
      if (target) {
        target.reception = 'received';
        target.verification = 'verified';
      }
    } else {
      if (target) target.reception = 'invalidated';
      row.current_packet_id = null;
      row.invalidated_packet_id = attest.target_packet_id;
      row.state = 'pending';
    }
  } else {
    if (supersedes !== (row.current_packet_id ?? row.invalidated_packet_id)) return;
    const previous = supersedes === null ? undefined : packets.get(supersedes);
    if (previous) {
      previous.version = 'superseded';
      if (previous.reception !== 'invalidated') previous.reception = 'superseded';
    }
    row.current_packet_id = packet_id;
    row.state = seat.connection === 'web' ? 'transcribed_pending_attest' : 'received';
  }
  return { seatIndex, row: { ...row }, ...(attest ? { position: attest.position } : {}) };
}

type LegacyAuditEvent = Meeting['audit'][number];
const chairDecision = (event?: LegacyAuditEvent) =>
  (event?.operation === 'declare_absent' && event.event === 'absent') ||
  (event?.operation === 'waive_seat' && event.event === 'waived');

function legacyChairDecisionsConsistent(revision: MeetingFile): boolean {
  const decided = new Set<ReceptionRow>();
  let lastRound = -1;
  for (const event of revision.audit) {
    if (!chairDecision(event)) continue;
    const detail = event.detail;
    if (!record(detail) || typeof detail.seat_id !== 'string') return false;
    const roundIndex = ROUNDS.indexOf(detail.round as Round);
    const row = findRow(revision.rounds[roundIndex], detail.seat_id);
    if (roundIndex < lastRound || !row || decided.has(row) || row.state !== event.event ||
        !isDeepStrictEqual(detail, { round: row.round, seat_id: row.seat_id, reason: row.reason }) ||
        (row.state === 'waived' && !legacyWaiverValid(revision.id, row))) return false;
    decided.add(row);
    lastRound = roundIndex;
  }
  return true;
}

type DeliveryProgress = { sent: number; ack: number; notices: number };
type LegacyProgress = Pick<RoundRecord, 'rows' | 'swept'> & {
  setupVersion: number;
  roundIndex: number;
  packetIndex: number;
  auditIndex: number;
  confirmationIndex: number;
  delivery: DeliveryProgress[];
  timeoutAt: string | null | undefined;
  terminal: boolean;
};

type LegacyTransition = Omit<LegacyPositionStep, 'next'> & { progress: LegacyProgress };

const skippedDeadline = (event?: LegacyAuditEvent) =>
  event?.operation === 'open_round' && event.event === 'skipped_saved_deadline';
const synthesisAudit = (event?: LegacyAuditEvent) => event?.operation === 'synthesize' &&
  (event.event === 'discarded_unverified_item' || event.event === 'discarded_declared_missing_record');
function ignoredAckDetail(event?: LegacyAuditEvent) {
  if (event?.operation !== 'get_packets' || event.event !== 'ignored_ack' || !record(event.detail)) return;
  const { packet_id, provided_epoch, call } = event.detail;
  if (typeof packet_id !== 'string' || typeof provided_epoch !== 'number' || !Number.isInteger(provided_epoch)) return;
  if (call === undefined) return { packet_id, provided_epoch };
  if (!record(call)) return;
  const { position, seat_id, delivery_epoch } = call;
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1 ||
      typeof seat_id !== 'string' || typeof delivery_epoch !== 'number' ||
      !Number.isInteger(delivery_epoch) || delivery_epoch < 1) return;
  return { packet_id, provided_epoch, call: { position, seat_id, delivery_epoch } };
}

function legacyReplaySegment({ revision, replay }: LegacyRevision, previous: MeetingFile | undefined,
  latestTick: bigint, reopenedBy: string | undefined) {
  const { rounds, confirmations, audit, delivery } = revision;
  const ignoredAcks = audit.map(ignoredAckDetail);
  const { packets, entries } = replay;
  const created = BigInt(revision.created);
  const timerLength = seconds(revision.setup.meeting_timeout);
  const active = previous?.rounds.at(-1);
  const required = requiredReceptionSeats(revision.setup);
  const ready = (rows: ReceptionRow[]) => receptionReadyToFreeze(rows, required);
  const noteAuthors = [revision.setup.chair.principal, revision.convener, ...revision.setup.human_participants];
  const seatedAuthor = revision.setup.seats.some(seat => noteAuthors.some(id => bound(seat, id)));
  const beforeSetup = previous?.setupVersion ?? 0;
  const epochs = delivery.map(target => {
    const before = previous?.delivery.find(d => d.seat_id === target.seat_id);
    return { before, earliest: beforeSetup + target.epoch - (before?.epoch ?? 0) };
  });
  const terminal = legacyTerminal(revision.state);
  const initial: LegacyProgress = {
    setupVersion: beforeSetup, roundIndex: (previous?.rounds.length ?? 0) - 1,
    packetIndex: previous?.packets.length ?? 0, auditIndex: previous?.audit.length ?? 0,
    confirmationIndex: previous?.confirmations.length ?? 0,
    rows: active?.rows ?? [], swept: active?.swept ?? false, timeoutAt: previous?.timeoutAt ?? null,
    terminal: previous !== undefined && legacyTerminal(previous.state),
    delivery: delivery.map(({ epoch }, index) => {
      const before = epochs[index].before;
      return before?.epoch === epoch ? { sent: before.sent.length, ack: before.ack.length, notices: before.notices.length } :
        { sent: 0, ack: 0, notices: 0 };
    }),
  };
  const agendasAfter = Array<number>(packets.length + 1).fill(0);
  for (let index = packets.length - 1; index >= 0; index--) {
    agendasAfter[index] = agendasAfter[index + 1] + Number(packets[index].kind === 'agenda');
  }
  const standaloneAuditCalls = Array<number>(audit.length + 1).fill(0);
  for (let index = audit.length - 1; index >= 0; index--) {
    const event = audit[index];
    // The remaining success audit rows can belong to a packet, an opening,
    // or a delivery call that emits several rows at once.
    standaloneAuditCalls[index] = standaloneAuditCalls[index + 1] +
      Number(timeoutSweep(event) || ERROR_CODES.some(code => code === event.event) || chairDecision(event));
  }
  const roundComplete = (state: LegacyProgress) => {
    const round = rounds[state.roundIndex];
    return !round || (round.swept === state.swept && isDeepStrictEqual(round.rows, state.rows));
  };
  const deliveryComplete = (progress: DeliveryProgress, seat: number) => {
    const target = delivery[seat];
    return progress.sent === target.sent.length && progress.ack === target.ack.length &&
      progress.notices === target.notices.length;
  };
  const complete = (state: LegacyProgress) => state.setupVersion === revision.setupVersion &&
    state.roundIndex === rounds.length - 1 && roundComplete(state) && state.packetIndex === packets.length &&
    state.auditIndex === audit.length && state.confirmationIndex === confirmations.length &&
    state.terminal === terminal && (state.timeoutAt === undefined ? revision.timeoutAt !== null :
      state.timeoutAt === revision.timeoutAt) && state.delivery.every(deliveryComplete);

  const deliveryMinimum = (state: LegacyProgress) => state.delivery.reduce((calls, progress, seat) => {
    if (deliveryComplete(progress, seat)) return calls;
    const { sent, ack } = delivery[seat];
    const alreadySent = new Set(sent.slice(0, progress.sent));
    // New ACKs can accompany delivery, but ACKing an unsent packet requires
    // one call to send it and a later call to record its acknowledgement.
    return calls + (ack.slice(progress.ack).some(id => !alreadySent.has(id)) ? 2 : 1);
  }, 0);
  const minimum = (state: LegacyProgress) =>
    // Agenda changes share their setup call. R2 opens in the gate call.
    revision.setupVersion - state.setupVersion - agendasAfter[state.packetIndex] +
    packets.length - state.packetIndex + Math.max(0, Math.min(2, rounds.length) - state.roundIndex - 1) +
    Number(terminal && !state.terminal) + confirmations.length - state.confirmationIndex +
    standaloneAuditCalls[state.auditIndex] + deliveryMinimum(state) +
    rounds.slice(Math.max(0, state.roundIndex)).filter((round, index) => round.swept &&
      !(index === 0 && state.swept)).length -
    Number(state.setupVersion === 0 && revision.reopens !== null);

  function* steps(state: LegacyProgress): Generator<LegacyTransition> {
    const event = audit[state.auditIndex];
    const confirmation = confirmations[state.confirmationIndex];
    const packet = packets[state.packetIndex];
    const round = rounds[state.roundIndex];
    const nextRound = rounds[state.roundIndex + 1];
    const isOpen = round !== undefined && !ready(state.rows);
    const packetIndex = state.packetIndex + 1;
    const transition = (changed: Partial<LegacyProgress>, placement?: Omit<LegacyPositionStep, 'next'>): LegacyTransition =>
      ({ progress: { ...state, ...changed }, ...placement });

    function* reception(changed: Partial<LegacyProgress>, fixed?: number, tick?: bigint): Generator<LegacyTransition> {
      const progress = { ...state, ...changed };
      const opened = progress.roundIndex !== state.roundIndex;
      const freezes = (opened || isOpen) && ready(progress.rows);
      const result = rounds[progress.roundIndex];
      if (freezes && (result.state.phase !== 'frozen' || !roundComplete(progress))) return;
      const freezeOrder = freezes && progress.roundIndex === rounds.length - 1 ? revision.timeoutOrder : undefined;
      if (fixed !== undefined && freezeOrder !== undefined && fixed !== freezeOrder) return;
      if (freezes && !opened) {
        // The surviving timer encodes the last freeze tick. A timer cleared
        // before publication still has to be scheduled by the freeze.
        progress.timeoutAt = freezeOrder !== undefined && revision.timeoutAt !== null ? revision.timeoutAt : undefined;
        if (progress.timeoutAt !== undefined) tick = BigInt(progress.timeoutAt) - timerLength;
      }
      const position = fixed ?? freezeOrder;
      yield transition(progress, { ...(position === undefined ? {} : { fixed: position }), ...(tick === undefined ? {} : { tick }) });
    }

    function* openRound(withPacket: boolean): Generator<LegacyTransition> {
      if (!nextRound || state.setupVersion !== revision.setupVersion || isOpen || !roundComplete(state)) return;
      const skipsDeadline = skippedDeadline(event) && record(event.detail) && event.detail.round === nextRound.state.round;
      const tick = nextRound.relativeSeconds !== null && nextRound.deadline !== null ?
        BigInt(nextRound.deadline.ns) - seconds(nextRound.relativeSeconds) :
        revision.timeoutOrder === nextRound.sweepOrder && revision.timeoutAt !== null ?
          BigInt(revision.timeoutAt) - timerLength : undefined;
      const timeoutAt = tick === undefined ? undefined : String(tick + timerLength);
      yield* reception({
        roundIndex: state.roundIndex + 1, rows: initialReceptionRows(revision.setup, nextRound.state.round),
        swept: false, timeoutAt, auditIndex: state.auditIndex + Number(skipsDeadline),
        packetIndex: state.packetIndex + Number(withPacket),
      }, nextRound.sweepOrder, tick);
    }

    if (!round && state.setupVersion < revision.setupVersion &&
        (confirmation === undefined || confirmation.setup_version > state.setupVersion)) {
      const setupVersion = state.setupVersion + 1;
      if (packet?.kind === 'agenda') {
        const creation = state.setupVersion === 0 ?
          { tick: created, ...(revision.reopens === null ? {} : { pairedMeeting: revision.reopens }) } : undefined;
        yield transition({ setupVersion, packetIndex }, creation);
      }
      if (state.setupVersion > 0 && revision.setupVersion - setupVersion >= agendasAfter[state.packetIndex]) {
        yield transition({ setupVersion });
      }
    }
    if (state.setupVersion === 0) return;

    if (state.roundIndex < 1) yield* openRound(false);
    if (!state.terminal && packet) {
      switch (packet.kind) {
        case 'note':
          if (!isOpen || seatedAuthor) yield transition({ packetIndex });
          break;
        case 'gate_decision':
          if (state.roundIndex !== 1 || isOpen || !roundComplete(state)) break;
          if (nextRound) yield* openRound(true);
          else yield transition({ packetIndex, timeoutAt: null });
          break;
        case 'synthesis': {
          if (nextRound || isOpen || !roundComplete(state)) break;
          let auditIndex = state.auditIndex;
          while (synthesisAudit(audit[auditIndex])) auditIndex++;
          yield transition({ packetIndex, auditIndex, timeoutAt: null });
          break;
        }
        case 'reception': {
          if (!isOpen || packet.round !== round.state.round) break;
          const { seatIndex, row, position } = packet.change;
          const before = state.rows[seatIndex];
          if (before?.state === 'absent' || before?.state === 'waived') break;
          const rows = state.rows.slice();
          if (row) {
            const updated = { ...row };
            if (state.swept && updated.state === 'pending') absence(updated, 'deadline_no_submission');
            if (updated.state === 'absent' && !isDeepStrictEqual(updated, round.rows[seatIndex])) break;
            rows[seatIndex] = updated;
          }
          yield* reception({ packetIndex, rows }, position);
          break;
        }
      }
    }

    if (confirmation?.setup_version === state.setupVersion) {
      yield transition({ confirmationIndex: state.confirmationIndex + 1 });
    }
    if (event) {
      const auditIndex = state.auditIndex + 1;
      if (timeoutSweep(event) && state.timeoutAt !== null &&
          (state.timeoutAt === undefined ? created + timerLength : BigInt(state.timeoutAt)) < latestTick) {
        yield transition({ auditIndex, timeoutAt: null });
      } else if (ERROR_CODES.some(code => code === event.event)) {
        // The failed action is rolled back and only its audit row is written.
        yield transition({ auditIndex });
      } else if (isOpen && chairDecision(event) &&
          record(event.detail) && event.detail.round === round.state.round) {
        const seat = state.rows.findIndex(row => record(event.detail) && row.seat_id === event.detail.seat_id);
        const before = state.rows[seat];
        if (pending(before)) {
          const row = { ...before };
          const target = round.rows[seat];
          if (event.event === 'waived') {
            row.state = 'waived';
            row.reason = target.reason;
          } else absence(row, 'chair_declared');
          if (isDeepStrictEqual(row, target)) {
            const rows = state.rows.slice();
            rows[seat] = row;
            yield* reception({ auditIndex, rows });
          }
        }
      }
    }

    if (isOpen && round.swept && !state.swept) {
      const rows = state.rows.map(before => {
        if (before.state !== 'pending') return before;
        const row = { ...before };
        absence(row, 'deadline_no_submission');
        return row;
      });
      if (rows.every((row, seat) => row.state !== 'absent' || isDeepStrictEqual(row, round.rows[seat]))) {
        yield* reception({ rows, swept: true });
      }
    }

    if (terminal && !state.terminal && state.packetIndex === packets.length && packets.some(p => p.kind === 'synthesis')) {
      yield transition({ terminal: true }, reopenedBy === undefined ? undefined : { pairedMeeting: reopenedBy });
    }

    const ignored = ignoredAcks[state.auditIndex];
    if (!state.delivery.every(deliveryComplete) || ignored) {
      // Replay get_packets against the visible packet/round prefix. A call
      // targets one seat, but can add ACKs, sends, notices and audit together.
      const call = ignored?.call;
      const providedEpoch = ignored?.provided_epoch;
      const placement = call && { fixed: call.position };
      let batchEnd = state.auditIndex;
      if (ignored) {
        do {
          batchEnd++;
        } while (audit[batchEnd]?.at === event.at && ignoredAcks[batchEnd]?.provided_epoch === providedEpoch &&
          isDeepStrictEqual(ignoredAcks[batchEnd]?.call, call));
      }
      const visible = entries.slice(0, state.packetIndex);
      const agenda = visible.map(({ packet }) => packet.header.kind).lastIndexOf('agenda');
      const meeting: Meeting = {
        ...revision, packets: visible.map((entry, index) => entry.packet.header.kind === 'agenda' ?
          { ...entry, version: index === agenda ? 'current' : 'superseded' } : entry),
        rounds: rounds.slice(0, state.roundIndex + 1).map((record, index) => index === state.roundIndex ?
          { ...record, rows: state.rows, state: { ...record.state, phase: isOpen ? 'open' : 'frozen' } } : record),
      };
      for (const [seat, target] of delivery.entries()) {
        const progress = state.delivery[seat];
        if (deliveryComplete(progress, seat) && !ignored) continue;
        const { before, earliest } = epochs[seat];
        // A later rebinding can erase the old epoch's delivery changes while
        // leaving its audit rows and position intact.
        const resetEpoch = call?.seat_id === target.seat_id && call.delivery_epoch < target.epoch &&
          call.delivery_epoch >= (before?.epoch ?? 1) &&
          state.setupVersion >= beforeSetup + call.delivery_epoch - (before?.epoch ?? 0) &&
          state.setupVersion <= revision.setupVersion - (target.epoch - call.delivery_epoch);
        if (!resetEpoch && state.setupVersion < earliest) continue;
        const authorized = meeting.packets.filter(entry => inputPacketAllowed(meeting, entry, target.seat_id));
        const allowed = new Set(authorized.map(({ packet }) => packet.header.packet_id));
        if (resetEpoch && (providedEpoch !== call.delivery_epoch || before?.epoch !== call.delivery_epoch ||
            ignoredAcks.slice(state.auditIndex, batchEnd).every(entry =>
              !allowed.has(entry!.packet_id) || !before.sent.includes(entry!.packet_id)))) {
          yield transition({ auditIndex: batchEnd }, placement);
        }
        if (state.setupVersion < earliest) continue;
        const sent = new Set(target.sent.slice(0, progress.sent));
        const canAck = (id: string) => sent.has(id) && allowed.has(id);
        let ack = progress.ack;
        while (ack < target.ack.length && canAck(target.ack[ack])) ack++;
        const notices = meeting.rounds.filter(r => findRow(r, target.seat_id)?.state === 'absent')
          .map(r => r.state.round);
        if (!historyAtOrBefore(notices, target.notices)) continue;

        const auditEnds = [state.auditIndex];
        if (!call || (call.seat_id === target.seat_id && call.delivery_epoch === target.epoch)) {
          for (let index = state.auditIndex; index < batchEnd; index++) {
            if (providedEpoch === target.epoch && canAck(ignoredAcks[index]!.packet_id)) break;
            // Older audit rows only identify candidate batches. A recorded
            // call must consume its entire batch at the recorded position.
            if (!call || index + 1 === batchEnd) auditEnds.push(index + 1);
          }
        }
        const sendEnds = new Set<number>();
        for (const filter of [undefined, ...ROUNDS]) {
          const added = authorized.flatMap(({ packet: { header } }) => !sent.has(header.packet_id) &&
            (filter === undefined || header.round === filter) ? [header.packet_id] : []);
          if (historyAtOrBefore(added, target.sent.slice(progress.sent))) sendEnds.add(progress.sent + added.length);
        }
        for (const end of auditEnds) {
          const consumesAudit = end !== state.auditIndex;
          const acknowledged = !consumesAudit || providedEpoch === target.epoch ? ack : progress.ack;
          for (const sentCount of sendEnds) {
            // The writer does not commit an input call that changed nothing.
            if (sentCount === progress.sent && acknowledged === progress.ack && notices.length === progress.notices &&
                !consumesAudit) continue;
            const delivery = state.delivery.slice();
            delivery[seat] = { sent: sentCount, ack: acknowledged, notices: notices.length };
            yield transition({ delivery, auditIndex: end }, consumesAudit ? placement : undefined);
          }
        }
      }
    }
  }
  return { initial, complete, minimum, steps };
}

function legacyReplayHistory(id: string, history: LegacyRevision[], latestTick: bigint,
  reopenedBy: string | undefined): LegacyPositionHistory {
  const anchors = new Set<number>();
  for (const event of history.at(-1)!.revision.audit) {
    const call = ignoredAckDetail(event)?.call;
    if (call) anchors.add(call.position);
  }
  const segments = history.map(({ revision, replay }, index) => {
    for (const round of revision.rounds) anchors.add(round.sweepOrder);
    if (revision.timeoutOrder !== 0) anchors.add(revision.timeoutOrder);
    for (const packet of revision.packets) if (packet.attest) anchors.add(packet.attest.position);
    return legacyReplaySegment({ revision, replay }, history[index - 1]?.revision, latestTick, reopenedBy);
  });
  const remaining = Array<number>(segments.length + 1).fill(0);
  for (let index = segments.length - 1; index >= 0; index--) {
    remaining[index] = remaining[index + 1] + segments[index].minimum(segments[index].initial);
  }
  const cursors = new Map<string, LegacyPositionCursor>();
  function cursor(index: number, progress: LegacyProgress): LegacyPositionCursor | undefined {
    while (segments[index].complete(progress)) {
      index++;
      if (index === segments.length) return;
      progress = segments[index].initial;
    }
    const segment = segments[index];
    const state = index + ':' + JSON.stringify(progress);
    const cached = cursors.get(state);
    if (cached) return cached;
    let steps: LegacyPositionStep[] | undefined;
    const current: LegacyPositionCursor = {
      key: cursors.size,
      minimum: segment.minimum(progress) + remaining[index + 1],
      steps: () => steps ??= [...segment.steps(progress)].map(({ progress, ...step }) =>
        ({ ...step, next: cursor(index, progress) })),
    };
    cursors.set(state, current);
    return current;
  }
  return { id, anchors, start: cursor(0, segments[0].initial)! };
}

function legacySharedPacketsConsistent(older: MeetingFile, newer: MeetingFile, readPacket: ReadPacket): boolean {
  const shared = new Map(older.packets.map(packet => [packet.packet_id, { ...packet }]));
  const active = older.rounds.at(-1);
  const rows = active?.state.phase === 'open' ? active.rows.map(row => ({ ...row })) : undefined;
  for (const entry of newer.packets.slice(older.packets.length)) {
    const packet = readPacket(entry.packet_id);
    const { kind, supersedes, round } = packet.header;
    if (older.state === 'AWAITING_APPROVAL' && kind !== 'note') return false;
    const previous = supersedes === null ? undefined : shared.get(supersedes);
    if (kind === 'agenda' && previous) {
      if (older.state !== 'CREATED' || older.setupVersion === newer.setupVersion ||
          readPacket(previous.packet_id).header.kind !== 'agenda' || previous.version !== 'current') return false;
      previous.version = 'superseded';
    }
    if (rows && kind !== 'gate_decision' && (round ?? entry.heldFor) === active!.state.round &&
        !replayLegacyReceptionPacket(older.setup, rows, entry, packet, shared)) return false;
  }
  if (rows) {
    const round = newer.rounds[older.rounds.length - 1];
    for (const row of round.rows) {
      const received = row.current_packet_id === null ? undefined : shared.get(row.current_packet_id);
      if (round.state.phase === 'frozen' && row.state === 'received' && received) {
        received.missing = missingFields({ ...received, packet: readPacket(received.packet_id) });
      }
    }
  }
  return older.packets.every(({ packet_id }, index) => isDeepStrictEqual(shared.get(packet_id), newer.packets[index]));
}

const legacyTerminal = (state: Meeting['state']) => state === 'APPROVED' || state === 'REJECTED';
const timeoutSweep = (event: Meeting['audit'][number]) =>
  event.operation === 'sweep' && event.event === 'timeout_exceeded';
const canScheduleTimeout = ({ state, rounds }: MeetingFile) => state === 'OPEN' || state === 'GATE' ||
  (state === 'SYNTHESIZING' && rounds.at(-1)?.state.round === 'R2');

function legacyRoundAtOrBefore(before: RoundRecord, after: RoundRecord): boolean {
  if (before.state.phase === 'frozen') return isDeepStrictEqual(before, after);
  const { rows, summary, swept, state: { phase, ...opened }, ...schedule } = before;
  const { rows: nextRows, summary: nextSummary, swept: nextSwept,
    state: { phase: nextPhase, ...nextOpened }, ...nextSchedule } = after;
  // Reception replay checks rows; revision validation checks the derived summary.
  return isDeepStrictEqual(opened, nextOpened) && isDeepStrictEqual(schedule, nextSchedule) && (!swept || nextSwept);
}

function legacyTimeoutAtOrBefore(older: MeetingFile, newer: MeetingFile): boolean {
  const expirations = newer.audit.slice(older.audit.length).filter(timeoutSweep).length;
  if (newer.timeoutOrder === older.timeoutOrder) {
    if (expirations > (older.timeoutAt === null ? 0 : 1)) return false;
    return newer.timeoutAt === (!canScheduleTimeout(newer) || expirations > 0 ? null : older.timeoutAt);
  }
  // Opening or freezing a round replaces the timer. It can then be cleared by
  // a sweep, a passing R1 gate, or synthesis before the next retained revision.
  if (newer.timeoutAt === null) return !canScheduleTimeout(newer) || expirations > 0;
  return older.timeoutAt === null || BigInt(newer.timeoutAt) >= BigInt(older.timeoutAt);
}

function legacySetupCanAdvance(older: Meeting['setup'], newer: Meeting['setup']): boolean {
  try {
    return isDeepStrictEqual(mergeSetup(newer, older), newer);
  } catch (error) {
    if (record(error) && error.code === 'invalid_argument') return false;
    throw error;
  }
}

function legacySetupAtOrBefore(older: MeetingFile, newer: MeetingFile): boolean {
  return older.setupVersion === newer.setupVersion ? isDeepStrictEqual(older.setup, newer.setup) :
    legacySetupCanAdvance(older.setup, newer.setup);
}

function legacyReopenConsistent(parent: MeetingFile, child: MeetingFile): boolean {
  if (!child.convenerHuman || !(child.convener === parent.convener || child.convener === parent.setup.chair.principal ||
      parent.setup.human_participants.includes(child.convener))) return false;
  return child.setupVersion === 1 ? isDeepStrictEqual(parent.setup, child.setup) :
    legacySetupCanAdvance(parent.setup, child.setup);
}

type LegacyRevisionRule = (older: MeetingFile, newer: MeetingFile, readPacket: ReadPacket) => boolean;

// Every persisted meeting field must agree with the same direction of history.
// Requiring a rule for every key makes a new model field a compile-time change here.
const legacyRevisionRules = {
  id: (a, b) => a.id === b.id,
  topic: (a, b) => a.topic === b.topic,
  convener: (a, b) => a.convener === b.convener,
  convenerHuman: (a, b) => a.convenerHuman === b.convenerHuman,
  reopens: (a, b) => a.reopens === b.reopens,
  created: (a, b) => a.created === b.created,
  generation: (a, b) => a.generation === undefined && b.generation === undefined,
  setupVersion: (a, b) => a.setupVersion <= b.setupVersion && (a.state === 'CREATED' || a.setupVersion === b.setupVersion),
  setup: legacySetupAtOrBefore,
  // Round order and the gate and synthesis packet prefixes establish the path to approval.
  state: (a, b) => legacyTerminal(a.state) ? a.state === b.state :
    a.state !== 'AWAITING_APPROVAL' || b.state === a.state || legacyTerminal(b.state),
  rejectionReason: (a, b) => a.state !== 'REJECTED' || a.rejectionReason === b.rejectionReason,
  timeoutOrder: (a, b) => {
    const before = a.rounds.at(-1)?.state;
    const after = b.rounds.at(-1)?.state;
    const restarted = before?.round !== after?.round || before?.phase !== after?.phase;
    return restarted ? a.timeoutOrder < b.timeoutOrder : a.timeoutOrder === b.timeoutOrder;
  },
  timeoutAt: legacyTimeoutAtOrBefore,
  timeoutExceeded: (a, b) => !a.timeoutExceeded || b.timeoutExceeded,
  rounds: (a, b) => a.rounds.length <= b.rounds.length &&
    (a.rounds.length === b.rounds.length || a.timeoutOrder < b.rounds[a.rounds.length].sweepOrder) &&
    a.rounds.every((round, index) => legacyRoundAtOrBefore(round, b.rounds[index])),
  audit: (a, b) => historyAtOrBefore(a.audit, b.audit),
  confirmations: (a, b) => historyAtOrBefore(a.confirmations, b.confirmations) &&
    b.confirmations.slice(a.confirmations.length).every(entry => entry.setup_version >= a.setupVersion),
  delivery: legacyDeliveryAtOrBefore,
  packets: (a, b) => a.packets.length <= b.packets.length &&
    (!legacyTerminal(a.state) || a.packets.length === b.packets.length) &&
    a.packets.every(({ packet_id }, index) => packet_id === b.packets[index].packet_id),
} satisfies Record<keyof MeetingFile, LegacyRevisionRule>;

function legacyRevisionFieldsKnown(revision: MeetingFile): boolean {
  return Object.keys(revision).every(key => Object.hasOwn(legacyRevisionRules, key)) &&
    Object.keys(legacyRevisionRules).every(key => key === 'generation' || key === 'rejectionReason' ||
      Object.hasOwn(revision, key));
}

function legacyStateMatches(revision: MeetingFile, readPacket: ReadPacket): boolean {
  const { rounds, state } = revision;
  const last = rounds.at(-1);
  let gate: 'pass' | 'fail' | undefined;
  let synthesized = false;
  for (const { packet_id } of revision.packets) {
    const packet = readPacket(packet_id);
    if (packet.header.kind === 'gate_decision') {
      if (gate || rounds[1]?.state.phase !== 'frozen' || !('result' in packet.body) ||
          (packet.body.result !== 'pass' && packet.body.result !== 'fail')) return false;
      gate = packet.body.result;
    }
    if (packet.header.kind === 'synthesis') {
      if (!gate || synthesized) return false;
      synthesized = true;
    }
  }
  if ((gate === 'fail') !== (rounds.length === 3)) return false;
  const readyForSynthesis = gate === 'pass' || (last?.state.round === 'R2' && last.state.phase === 'frozen');
  if (synthesized) return readyForSynthesis && (state === 'AWAITING_APPROVAL' || legacyTerminal(state));
  if (readyForSynthesis) return state === 'SYNTHESIZING';
  if (!last) return state === 'CREATED';
  return state === (last.state.phase === 'open' ? 'OPEN' : 'GATE');
}

function legacySetupConsistent(revision: MeetingFile): boolean {
  const { setup, setupVersion, confirmations, delivery } = revision;
  // Use the core's setup constraints for stored quotas, seat bindings, deadlines and quorum.
  try {
    validate('create_meeting', { ...setup, topic: revision.topic });
  } catch (error) {
    if (record(error) && error.code === 'invalid_argument') return false;
    throw error;
  }
  return Number.isInteger(setupVersion) && setupVersion >= 1 &&
    confirmations.every(entry => Number.isInteger(entry.setup_version) &&
      entry.setup_version >= 1 && entry.setup_version <= setupVersion) &&
    delivery.length === setup.seats.length && delivery.every(({ seat_id, epoch }, index) =>
      seat_id === setup.seats[index].seat_id && Number.isInteger(epoch) && epoch >= 1 && epoch <= setupVersion);
}

function legacyRoundsConsistent(revision: MeetingFile, latestTick: bigint): boolean {
  const { setup, rounds, setupVersion, timeoutAt } = revision;
  // When the last frozen round's timer survives, it records when the freeze occurred.
  const freezeTick = rounds.at(-1)?.state.phase === 'frozen' && timeoutAt !== null ?
    BigInt(timeoutAt) - seconds(setup.meeting_timeout) : latestTick;
  return rounds.every((round, index) => {
    const { state, rows, deadline, relativeSeconds, swept, sweepOrder } = round;
    const previous = rounds[index - 1];
    const sweepCutoff = index === rounds.length - 1 ? freezeTick : latestTick;
    if (state.round !== ROUNDS[index] || !Number.isSafeInteger(sweepOrder) || sweepOrder <= setupVersion || (previous &&
        (previous.state.phase !== 'frozen' || previous.sweepOrder >= sweepOrder)) ||
        state.quorum !== (setup.round_settings[state.round]?.quorum ?? setup.quorum ?? null) ||
        (deadline === null) !== (state.deadline_at === null) ||
        (deadline === null && previous?.relativeSeconds != null) ||
        (swept && (deadline === null || compare(deadline, instant(sweepCutoff)) >= 0)) ||
        (relativeSeconds !== null && (!Number.isInteger(relativeSeconds) || relativeSeconds <= 0 || deadline?.tail !== '')) ||
        rows.length !== setup.seats.length || rows.some((row, seat) =>
          row.seat_id !== setup.seats[seat].seat_id || row.round !== state.round)) return false;
    const summary = frozenReceptionSummary(revision, round);
    return state.phase === (summary === null ? 'open' : 'frozen') && isDeepStrictEqual(round.summary, summary);
  });
}

function requiresFrozenRound(p: StoredPacket, recipient: string, round: Round): boolean {
  const header = p.packet.header;
  const index = ROUNDS.indexOf(round);
  if (header.kind === 'synthesis' || (p.heldFor && ROUNDS.indexOf(p.heldFor) >= index)) return true;
  if (header.round === null) return false;
  if (header.round !== round) return ROUNDS.indexOf(header.round) > index;
  return header.kind === 'gate_decision' || (header.seat_id !== recipient && (answer(p) !== undefined || p.attest !== undefined));
}

function legacyDeliveryConsistent(meeting: Meeting, packets: Map<string, StoredPacket>): boolean {
  const agendas = meeting.packets.filter(entry => entry.packet.header.kind === 'agenda')
    .map(({ packet }) => packet.header.packet_id);
  const agendaVersions = latestAgendaVersions(agendas, meeting.setupVersion);
  return meeting.delivery.every(({ seat_id, epoch, sent, ack, notices }) => {
    const sentIds = new Set(sent);
    const absentRounds = meeting.rounds.filter(round => findRow(round, seat_id)?.state === 'absent')
      .map(round => round.state.round);
    const firstMissing = absentRounds[notices.length];
    return sentIds.size === sent.length && new Set(ack).size === ack.length &&
      ack.every(id => sentIds.has(id)) && historyAtOrBefore(notices, absentRounds) && sent.every(id => {
        const packet = packets.get(id);
        if (!packet || (firstMissing && requiresFrozenRound(packet, seat_id, firstMissing))) return false;
        // Historical agenda deliveries are valid while that agenda could be current in this epoch.
        const agendaVersion = agendaVersions.get(id);
        return agendaVersion === undefined ? inputPacketAllowed(meeting, packet, seat_id) : epoch <= agendaVersion;
      });
  });
}

function legacyAttestMatches(meeting: Meeting, entry: StoredPacket, packets: Map<string, StoredPacket>): boolean {
  const { attest, packet } = entry;
  if (!attest || !('method' in packet.body) || packet.body.method !== 'verbatim_confirm' ||
      packet.body.result !== attest.result || (attest.result !== 'confirmed' && attest.result !== 'mismatch')) return false;
  const target = packets.get(attest.target_packet_id);
  const body = target && answer(target);
  return body !== undefined && typeof body.body === 'string' && attest.body_sha === bodySha(body.body) &&
    (attest.confirmer === meeting.convener || bound(findSeat(meeting, packet.header.seat_id), attest.confirmer));
}

function legacyWaiverValid(meetingId: string, { round, seat_id, reason }: ReceptionRow): boolean {
  if (!reason) return false;
  const { code, text } = reason;
  try {
    validate('waive_seat', { meeting_id: meetingId, round, seat_id, reason_code: code,
      ...(text === null ? {} : { reason_note: text }) });
    return true;
  } catch (error) {
    if (record(error) && error.code === 'invalid_argument') return false;
    throw error;
  }
}

function legacyReceptionReplay(revision: MeetingFile, readPacket: ReadPacket): LegacyReplay | undefined {
  const meeting: Meeting = { ...revision, packets: revision.packets.map(({ packet_id, ...metadata }) => ({
    ...metadata, packet: readPacket(packet_id),
  })) };
  const rounds = new Map(meeting.rounds.map(({ state: { round } }) => [round, initialReceptionRows(meeting.setup, round)]));
  const steps: LegacyPacketStep[] = [];
  const packets = new Map<string, StoredPacket>();
  const expected = new Map<string, PacketRevision>();
  let agenda: StoredPacket | undefined;
  let agendas = 0;
  const used = new Map<string, number>();

  // A retained revision can omit the opening snapshot. Reconstruct every row
  // from the same initial state used by startRound and the packets it contains.
  for (const [index, entry] of meeting.packets.entries()) {
    const { attest, heldFor, packet } = entry;
    const { packet_id, meeting_id, kind, round, seat_id, supersedes } = packet.header;
    if (packet_id !== revision.packets[index].packet_id || meeting_id !== meeting.id || packets.has(packet_id) ||
        (index === 0 && kind !== 'agenda') || (kind === 'attest') !== (attest !== undefined) ||
        (heldFor !== undefined && kind !== 'note' && !(kind === 'flash' && heldFor === round))) return;

    const submission = answer(entry);
    const isAnswer = submission !== undefined;
    if (isAnswer && kind !== (round === 'R1' ? 'critique' : 'answer')) return;
    const roundId = round ?? heldFor;
    if (kind === 'gate_decision') {
      if (roundId !== 'R1') return;
      steps.push({ kind });
    } else if (roundId !== undefined) {
      const rows = rounds.get(roundId);
      if (!rows || kind === 'agenda' || kind === 'synthesis' ||
          (attest && (!Number.isSafeInteger(attest.position) || !legacyAttestMatches(meeting, entry, packets)))) return;
      const change = replayLegacyReceptionPacket(meeting.setup, rows, revision.packets[index], packet, expected);
      if (!change) return;
      steps.push({ kind: 'reception', round: roundId, change });
    } else {
      if (kind !== 'agenda' && kind !== 'note' && kind !== 'synthesis') return;
      steps.push({ kind });
    }

    if (kind === 'agenda') {
      if (supersedes !== (agenda?.packet.header.packet_id ?? null) || ++agendas > meeting.setupVersion ||
          !('topic' in packet.body) || packet.body.topic !== meeting.topic ||
          (agenda && isDeepStrictEqual(agenda.packet.body, packet.body))) return;
      if (supersedes !== null) expected.get(supersedes)!.version = 'superseded';
      agenda = entry;
    } else if (!isAnswer && supersedes !== null) return;

    const seat = findSeat(meeting, seat_id);
    if (seat && (isAnswer || kind === 'flash')) {
      const count = (used.get(seat.seat_id) ?? 0) + 1;
      if (count > seat.quota) return;
      used.set(seat.seat_id, count);
    }
    const web = isAnswer && seat?.connection === 'web';
    if (web && submission.claims !== undefined) return;
    const reception = isAnswer ? 'received' : 'not_applicable';
    packets.set(packet_id, entry);
    expected.set(packet_id, {
      packet_id, seq: index + 1, version: 'current', missing: [],
      verification: web ? 'unverified' : 'not_applicable',
      reception: web ? 'transcribed_pending_attest' : reception,
      ...(attest === undefined ? {} : { attest }), ...(heldFor === undefined ? {} : { heldFor }),
    });
  }
  if (!agenda || !isDeepStrictEqual(agenda.packet.body, {
    topic: meeting.topic, shared_materials: meeting.setup.shared_materials,
  })) return;

  if (!legacyChairDecisionsConsistent(revision)) return;
  for (const round of meeting.rounds) {
    for (const row of round.rows) {
      if (round.state.phase === 'frozen' && row.state === 'received' && row.current_packet_id !== null) {
        const entry = expected.get(row.current_packet_id);
        if (!entry) return;
        entry.missing = missingFields(packets.get(row.current_packet_id)!);
      }
    }
  }
  if (revision.packets.every(entry => isDeepStrictEqual(entry, expected.get(entry.packet_id))) &&
      legacyDeliveryConsistent(meeting, packets)) return { packets: steps, entries: meeting.packets };
}

function legacyTimeoutConsistent(revision: MeetingFile, latestTick: bigint): boolean {
  const { setup, rounds, timeoutAt, timeoutOrder, created } = revision;
  if (!/^-?\d+$/.test(created) || BigInt(created) > latestTick || !Number.isSafeInteger(timeoutOrder)) return false;
  const round = rounds.at(-1);
  if (round ? (timeoutOrder < round.sweepOrder || (round.state.phase === 'open' && timeoutOrder !== round.sweepOrder)) :
    timeoutOrder !== 0) return false;
  if (revision.timeoutExceeded !== revision.audit.some(timeoutSweep)) return false;
  if (timeoutAt === null) return !canScheduleTimeout(revision) || revision.timeoutExceeded;
  if (!canScheduleTimeout(revision) || !/^-?\d+$/.test(timeoutAt)) return false;
  const scheduledAt = BigInt(timeoutAt) - seconds(setup.meeting_timeout);
  if (scheduledAt < BigInt(created) || scheduledAt > latestTick) return false;
  // A relative deadline and the open round's timer share the same start tick.
  return round?.state.phase !== 'open' || round.relativeSeconds === null || (round.deadline !== null &&
    scheduledAt === BigInt(round.deadline.ns) - seconds(round.relativeSeconds));
}

function legacyRevisionReplay(revision: MeetingFile, readPacket: ReadPacket, latestTick: bigint): LegacyReplay | undefined {
  const { state, rejectionReason, convenerHuman } = revision;
  const reasonMatches = state === 'REJECTED' ?
    rejectionReason === 'reopened' || rejectionReason === 'rejected' : rejectionReason === undefined;
  if (typeof convenerHuman === 'boolean' && reasonMatches && legacySetupConsistent(revision) &&
      legacyTimeoutConsistent(revision, latestTick) && legacyRoundsConsistent(revision, latestTick) &&
      legacyStateMatches(revision, readPacket)) {
    return legacyReceptionReplay(revision, readPacket);
  }
}

function parseManifest(bytes: string | undefined): Manifest | undefined {
  if (bytes === undefined) return;
  const manifest = JSON.parse(bytes) as Manifest | null;
  if (manifest === null) return;
  requireClockEpoch(manifest?.checkpoint?.epoch);
  validateCheckpoint(manifest.checkpoint);
  if (!manifest.meetings || typeof manifest.meetings !== 'object' || Array.isArray(manifest.meetings) ||
      Object.values(manifest.meetings).some(revision => typeof revision !== 'string') ||
      (manifest.presence !== undefined && typeof manifest.presence !== 'string') ||
      (manifest.proofScheme !== undefined && (manifest.proofScheme !== 'sealed' || manifest.generation === undefined)) ||
      (manifest.revisionDigests !== undefined &&
        (!manifest.revisionDigests || typeof manifest.revisionDigests !== 'object' || Array.isArray(manifest.revisionDigests) ||
          Object.entries(manifest.revisionDigests).some(([id, digest]) =>
            !Object.hasOwn(manifest.meetings, id) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)))) ||
      (manifest.generation !== undefined &&
        (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1 || !manifest.presence))) {
    throw new Error('Invalid council store manifest');
  }
  return manifest;
}

function validateCheckpoint(checkpoint: Checkpoint): void {
  if (!Number.isSafeInteger(checkpoint.position) || checkpoint.position < 0 ||
      [checkpoint.monotonic, checkpoint.offset, checkpoint.wall].some(value =>
        typeof value !== 'string' || !/^-?\d+$/.test(value)) ||
      (checkpoint.humanPrincipals !== undefined && (!Array.isArray(checkpoint.humanPrincipals) ||
        checkpoint.humanPrincipals.some(id => typeof id !== 'string' || id.length === 0)))) {
    throw new Error('Invalid council store checkpoint');
  }
}

function checkCheckpointOrder(prior: Checkpoint | undefined, next: Checkpoint): void {
  if (prior && (BigInt(next.monotonic) < BigInt(prior.monotonic) || next.position < prior.position)) {
    throw new Error('Council store checkpoint moved backward');
  }
  if (prior && prior.epoch === next.epoch && BigInt(prior.offset) !== BigInt(next.offset)) {
    throw new Error('Council store checkpoint offset changed within its clock epoch');
  }
}

let flockDialect: 'gnu' | 'toybox' | undefined;

export function flock(fd: number, mode: '--shared' | '--exclusive', nonblocking = false): boolean {
  // The parent keeps the inherited file description open after flock exits.
  const run = (dialect: 'gnu' | 'toybox') => {
    const options = dialect === 'gnu' ? [mode] : [mode === '--shared' ? '-s' : '-x'];
    if (nonblocking) {
      if (dialect === 'gnu') options.push('--nonblock', '--conflict-exit-code', '75');
      else options.push('-n');
    }
    const lock = spawnSync('flock', [...options, '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    if (lock.error) {
      if (flockDialect === undefined && dialect === 'gnu') flockDialect = 'gnu';
      throw lock.error;
    }
    return lock;
  };

  let lock = run(flockDialect ?? 'gnu');
  if (flockDialect === undefined) {
    if (lock.status !== 0 && /(?:unknown|unrecognized|invalid) option/i.test(lock.stderr.toString())) {
      flockDialect = 'toybox';
      lock = run(flockDialect);
    } else {
      flockDialect = 'gnu';
    }
  }

  if (lock.status === 0) return true;
  if (nonblocking) {
    if (flockDialect === 'gnu' && lock.status === 75) return false;
    if (flockDialect === 'toybox' && lock.status === 1 && lock.stderr.length === 0) return false;
  }
  throw new Error('Could not lock council store: ' + lock.stderr.toString());
}

function presencePaths(directory: string, key: string) {
  return [join(directory, '.presence'), join(directory, '.presence.' + key)] as const;
}

function presenceInode(identity: NonNullable<ReturnType<typeof identityAt>>): string {
  return `${identity.dev}:${identity.ino}:${identity.birthtimeNs}`;
}

function samePresenceInode(a: string, b: string): boolean {
  const [aDev, aIno] = a.split(':');
  const [bDev, bIno] = b.split(':');
  return aDev === bDev && aIno === bIno;
}

function readPresenceToken(path: string): string {
  const fd = openRegular(path);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function presenceChanged(): never {
  throw new Error('Council store presence identity changed');
}

const presenceTokenPattern = /^[0-9a-f-]{36}$/;

function initializePresenceToken(path: string, anchorPath: string): void {
  const prior = identityAt(path);
  if (prior) {
    if (!prior.isFile()) presenceChanged();
    if (presenceTokenPattern.test(readPresenceToken(path))) return;
    // Older writers could leave a partial token at the public name.
    if (prior.nlink !== 1n) presenceChanged();
  }
  const staged = stageFile(path + '-token', randomUUID());
  try {
    const current = identityAt(path);
    const unchanged = prior ? sameEntry(prior, current) && current?.nlink === prior.nlink : current === undefined;
    if (!unchanged || identityAt(anchorPath)) {
      presenceChanged();
    }
    renameSync(staged.path, path);
    if (!sameIdentity(staged.identity, identityAt(path))) presenceChanged();
  } finally {
    staged.close();
  }
}

type PresenceLock = { fd: number; directoryFd: number; identity: FileIdentity; binding: PresenceBinding; exclusive: boolean };
type PresenceStat = NonNullable<ReturnType<typeof identityAt>>;

function presenceWitnessBytes(path: string, identity: PresenceStat): Buffer {
  const fd = openRegular(path);
  try {
    const actual = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const live = identityAt(path);
    if (!actual.isFile() || actual.nlink !== 1n || (actual.mode & 0o7777n) !== 0o600n ||
        !sameEntry(identity, actual) || !sameEntry(actual, fstatSync(fd, { bigint: true })) ||
        !sameEntry(actual, live) || live?.nlink !== 1n || actual.mode !== live.mode) presenceChanged();
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function matchesPresenceWitness(bytes: Buffer, expected: PresenceBinding): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), expected);
  } catch {
    return false;
  }
}

function readPresenceWitness(path: string, expected: PresenceBinding, identity: PresenceStat): void {
  if (!matchesPresenceWitness(presenceWitnessBytes(path, identity), expected)) presenceChanged();
}

function presenceWitnessStagePrefix(binding: PresenceBinding): string {
  return '.presence-witness-' + binding.directory + '-' + contentDigest(JSON.stringify(binding));
}

function isTornPresenceWitness(directory: string, binding: PresenceBinding, bytes: Buffer): boolean {
  const expected = Buffer.from(JSON.stringify(binding));
  if (bytes.length >= expected.length || !bytes.equals(expected.subarray(0, bytes.length))) return false;
  const prefix = presenceWitnessStagePrefix(binding) + '.';
  return readdirSync(directory).some(name => {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
    const path = join(directory, name);
    const identity = identityAt(path);
    return identity?.isFile() && presenceWitnessBytes(path, identity).equals(expected);
  });
}

/** Presence belongs to a core, including when cores use the same FileStore adapter. */
export class StorePresence {
  private readonly locks = new Map<string, PresenceLock>();
  private readonly directories = new Map<string, string>();
  private readonly nonceChecks = new Map<string, {
    checkDirectory: () => void;
    cached?: { fd: number; identity: PresenceStat; nonce: string | undefined };
  }>();

  withinDirectory<T>(key: string, checkDirectory: () => void, work: () => T): T {
    const previous = this.nonceChecks.get(key);
    this.nonceChecks.set(key, { checkDirectory });
    try {
      return work();
    } finally {
      if (previous) this.nonceChecks.set(key, previous);
      else this.nonceChecks.delete(key);
    }
  }

  private claim(directory: string, key: string, path: string, fd: number, expected: FileIdentity, token: string,
    install?: string, fresh = false): string | undefined {
    const interval = this.nonceChecks.get(key);
    const check = () => {
      interval?.checkDirectory();
      const dir = statSync(directory, { bigint: true });
      if (`${dir.dev}:${dir.ino}` !== key) presenceChanged();
      const held = fstatSync(fd, { bigint: true });
      const actual = identityAt(path);
      if (!held.isFile() || !actual?.isFile() || held.nlink !== 1n || actual.nlink !== 1n ||
          !sameIdentity(expected, held) || !sameEntry(held, actual) ||
          readFileSync(descriptorPath(fd), 'utf8') !== token || !sameEntry(held, identityAt(path))) presenceChanged();
      return held;
    };
    const actual = check();
    const cached = interval?.cached;
    if (!fresh && install === undefined && cached?.fd === fd &&
        sameEntry(cached.identity, actual) && cached.identity.ctimeNs === actual.ctimeNs) return cached.nonce;
    const nonce = identityNonce(fd, check, install);
    if (interval) {
      delete interval.cached;
      if (install === undefined) {
        const after = check();
        if (sameEntry(actual, after) && actual.ctimeNs === after.ctimeNs) {
          interval.cached = { fd, identity: after, nonce };
        }
      }
    }
    return nonce;
  }

  get canReanchor(): boolean {
    for (const [key, lock] of this.locks) {
      if (lock.exclusive) {
        this.checkBinding(descriptorPath(lock.directoryFd), key);
        return true;
      }
    }
    return false;
  }

  checkDirectory(root: string, key: string): void {
    const previous = this.directories.get(root);
    if (previous !== undefined && previous !== key) throw new Error('Council store directory changed');
  }

  checkBinding(directory: string, key: string, expected?: PresenceBinding, enrolling = false): void {
    const [path, anchorPath] = presencePaths(directory, key);
    const held = this.locks.get(key);
    expected ??= held?.binding;
    const anchor = identityAt(anchorPath);
    if (!held && !anchor && !expected) return;
    const presence = identityAt(path);
    if (!presence?.isFile() || (held && !sameIdentity(presence, held.identity))) presenceChanged();
    if (expected && expected.directory !== key) {
      // A directory copy has its own lock domain. Require both copied names
      // from the recorded directory before enrolling its existing inode.
      const oldAnchor = presencePaths(directory, expected.directory)[1];
      const old = identityAt(oldAnchor);
      if (held || samePresenceInode(presenceInode(presence), expected.inode) ||
          !old?.isFile() || readPresenceToken(path) !== expected.token) presenceChanged();
      if (expected.scheme === 'recorded') {
        if (presence.nlink !== 1n || sameIdentity(presence, old)) presenceChanged();
        readPresenceWitness(oldAnchor, expected, old);
      } else {
        const aliased = sameIdentity(presence, old);
        const localAlias = anchor !== undefined && sameIdentity(presence, anchor);
        if ((aliased && presence.nlink !== 2n) ||
            (!aliased && (presence.nlink !== (localAlias ? 2n : 1n) || old.nlink !== 1n)) ||
            readPresenceToken(oldAnchor) !== expected.token) presenceChanged();
      }
      if (anchor && (!anchor.isFile() || (expected.scheme !== 'recorded' && sameIdentity(presence, anchor) ?
        presence.nlink !== 2n : anchor.nlink !== 1n))) presenceChanged();
      return;
    } else if ((!anchor && !enrolling) || (expected && !samePresenceInode(presenceInode(presence), expected.inode))) {
      presenceChanged();
    }
    if (expected?.scheme === 'recorded') {
      if (presence.nlink !== 1n || (anchor && sameIdentity(presence, anchor))) presenceChanged();
      if (anchor) {
        const bytes = presenceWitnessBytes(anchorPath, anchor);
        if (!matchesPresenceWitness(bytes, expected) && !(enrolling && isTornPresenceWitness(directory, expected, bytes))) {
          presenceChanged();
        }
      }
      const fd = held?.fd ?? openRegular(path);
      try {
        if (this.claim(directory, key, path, fd, presence, expected.token) !== expected.claim) presenceChanged();
      } finally {
        if (!held) {
          const interval = this.nonceChecks.get(key);
          if (interval?.cached?.fd === fd) delete interval.cached;
          closeSync(fd);
        }
      }
    } else if ((anchor && (!anchor.isFile() || !sameIdentity(presence, anchor) || presence.nlink !== 2n)) ||
      (!anchor && presence.nlink !== 1n) || (expected && readPresenceToken(path) !== expected.token)) presenceChanged();
  }

  // Called under the directory transaction lock, including during EX -> SH.
  withLock<T>(root: string, key: string, directory: string, files: StoreFiles, reanchor: boolean,
    expected: PresenceBinding | undefined, enrolling: boolean, stageEnrollment: (binding: PresenceBinding) => void,
    bind: (binding: PresenceBinding, registered: () => void) => void,
    published: () => boolean, work: () => T): T {
    this.checkBinding(directory, key, expected, enrolling);
    const held = this.locks.get(key);
    if (held) {
      if (reanchor && !held.exclusive) throw new Error('Council store epoch changed while holding presence');
      this.directories.set(root, key);
      return work();
    }

    const [path, anchorPath] = presencePaths(directory, key);
    const anchor = identityAt(anchorPath);
    const copied = expected !== undefined && expected.directory !== key;
    const copiedAnchor = copied ? presencePaths(directory, expected.directory)[1] : undefined;
    const copiedAlias = copiedAnchor !== undefined && sameIdentity(identityAt(path), identityAt(copiedAnchor));
    const recorded = expected?.scheme === 'recorded' || copiedAlias ||
      (copied && anchor !== undefined && !sameIdentity(anchor, identityAt(path))) || (!anchor && files.noLink);
    if (!anchor && recorded) files.requireCopySupport();
    if (!anchor && !expected) initializePresenceToken(path, anchorPath);
    const fd = openRegular(anchor && !recorded ? anchorPath : path, constants.O_RDWR);
    let directoryFd: number | undefined;
    let keep = false;
    let linked = false;
    let witness: PresenceStat | undefined;
    let binding: PresenceBinding | undefined;
    let registered = false;
    try {
      // The two names designate the same inode. A fresh peer validates the
      // alias too, so replacement of the public name cannot bypass a live SH.
      // The key lets a copied directory establish presence for its own inode.
      const bootstrap = anchor === undefined || (recorded && (copied || enrolling));
      if (!flock(fd, reanchor || bootstrap ? '--exclusive' : '--shared', true)) {
        throw new Error('Shared council store has a live peer in a different clock epoch');
      }
      const identity = fstatSync(fd, { bigint: true });
      this.checkBinding(directory, key, expected, enrolling);
      if (!sameIdentity(identity, identityAt(path))) presenceChanged();
      const token = readFileSync(fd, 'utf8');
      if (!presenceTokenPattern.test(token)) presenceChanged();
      // Keep both inodes alive as long as this core owns presence.
      directoryFd = openSync(directory, 'r');
      const tokenBinding = { directory: key, inode: presenceInode(identity), token };
      if (recorded) {
        if (copiedAlias) {
          const old = identityAt(copiedAnchor);
          const staged = stageFile(join(directory, '.presence-split'), token);
          try {
            if (!old || !sameEntry(old, identityAt(copiedAnchor)) || !sameEntry(old, identityAt(path)) ||
                !sameIdentity(identity, old) || fstatSync(fd, { bigint: true }).nlink !== 2n) presenceChanged();
            renameSync(staged.path, copiedAnchor);
            fsyncSync(directoryFd);
          } finally {
            staged.close();
          }
        }
        let claim = this.claim(directory, key, path, fd, identity, token, undefined, true);
        if (!copied && expected?.scheme === 'recorded') {
          if (claim !== expected.claim) presenceChanged();
        } else if (claim === undefined) {
          if (anchor) presenceChanged();
          claim = randomUUID();
          this.claim(directory, key, path, fd, identity, token, claim);
          if (this.claim(directory, key, path, fd, identity, token, undefined, true) !== claim) presenceChanged();
        }
        if (claim === undefined) presenceChanged();
        binding = !copied && expected?.scheme === 'recorded' ? expected : { ...tokenBinding, scheme: 'recorded', claim };
      } else {
        binding = tokenBinding;
      }
      if (bootstrap) {
        fsyncSync(fd);
        // The public name must survive before any record can refer to it.
        fsyncSync(directoryFd);
      }
      stageEnrollment(binding);
      if (binding.scheme === 'recorded') {
        const repair = anchor && !matchesPresenceWitness(presenceWitnessBytes(anchorPath, anchor), binding);
        if (anchor && bootstrap && !repair) {
          // An interrupted enrollment may have left all bytes visible
          // before syncing the witness file.
          files.requireCopySupport();
          const witnessFd = openRegular(anchorPath);
          try {
            if (!sameEntry(anchor, fstatSync(witnessFd, { bigint: true }))) presenceChanged();
            fsyncSync(witnessFd);
            fsyncSync(directoryFd);
            readPresenceWitness(anchorPath, binding, anchor);
          } finally {
            closeSync(witnessFd);
          }
        }
        if (repair || !anchor) {
          files.requireCopySupport();
          if (repair) {
            const bytes = presenceWitnessBytes(anchorPath, anchor);
            if ((!copied && !enrolling) || !isTornPresenceWitness(directory, binding, bytes) ||
                this.claim(directory, key, path, fd, identity, token) !== binding.claim) presenceChanged();
            this.checkBinding(directory, key, expected ?? binding, true);
            if (!presenceWitnessBytes(anchorPath, anchor).equals(bytes)) presenceChanged();
            renameSync(anchorPath, join(directory, '.presence-witness-' + randomUUID() + '.invalid'));
            fsyncSync(directoryFd);
          }
          const bytes = JSON.stringify(binding);
          const staged = stageFile(join(directory, presenceWitnessStagePrefix(binding)), bytes);
          let retain = false;
          try {
            fsyncSync(directoryFd);
            copyExclusive(staged.path, staged.identity, anchorPath, directoryFd, contentDigest(bytes),
              identity => { witness = identity; });
          } catch (error) {
            retain = (error as NodeJS.ErrnoException).code !== 'EEXIST' && !witness;
            throw error;
          } finally {
            staged.close(retain);
          }
        }
      } else if (bootstrap) {
        linkSync(path, anchorPath);
        linked = true;
        fsyncSync(directoryFd);
      }
      const lock = { fd, directoryFd, identity, binding, exclusive: reanchor };
      this.locks.set(key, lock);
      this.checkBinding(directory, key, binding);
      bind(binding, () => { registered = true; });
      if (bootstrap && !reanchor) flock(fd, '--shared');
      this.directories.set(root, key);
      keep = !reanchor;
      try {
        return work();
      } finally {
        if (reanchor && published()) {
          flock(fd, '--shared');
          lock.exclusive = false;
          keep = true;
        }
      }
    } finally {
      if (!keep) {
        this.locks.delete(key);
        this.directories.delete(root);
        try {
          // An enrollment that failed before publishing its binding can
          // retry with the original presence inode.
          if (witness && binding && !registered && sameEntry(witness, identityAt(anchorPath))) {
            readPresenceWitness(anchorPath, binding, witness);
            unlinkSync(anchorPath);
            if (directoryFd !== undefined) fsyncSync(directoryFd);
          } else if (linked && !registered && sameIdentity(identityAt(anchorPath), fstatSync(fd, { bigint: true }))) {
            unlinkSync(anchorPath);
            if (directoryFd !== undefined) fsyncSync(directoryFd);
          }
        } finally {
          closeSync(fd);
          if (directoryFd !== undefined) closeSync(directoryFd);
        }
      }
    }
  }

  close(): void {
    for (const { fd, directoryFd } of this.locks.values()) {
      closeSync(fd);
      closeSync(directoryFd);
    }
    this.locks.clear();
    this.directories.clear();
  }
}

type Snapshot = NonNullable<ReturnType<ManifestFile['open']>> & { manifest: Manifest | undefined };
type StoreSnapshot = {
  fd: number;
  files: StoreFiles;
  manifestFile: ManifestFile;
  snapshot: Snapshot | undefined;
  durable: DurableSnapshot | undefined;
  enrollment: DurableSnapshot | undefined;
  presence: StorePresence;
  generation: number;
};
type Transaction = StoreSnapshot & { epoch: string };

// An adapter may open another FileStore for the same directory during a transaction.
const heldTransactions = new Map<string, Transaction>();

/** An immutable checkpoint publishes the revision index and clock state together. */
export class FileStore implements Store {
  private readonly root: string;
  private readonly identity: FileIdentity;
  private readonly key: string;
  private loaded: Pick<Snapshot, 'identity' | 'bytes'> | undefined;
  private loadedFiles: { from: StoreFiles; dependencies: StoreFiles['dependencies'] } | undefined;
  private active: Transaction | undefined;
  private detached = false;

  constructor(root: string, private readonly clock: { readonly epoch: string },
    private readonly options: { forceNoLink?: boolean } = {}) {
    requireClockEpoch(this.clock?.epoch);
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const directory = statSync(this.root, { bigint: true });
    if (!directory.isDirectory()) throw new Error('Council store directory changed');
    this.identity = directory;
    this.key = `${directory.dev}:${directory.ino}`;
  }

  transaction<T>(work: () => T): T {
    this.validateEpoch();
    return this.withDirectory((fd, directory) => {
      const held = heldTransactions.get(this.key);
      if (held) {
        matchClockEpoch(this.clock.epoch, held.epoch);
        return this.runTransaction(held, work, access?.presence ?? held.presence);
      }
      const presence = access?.presence ?? new StorePresence();
      return this.withSnapshot(fd, directory, presence, state => {
        const transaction = Object.assign(state, { epoch: this.clock.epoch });
        heldTransactions.set(this.key, transaction);
        try {
          return this.runTransaction(transaction, work);
        } finally {
          heldTransactions.delete(this.key);
          if (!access) presence.close();
        }
      });
    });
  }

  private runTransaction<T>(transaction: Transaction, work: () => T, presence = transaction.presence): T {
    this.checkDirectoryPath();
    transaction.manifestFile.check(transaction.snapshot?.identity);
    const previous = this.active;
    this.active = transaction;
    try {
      const { files, manifestFile } = transaction;
      const checkpoint = transaction.snapshot?.manifest?.checkpoint;
      const check = (binding: PresenceBinding, enrolling = false) => {
        this.checkDirectoryPath();
        manifestFile.checkDurable(transaction.durable);
        this.checkGeneration(files, transaction.generation);
        manifestFile.checkContents(transaction.snapshot);
        presence.checkBinding(files.root.path, this.key, binding, enrolling);
        files.check();
      };
      return presence.withLock(this.root, this.key, files.root.path, files,
        checkpoint?.epoch !== this.clock.epoch,
        (transaction.durable ?? transaction.enrollment)?.record.presence, !!transaction.enrollment, binding => {
          if (transaction.durable) return;
          if (transaction.enrollment) {
            manifestFile.checkEnrollment(transaction.enrollment);
            if (transaction.enrollment.record.presence.scheme === undefined && binding.scheme === 'recorded') {
              transaction.enrollment = manifestFile.replaceEnrollment(transaction.enrollment,
                { ...transaction.enrollment.record, presence: binding }, () => check(binding, true));
            }
          } else {
            const { snapshot } = transaction;
            this.readMeetings(snapshot?.manifest, files);
            const bytes = snapshot?.manifest ? snapshot.bytes : null;
            // Sync the intent before linking the anchor. The exact legacy
            // snapshot and presence inode are available on every retry.
            transaction.enrollment = manifestFile.stageEnrollment({ manifest: bytes, presence: binding },
              () => check(binding, true));
          }
        }, (binding, registered) => {
          const { snapshot, durable } = transaction;
          const manifest = snapshot?.manifest;
          const legacy = manifest && manifest.generation === undefined;
          if (transaction.enrollment) {
            transaction.durable = manifestFile.completeEnrollment(transaction.enrollment, () => check(binding), registered);
            transaction.enrollment = undefined;
          } else if (durable && durable.record.presence.directory !== this.key && !legacy) {
            // A copied store needs a binding for its own lock domain.
            // A legacy copy keeps its original record until migration commits.
            this.readMeetings(manifest, files);
            const bytes = manifest ? snapshot!.bytes : null;
            transaction.durable = manifestFile.writeDurable({ manifest: bytes, presence: binding },
              durable, () => check(binding), registered);
          }
          if (legacy) {
            // Anchor the validated legacy state before writing new meeting revisions.
            const loaded = !this.changedSinceLoad(snapshot);
            this.readMeetings(manifest, files);
            this.publishManifest(transaction, { ...manifest, presence: binding.token, generation: 1 },
              undefined, { binding, registered });
            if (loaded) {
              const { bytes, identity } = transaction.snapshot!;
              this.loaded = { bytes, identity };
            }
          }
        }, () => transaction.snapshot?.manifest?.checkpoint.epoch === this.clock.epoch, () => {
          this.checkTransaction(transaction);
          const before = transaction.snapshot;
          const result = work();
          // Writes check again at publication. A read-only operation still
          // validates its dependencies before returning the snapshot.
          if (before === transaction.snapshot) {
            this.checkTransaction(transaction);
            manifestFile.checkContents(before);
          }
          return result;
        });
    } finally {
      this.active = previous;
    }
  }

  private checkDirectory(actual: FileIdentity | undefined): void {
    if (this.detached || !sameIdentity(this.identity, actual)) {
      this.detached = true;
      throw new Error('Council store directory changed');
    }
  }

  private checkDirectoryPath(): void {
    try {
      this.checkDirectory(statSync(this.root, { bigint: true, throwIfNoEntry: false }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') this.checkDirectory(undefined);
      throw error;
    }
  }

  private withDirectory<T>(work: (fd: number, directory: string) => T): T {
    if (this.detached) throw new Error('Council store directory changed');
    let fd: number;
    try {
      fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT' || code === 'ENOTDIR') this.checkDirectory(undefined);
      throw error;
    }
    try {
      this.checkDirectory(fstatSync(fd, { bigint: true }));
      // Adapters can construct another FileStore while a core is still bound.
      access?.presence.checkDirectory(this.root, this.key);
      return work(fd, descriptorPath(fd));
    } finally {
      closeSync(fd);
    }
  }

  private withSnapshot<T>(fd: number, directory: string, presence: StorePresence, work: (state: StoreSnapshot) => T): T {
    new ManifestFile(directory, this.key, fd).validateBeforeLock(parseManifest);
    // The directory inode itself is the transaction lock. There is no
    // separate lock pathname that can redirect subsequent transactions.
    flock(fd, '--exclusive');
    this.checkDirectoryPath();
    const noLink = this.options.forceNoLink === true || process.env.COUNCIL_STORE_NO_LINK === '1' || !probeLinkCapability(fd);
    const checkDirectory = () => this.checkDirectoryPath();
    const files = new StoreFiles(fd, noLink, checkDirectory);
    return presence.withinDirectory(this.key, checkDirectory, () => this.openSnapshot(directory, files, presence, work));
  }

  private openSnapshot<T>(directory: string, files: StoreFiles, presence: StorePresence,
    work: (state: StoreSnapshot) => T): T {
    const { fd } = files.root;
    const manifestFile = new ManifestFile(directory, this.key, fd, files, () => this.checkDirectoryPath());
    let durable = manifestFile.readDurable();
    const generation = files.checkpointGeneration();
    files.checkRevisionGeneration(generation);
    const priorBytes = durable?.record.manifest;
    const prior = parseManifest(priorBytes ?? undefined);
    if ((typeof priorBytes === 'string' && !prior) || (prior?.generation ?? 0) > generation) {
      throw new Error('Invalid council store manifest checkpoint record');
    }

    let legacySnapshot: Pick<Snapshot, 'bytes' | 'identity'> | undefined;
    const enrollment = manifestFile.readEnrollment();
    const enrollmentBinding = enrollment?.record.presence;
    if (enrollment && (durable || enrollmentBinding?.directory !== this.key)) {
      throw new Error('Invalid council store manifest enrollment record');
    }
    const init = manifestFile.classifyInit(generation, durable, enrollment);
    if (!durable) {
      // This check is deliberately before journal recovery, which can
      // overwrite a marked manifest or remove evidence of migration.
      const current = manifestFile.open(init);
      try {
        const legacy = parseManifest(current?.bytes);
        if (generation || legacy?.presence !== undefined ||
            files.hasUnexpectedPresenceAnchor(enrollmentBinding?.directory,
              enrollmentBinding !== undefined && enrollmentBinding.scheme === undefined) || manifestFile.hasLegacyPublication()) {
          throw new Error('Council store manifest or its durable checkpoint record is missing');
        }
        if (enrollment && enrollment.record.manifest !== (legacy ? current!.bytes : null)) {
          throw new Error('Council store manifest disagrees with its interrupted enrollment');
        }
        this.checkLegacyRevisions(legacy, files);
        if (current) legacySnapshot = { bytes: current.bytes, identity: current.identity };
      } finally {
        if (current) closeSync(current.fd);
      }
    }
    presence.checkBinding(directory, this.key, durable?.record.presence ?? enrollmentBinding, !!enrollment);

    const published = generation ? files.readCheckpoint(generation) : priorBytes ?? 'null';
    const committed = parseManifest(published);
    if (generation && (committed?.generation !== generation || committed.presence !== durable?.record.presence.token)) {
      throw new Error('Invalid council store manifest checkpoint artifact');
    }
    if (prior?.presence !== undefined && prior.presence !== durable?.record.presence.token) presenceChanged();

    const checkRecoveryAuthority = () => {
      this.checkDirectoryPath();
      manifestFile.checkDurable(durable);
      manifestFile.checkEnrollment(enrollment);
      presence.checkBinding(directory, this.key, durable?.record.presence ?? enrollmentBinding, !!enrollment);
      this.checkGeneration(files, generation);
      files.checkRevisionGeneration(generation);
      files.check();
      if (generation && files.readCheckpoint(generation) !== published) {
        throw new Error('Council store manifest checkpoint changed during recovery');
      }
    };
    const prepareRestore = () => {
      this.readMeetings(committed, files, true);
      checkRecoveryAuthority();
      if (generation) {
        // A writer can die before either alias is published. Sync all
        // checkpoint artifacts before finalizing the pending revisions.
        files.ensureCheckpointArtifacts(generation, published, checkRecoveryAuthority, true);
        fsyncSync(fd);
        this.publishRevisions(committed, files, checkRecoveryAuthority);
      }
    };
    if (durable && !generation) {
      manifestFile.checkLegacyPublication(durable);
      this.checkLegacyRevisions(prior, files);
    }

    let updateRecord: Parameters<ManifestFile['recover']>[3];
    if (durable && generation && published !== priorBytes) {
      // A lagging record can be brought forward only during recovery of
      // its journal. Its old contents never select the recovery snapshot.
      const precedingGeneration = prior?.generation ?? 0;
      if (precedingGeneration >= generation ||
          (precedingGeneration ? files.readCheckpoint(precedingGeneration) !== priorBytes : generation !== 1)) {
        throw new Error('Council store manifest record disagrees with its committed checkpoint');
      }
      if (prior && committed) {
        checkCheckpointOrder(prior.checkpoint, committed.checkpoint);
        if (Object.keys(prior.meetings).some(id => !Object.hasOwn(committed.meetings, id))) {
          throw new Error('Council store manifest checkpoint dropped a committed meeting');
        }
      }
      updateRecord = (current, verifyNonce) => {
        const record = { ...durable!.record, manifest: published };
        durable = manifestFile.writeDurable(record, durable, () => {
          manifestFile.checkContents(current);
          prepareRestore();
          verifyNonce?.();
        });
      };
    }
    manifestFile.recover(durable, published, prepareRestore, updateRecord, init);
    const snapshot = manifestFile.open();
    const state: StoreSnapshot = { fd, files, manifestFile, snapshot: undefined, durable, enrollment, presence, generation };
    try {
      if (!durable && ((!init && (!sameIdentity(legacySnapshot?.identity, snapshot?.identity) ||
          legacySnapshot?.bytes !== snapshot?.bytes)) ||
          (init && snapshot && snapshot.bytes !== 'null') ||
          files.hasUnexpectedPresenceAnchor(enrollmentBinding?.directory,
            enrollmentBinding !== undefined && enrollmentBinding.scheme === undefined) || manifestFile.hasLegacyPublication())) {
        throw new Error('Council store manifest changed during legacy admission');
      }
      const manifest = parseManifest(snapshot?.bytes);
      if (snapshot) state.snapshot = { ...snapshot, manifest };
      if (durable && durable.record.manifest !== (manifest ? snapshot!.bytes : null)) {
        throw new Error('Council store manifest does not match the durable checkpoint record');
      }
      if (generation && snapshot?.bytes !== published) {
        throw new Error('Council store manifest does not match the committed checkpoint');
      }
      this.checkGeneration(files, generation);
      manifestFile.checkDurable(durable);
      manifestFile.checkEnrollment(enrollment);
      manifestFile.checkContents(state.snapshot);
      files.check();
      if (generation) {
        this.checkDirectoryPath();
        presence.checkBinding(directory, this.key, durable?.record.presence);
        files.ensureCheckpointArtifacts(generation, published, checkRecoveryAuthority);
        if (committed?.revisionDigests) this.publishRevisions(committed, files, checkRecoveryAuthority);
      }
      return work(state);
    } finally {
      const pinned = state.snapshot ?? snapshot;
      if (pinned) closeSync(pinned.fd);
    }
  }

  private checkGeneration(files: StoreFiles, generation: number): void {
    if (files.checkpointGeneration() !== generation) {
      throw new Error('Council store manifest checkpoint generation changed during transaction');
    }
  }

  private checkLegacyRevisions(manifest: Manifest | undefined, files: StoreFiles): void {
    const orderError = 'Council store manifest cannot establish the latest legacy meeting revision';
    const latestTick = BigInt(manifest?.checkpoint.monotonic ?? '0');
    const latestPosition = manifest?.checkpoint.position ?? 0;
    const histories = new Map<string, { selected?: MeetingFile; retained: MeetingFile[] }>();
    files.forEachMeetingRevision((dir, name) => {
      const id = dir.relative;
      const revision = files.read<MeetingFile>(dir, name, 'meeting revision');
      if (!manifest || !Object.hasOwn(manifest.meetings, id) || revision.generation !== undefined) {
        throw new Error('Council store manifest cannot account for all meeting revisions');
      }
      if (!legacyRevisionFieldsKnown(revision)) throw new Error(orderError);
      let history = histories.get(id);
      if (!history) {
        history = { retained: [] };
        histories.set(id, history);
      }
      if (name === manifest.meetings[id] + '.json') {
        const { position } = manifest.checkpoint;
        if (revision.id !== id || revision.timeoutOrder > position ||
            revision.rounds.some(round => round.sweepOrder > position) ||
            revision.packets.some(packet => (packet.attest?.position ?? 0) > position)) {
          throw new Error('Council store manifest checkpoint precedes its legacy meeting revision');
        }
        history.selected = revision;
      } else {
        history.retained.push(revision);
      }
    });

    const reopenedBy = new Map<string, string>();
    for (const [id, { selected }] of histories) {
      if (!selected) throw new Error(orderError);
      if (selected.reopens === null) continue;
      if (selected.reopens === id || reopenedBy.has(selected.reopens) ||
          histories.get(selected.reopens)?.selected?.rejectionReason !== 'reopened') throw new Error(orderError);
      reopenedBy.set(selected.reopens, id);
    }

    const storeHistory: LegacyPositionHistory[] = [];
    // Legacy UUIDs carry no write order. Infer the order within each meeting
    // from persisted changes, then place those histories on one position sequence.
    for (const [id, { selected, retained }] of histories) {
      if (!selected || (selected.rejectionReason === 'reopened') !== reopenedBy.has(id)) throw new Error(orderError);
      const packets = new Map<string, StoredPacket['packet']>();
      const readPacket: ReadPacket = packetId => {
        const cached = packets.get(packetId);
        if (cached) return cached;
        const packet = files.inDirectory(files.root, id, dir => files.inDirectory(dir, 'packets', packetDir =>
          files.readPacket<StoredPacket['packet']>(packetDir, packetId + '.json')));
        packets.set(packetId, packet);
        return packet;
      };
      const replays = new Map<MeetingFile, LegacyReplay>();
      for (const revision of [selected, ...retained]) {
        const replay = legacyRevisionReplay(revision, readPacket, latestTick);
        if (!replay) throw new Error(orderError);
        replays.set(revision, replay);
      }
      const follows = (older: MeetingFile, newer: MeetingFile) =>
        !isDeepStrictEqual(older, newer) && Object.values(legacyRevisionRules).every(rule => rule(older, newer, readPacket)) &&
        legacySharedPacketsConsistent(older, newer, readPacket);
      if (!retained.every(revision => follows(revision, selected))) throw new Error(orderError);
      const ordered = retained.map(revision => ({ revision, predecessors: 0 }));
      for (const [index, current] of ordered.entries()) {
        for (const other of ordered.slice(0, index)) {
          if (follows(other.revision, current.revision)) current.predecessors++;
          else if (follows(current.revision, other.revision)) other.predecessors++;
          else throw new Error(orderError);
        }
      }
      ordered.sort((left, right) => left.predecessors - right.predecessors);
      if (ordered.some(({ predecessors }, index) => predecessors !== index)) throw new Error(orderError);
      const history = [...ordered.map(({ revision }) => revision), selected]
        .map(revision => ({ revision, replay: replays.get(revision)! }));
      if (selected.reopens !== null &&
          !legacyReopenConsistent(histories.get(selected.reopens)!.selected!, history[0].revision)) throw new Error(orderError);
      storeHistory.push(legacyReplayHistory(id, history, latestTick, reopenedBy.get(id)));
    }
    if (!legacyPositionsFit(storeHistory, latestPosition)) throw new Error(orderError);
  }

  private checkTransaction(transaction: Transaction, generation = transaction.generation,
    durable = transaction.durable, expected = durable?.record.presence): void {
    this.checkDirectoryPath();
    transaction.presence.checkBinding(transaction.files.root.path, this.key, expected);
    if (access && access.presence !== transaction.presence) {
      access.presence.checkBinding(transaction.files.root.path, this.key, expected);
    }
    transaction.manifestFile.checkDurable(durable);
    transaction.manifestFile.check(transaction.snapshot?.identity);
    this.checkGeneration(transaction.files, generation);
    transaction.files.check();
  }

  private readSnapshot<T>(work: (state: StoreSnapshot) => T): T {
    if (this.active) return work(this.active);
    return this.withDirectory((fd, directory) => {
      const held = heldTransactions.get(this.key);
      if (held) {
        matchClockEpoch(this.clock.epoch, held.epoch);
        return work(held);
      }
      return this.withSnapshot(fd, directory, access?.presence ?? new StorePresence(), work);
    });
  }

  hasChanges(): boolean {
    this.validateEpoch();
    return this.readSnapshot(({ snapshot }) => this.changedSinceLoad(snapshot));
  }

  private changedSinceLoad(snapshot: Snapshot | undefined): boolean {
    if (!this.loaded && snapshot?.manifest === undefined) return false;
    return !sameIdentity(snapshot?.identity, this.loaded?.identity) || snapshot?.bytes !== this.loaded?.bytes;
  }

  private validateEpoch(): void {
    requireClockEpoch(this.clock?.epoch);
    if (access) matchClockEpoch(this.clock.epoch, access.epoch);
  }

  load(expectedEpoch?: string): ReturnType<Store['load']> {
    this.validateEpoch();
    if (arguments.length > 0) matchClockEpoch(this.clock.epoch, expectedEpoch);
    return this.readSnapshot(({ snapshot, manifestFile, files, durable, enrollment, presence }) => {
      const manifest = snapshot?.manifest;
      const meetings = this.readMeetings(manifest, files);
      this.checkDirectoryPath();
      const binding = (durable ?? enrollment)?.record.presence;
      presence.checkBinding(files.root.path, this.key, binding, !!enrollment);
      if (access && access.presence !== presence) {
        access.presence.checkBinding(files.root.path, this.key, binding, !!enrollment);
      }
      manifestFile.checkDurable(durable);
      manifestFile.checkEnrollment(enrollment);
      manifestFile.checkContents(snapshot);
      files.check();
      this.recordLoad(snapshot, files);
      access?.observeFileStore(this);
      return manifest ? { meetings, checkpoint: manifest.checkpoint } : { meetings };
    });
  }

  private readMeetings(manifest: Manifest | undefined, files: StoreFiles, recover = false): Meeting[] {
    return Object.entries(manifest?.meetings ?? {}).map(([id, revision]) => files.inDirectory(files.root, id, dir => {
      const name = revision + '.json';
      const expected = revisionGeneration(name);
      const { generation, ...state } = files.readRevision<MeetingFile>(
        dir, name, recover && expected > 0 && expected === manifest?.generation, manifest?.revisionDigests?.[id],
      );
      if (state.id !== id || (generation ?? 0) !== expected || expected > (manifest?.generation ?? 0)) {
        throw new Error('Invalid council store manifest meeting revision');
      }
      const packets = state.packets.length ? files.inDirectory(dir, 'packets', packetDir =>
        state.packets.map(({ packet_id, packet_digest, ...metadata }) => ({
          ...metadata, packet: files.readPacket<StoredPacket['packet']>(packetDir, packet_id + '.json', packet_digest),
        }))) : [];
      return { ...state, packets };
    }));
  }

  private publishRevisions(manifest: Manifest | undefined, files: StoreFiles, authorize: () => void): void {
    if (!manifest?.generation) return;
    for (const [id, revision] of Object.entries(manifest.meetings)) {
      const name = revision + '.json';
      if (revisionGeneration(name) === manifest.generation) {
        files.inDirectory(files.root, id, dir => files.publishRevision(dir, name, manifest.revisionDigests?.[id], authorize));
      }
    }
  }

  private recordLoad(snapshot: Snapshot | undefined, files: StoreFiles): void {
    this.loaded = snapshot && { bytes: snapshot.bytes, identity: snapshot.identity };
    this.loadedFiles = { from: files, dependencies: new Map(files.dependencies) };
  }

  commit(changed: readonly Meeting[], checkpoint: Checkpoint): void {
    this.validateEpoch();
    matchClockEpoch(this.clock.epoch, checkpoint.epoch);
    validateCheckpoint(checkpoint);
    const transaction = this.active;
    if (!transaction) return this.transaction(() => this.commit(changed, checkpoint));
    const { files, fd, manifestFile } = transaction;
    this.checkTransaction(transaction);
    if (this.changedSinceLoad(transaction.snapshot)) throw new Error('Council store revision changed since load');
    const prior = transaction.snapshot?.manifest?.checkpoint;
    checkCheckpointOrder(prior, checkpoint);
    if (prior?.humanPrincipals || checkpoint.humanPrincipals) {
      checkpoint = { ...checkpoint, humanPrincipals: [...new Set([
        ...(prior?.humanPrincipals ?? []), ...(checkpoint.humanPrincipals ?? []),
      ])] };
    }
    const priorFiles = this.loadedFiles?.from === files ? undefined : this.loadedFiles?.dependencies;
    if (priorFiles) files.check(priorFiles);

    const generation = transaction.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Council store manifest checkpoint generation exhausted');
    const revision = `${generation}-${randomUUID()}`;
    const committed = transaction.snapshot?.manifest;
    const meetings = { ...committed?.meetings };
    const revisionDigests = { ...committed?.revisionDigests };
    for (const meeting of changed) {
      files.inDirectory(files.root, meeting.id, dir => {
        const committedRevision = committed?.meetings[meeting.id];
        const packets = files.inDirectory(dir, 'packets', packetDir => {
          const entries = meeting.packets.map(({ packet, ...metadata }) => {
            const packet_id = packet.header.packet_id;
            const packet_digest = files.writePacket(packetDir, packet_id + '.json', packet,
              () => this.checkTransaction(transaction), () => {
                if (!committed || !committedRevision) return;
                // The packet itself may not be tracked in this transaction.
                const digest = committed.revisionDigests?.[meeting.id];
                if (digest === undefined) throw new Error('Council store committed meeting revision digest is missing');
                const name = committedRevision + '.json';
                const state = files.readRevision<MeetingFile>(dir, name, false, digest);
                const expected = revisionGeneration(name);
                if (state.id !== meeting.id || (state.generation ?? 0) !== expected ||
                    expected > (committed.generation ?? 0)) {
                  throw new Error('Invalid council store manifest meeting revision');
                }
                return state.packets.find(entry => entry.packet_id === packet_id)?.packet_digest;
              });
            return packet_digest === undefined ? { ...metadata, packet_id } : { ...metadata, packet_id, packet_digest };
          });
          fsyncSync(packetDir.fd);
          return entries;
        }, true);
        const state = { ...meeting, packets, generation };
        files.write(dir, revision + '.json.pending', state, 'meeting revision');
        if (files.noLink) revisionDigests[meeting.id] = contentDigest(JSON.stringify(state));
        else delete revisionDigests[meeting.id];
        fsyncSync(dir.fd);
      }, true);
      meetings[meeting.id] = revision;
    }
    if (changed.length > 0) fsyncSync(fd);

    if (!transaction.snapshot) {
      this.checkTransaction(transaction);
      transaction.snapshot = { ...manifestFile.initialize(), manifest: undefined };
    }
    const presence = transaction.durable!.record.presence.token;
    this.publishManifest(transaction, { checkpoint, meetings, presence, generation,
      ...(Object.keys(revisionDigests).length ? { revisionDigests } : {}) }, priorFiles);
    this.recordLoad(transaction.snapshot, files);
  }

  private publishManifest(transaction: Transaction, manifest: CommittedManifest,
    priorFiles?: StoreFiles['dependencies'], enrollment?: { binding: PresenceBinding; registered: () => void }): void {
    const { files, manifestFile } = transaction;
    const snapshot = transaction.snapshot!;
    if (files.noLink) manifest = { ...manifest, proofScheme: 'sealed' };
    const bytes = JSON.stringify(manifest);
    const binding = enrollment?.binding ?? transaction.durable!.record.presence;
    const record = { manifest: bytes, presence: binding };
    transaction.durable = manifestFile.publish(snapshot, transaction.durable!, record,
      (check, linked) => {
        files.publishCheckpoint(manifest.generation, bytes, () => {
          check();
          files.checkRevisionGeneration(transaction.generation);
          files.checkStagedContents();
        }, linked);
        this.publishRevisions(manifest, files, () => {
          this.checkTransaction(transaction, manifest.generation, transaction.durable, binding);
          if (files.readCheckpoint(manifest.generation) !== bytes) {
            throw new Error('Council store manifest checkpoint changed during publication');
          }
        });
      }, (durable, committed) => {
        this.checkTransaction(transaction, committed ? manifest.generation : transaction.generation, durable, binding);
        if (!committed && snapshot.manifest && transaction.generation === 0) {
          this.checkLegacyRevisions(snapshot.manifest, files);
        }
        if (priorFiles) files.check(priorFiles);
      }, enrollment?.registered);
    transaction.snapshot = { ...snapshot, bytes, manifest };
    transaction.generation = manifest.generation;
  }
}
