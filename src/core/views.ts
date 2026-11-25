import { packetTimestamp, parseAbsolute } from './clock.js';
import type { ClockSample } from './clock.js';
import { packetSha } from '../packet/index.js';
import type { PacketHashInput } from '../packet/index.js';
import { anySeat, audit, bound, currentRound, findPacket, findRound, findSeat, frozenAnswer, noteAttributionValid, ok, policy } from './meeting.js';
import { answer } from './model.js';
import type { Meeting, Operations, StoredPacket } from './model.js';
import type { Round } from './types.js';
import { fail } from './validation.js';

export function getState(m: Meeting, principal: string, human: boolean) {
  return {
    meeting_state: m.state, round_states: m.rounds.map(r => r.state),
    reception_table: m.rounds.flatMap(r => r.rows), timeout_exceeded: m.timeoutExceeded,
    reopens: m.reopens, setup_version: m.setupVersion,
    seats: m.setup.seats.map(s => {
      const sharing_policy = policy(s);
      const items = s.seat_specific_materials ?? [];
      const canRead = human || m.setup.chair.principal === principal || bound(s, principal);
      return {
        seat_id: s.seat_id, connection: s.connection, quota: s.quota,
        ...(s.role === undefined ? {} : { role: s.role }),
        shared_materials: s.shared_materials ?? [], sharing_policy, tool_access: s.tool_access ?? 'none',
        flash: s.flash ?? false, optional: s.optional ?? false,
        ...(canRead ? { seat_specific_materials: items.map(({ id }) => ({ id, sharing_policy })) } :
          { seat_specific_materials_count: items.length }),
      };
    }),
  };
}

export function runnerEvidence(m: Meeting) {
  const directed = m.rounds.slice().reverse().find(r => r.directedSeatId !== undefined);
  let request = directed?.requestPacketId ? findPacket(m, directed.requestPacketId) : undefined;
  if (directed && directed.requestPacketId === undefined) {
    // Older stores have no link. Recover only when the opening timestamp identifies one note.
    const opened = parseAbsolute(directed.state.opened_at);
    const notes = opened && m.packets.filter(({ packet: { header } }) =>
      header.kind === 'note' && header.created_at === packetTimestamp(BigInt(opened.ns)));
    if (notes && notes.length === 1) request = notes[0];
  }
  // PR-D: a quarantined mention note never reaches a resumed round's prompt.
  if (request && !packetIntact(request)) request = undefined;
  // PR-D: only an intact gate packet may decide the runner's next step; a tampered one reads as no gate.
  // A meeting has at most one R1 gate decision, so more than one candidate means a forgery: none counts.
  const gates = m.packets.filter(p => p.packet.header.kind === 'gate_decision' && p.packet.header.round === 'R1');
  const gate = gates.length === 1 && packetIntact(gates[0]!) ? gates[0] : undefined;
  const gateBody = gate?.packet.body;
  const gateResult = gateBody && 'result' in gateBody && (gateBody.result === 'pass' || gateBody.result === 'fail')
    ? gateBody.result : null;
  return {
    directed: directed ? {
      round: directed.state.round, seat_id: directed.directedSeatId!,
      text: request && 'text' in request.packet.body ? request.packet.body.text : null,
    } : null,
    r1Gate: gateResult !== null && gateResult === settledGate(m) ? gateResult : null,
  };
}

/**
 * PR-D: chair_gate commits its packet together with the state change (pass: SYNTHESIZING; fail: the
 * gate's R2 opens). The packet is evidence only where the meeting state already agrees with it, so a
 * forged gate packet, even one whose packet_sha was recomputed where the store keeps no digest,
 * can neither skip the gate step nor flip its result. Mention rounds (directed) are not gate rounds.
 */
function settledGate(m: Meeting): 'pass' | 'fail' | null {
  const r1 = findRound(m, 'R1');
  if (!r1 || r1.directedSeatId !== undefined || r1.state.phase !== 'frozen') return null;
  if (m.state === 'GATE' && currentRound(m) === r1) return null;
  const r2 = findRound(m, 'R2');
  return r2 && r2.directedSeatId === undefined ? 'fail' : 'pass';
}

/**
 * PR-D: recompute packet_sha with the existing PROTOCOL §3.4 definition. A packet whose digest no
 * longer matches is quarantined on read: withheld from packet views (and so from the app timeline),
 * reported by id, and left untouched in the store.
 */
export function packetIntact(p: StoredPacket): boolean {
  // The file store already found this packet's bytes disagreeing with its receipt.
  if (p.quarantined) return false;
  try {
    return packetSha(p.packet as PacketHashInput) === p.packet.header.packet_sha;
  } catch {
    return false;
  }
}

function quarantine(m: Meeting): Set<string> {
  return new Set(m.packets.filter(p => !packetIntact(p)).map(p => p.packet.header.packet_id));
}

/** B3: note attribution for the packet view. Notes without (valid) attribution have no origin. */
function noteFields(m: Meeting, p: StoredPacket) {
  if (p.packet.header.kind !== 'note') return {};
  const note = noteAttributionValid(m, p.note) ? p.note : undefined;
  return { origin: note ? { ...note.origin } : null, addressee: note?.addressee ?? null };
}

function envelopePacket(p: StoredPacket) {
  return { ...p.packet, ...(p.attest ? { target_packet_id: p.attest.target_packet_id } : {}) };
}

export function inputPacketAllowed(m: Meeting, p: StoredPacket, seatId: string): boolean {
  const { kind, round, seat_id } = p.packet.header;
  if (p.heldFor && findRound(m, p.heldFor)?.state.phase !== 'frozen') return false;
  if (kind === 'agenda') return p.version === 'current';
  if (answer(p)) {
    return seat_id === seatId || (frozenAnswer(m, p) && (round !== 'R0' || !!findRound(m, 'R1')));
  }
  if (p.attest) {
    const target = findPacket(m, p.attest.target_packet_id);
    return seat_id === seatId || (!!target && inputPacketAllowed(m, target, seatId));
  }
  return true;
}

export type InputReceipt = Required<Pick<Operations['get_packets'], 'ack_packet_ids' | 'delivery_epoch'>>;

export function acknowledgeInput(m: Meeting, seatId: string, a: Partial<InputReceipt>,
  now: ClockSample, position: number, authorized: StoredPacket[]) {
  const delivery = m.delivery.find(s => s.seat_id === seatId)!;
  const ack = new Set(delivery.ack);
  const sent = new Set(delivery.sent);
  const allowedIds = new Set(authorized.map(({ packet }) => packet.header.packet_id));
  for (const id of a.ack_packet_ids ?? []) {
    if (a.delivery_epoch === delivery.epoch && sent.has(id) && allowedIds.has(id)) ack.add(id);
    else audit(m, now, 'get_packets', 'ignored_ack', {
      packet_id: id, provided_epoch: a.delivery_epoch,
      call: { position, seat_id: seatId, delivery_epoch: delivery.epoch },
    });
  }
  delivery.ack = [...ack];
  return { delivery, ack, sent };
}

export function getPackets(m: Meeting, principal: string, human: boolean,
  a: Operations['get_packets'], now: ClockSample, position: number) {
  const oversight = a.view === 'oversight';
  const chair = m.setup.chair.principal === principal;
  const convener = m.convener === principal;
  const seatId = a.caller_seat_id;
  const belongsToSeat = anySeat(m, principal);
  const targetSeat = findSeat(m, seatId);
  if (oversight) {
    const role = seatId === 'chair' ? chair : seatId === 'human' ? human :
      seatId === 'convener' ? convener : bound(targetSeat, principal);
    if (!role || (!chair && !human && !convener)) fail('unauthorized');
  } else if (!bound(targetSeat, principal)) {
    fail('unauthorized');
  }

  const canOversee = (round: Round) =>
    !belongsToSeat || findRound(m, round)?.state.phase === 'frozen';
  if (oversight && a.round !== undefined && !canOversee(a.round)) fail('unauthorized');

  const visible = m.packets.filter(p => oversight
    ? (p.packet.header.round === null || canOversee(p.packet.header.round)) &&
      (!p.heldFor || canOversee(p.heldFor))
    : inputPacketAllowed(m, p, seatId));
  const bad = quarantine(m);
  const authorized = visible.filter(p => !bad.has(p.packet.header.packet_id));
  const filtered = authorized.filter(p => a.round === undefined || p.packet.header.round === a.round);
  // Report only the quarantined packets this response would otherwise have contained.
  const quarantined_packet_ids = visible.filter(p => bad.has(p.packet.header.packet_id) &&
    (a.round === undefined || p.packet.header.round === a.round)).map(p => p.packet.header.packet_id);
  const ids = new Set(filtered.map(p => p.packet.header.packet_id));
  const superseded = filtered.flatMap(({ packet: { header } }) =>
    header.supersedes && ids.has(header.supersedes)
      ? [{ old_packet_id: header.supersedes, new_packet_id: header.packet_id }] : []);
  const common = {
    superseded, setup_version: m.setupVersion,
    ...(quarantined_packet_ids.length ? { quarantined_packet_ids } : {}),
  };
  if (oversight) {
    // A quarantined synthesis contributes nothing, including its declared missing records.
    const synthesis = m.packets.find(p => p.version === 'current' && p.packet.header.kind === 'synthesis' &&
      !bad.has(p.packet.header.packet_id))?.packet;
    // Packet's discriminator is nested inside its header.
    const body = synthesis?.body;
    const declared = body && 'declared_missing_records' in body && Array.isArray(body.declared_missing_records)
      ? body.declared_missing_records : [];
    return {
      ...common, new_packets: filtered.map(p => ({
        packet: envelopePacket(p), packet_state: {
          version: p.version, verification: p.verification, reception: p.reception,
        },
        missing_records: p.missing,
        declared_missing_records: declared.filter(record => record.packet_id === p.packet.header.packet_id),
        ...noteFields(m, p),
      })),
    };
  }

  const { delivery, ack, sent } = acknowledgeInput(m, seatId, a, now, position, authorized);
  const new_packets = filtered.filter(p => !ack.has(p.packet.header.packet_id)).map(envelopePacket);
  for (const p of new_packets) sent.add(p.header.packet_id);
  delivery.sent = [...sent];
  const notices = m.rounds.flatMap(r => r.rows.flatMap(row => {
    if (row.seat_id !== seatId || row.state !== 'absent' || delivery.notices.includes(row.round)) return [];
    delivery.notices.push(row.round);
    return [{ round: row.round, seat_id: seatId, kind: 'absent' as const, reason: row.reason!.code }];
  }));
  return { ...ok, ...common, new_packets, notices, delivery_epoch: delivery.epoch };
}
