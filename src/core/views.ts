import type { ClockSample } from './clock.js';
import { anySeat, audit, bound, findPacket, findRound, findSeat, frozenAnswer, ok, policy } from './meeting.js';
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

  const authorized = m.packets.filter(p => oversight
    ? (p.packet.header.round === null || canOversee(p.packet.header.round)) &&
      (!p.heldFor || canOversee(p.heldFor))
    : inputPacketAllowed(m, p, seatId));
  const filtered = authorized.filter(p => a.round === undefined || p.packet.header.round === a.round);
  const ids = new Set(filtered.map(p => p.packet.header.packet_id));
  const superseded = filtered.flatMap(({ packet: { header } }) =>
    header.supersedes && ids.has(header.supersedes)
      ? [{ old_packet_id: header.supersedes, new_packet_id: header.packet_id }] : []);
  const common = { superseded, setup_version: m.setupVersion };
  if (oversight) {
    const synthesis = m.packets.map(p => p.packet).find(p => p.header.kind === 'synthesis');
    // Packet's discriminator is nested inside its header.
    const body = synthesis?.body;
    const declared = body && 'declared_missing_records' in body ? body.declared_missing_records : [];
    return {
      ...common, new_packets: filtered.map(p => ({
        packet: envelopePacket(p), packet_state: {
          version: p.version, verification: p.verification, reception: p.reception,
        },
        missing_records: p.missing,
        declared_missing_records: declared.filter(record => record.packet_id === p.packet.header.packet_id),
      })),
    };
  }

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
  const new_packets = filtered.filter(p => !ack.has(p.packet.header.packet_id)).map(envelopePacket);
  for (const p of new_packets) sent.add(p.header.packet_id);
  delivery.sent = [...sent];
  delivery.ack = [...ack];
  const notices = m.rounds.flatMap(r => r.rows.flatMap(row => {
    if (row.seat_id !== seatId || row.state !== 'absent' || delivery.notices.includes(row.round)) return [];
    delivery.notices.push(row.round);
    return [{ round: row.round, seat_id: seatId, kind: 'absent' as const, reason: row.reason!.code }];
  }));
  return { ...ok, ...common, new_packets, notices, delivery_epoch: delivery.epoch };
}
