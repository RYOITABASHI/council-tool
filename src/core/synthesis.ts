import type { SynthesisBody } from '../packet/index.js';
import type { ClockSample } from './clock.js';
import { audit, findPacket, findRound, findRow, findSeat, frozenAnswer, policy } from './meeting.js';
import { answer } from './model.js';
import type { Meeting, SynthesisDraft } from './model.js';
import { fail, record, seatReference } from './validation.js';

export function resolveMaterial(m: Meeting, ref: string) {
  const [, seatId, itemId] = seatReference.exec(ref)!;
  const seat = findSeat(m, seatId);
  if (!seat?.seat_specific_materials?.some(item => item.id === itemId)) fail('not_found');
  return policy(seat);
}

function summary(m: Meeting) {
  const reasons: Record<string, string> = {
    deadline_no_submission: '未提出', attest_mismatch: '有効な提出なし（attest 不一致）', chair_declared: '議長宣言',
  };
  return m.rounds.map(r => {
    const { total, received, absent, waived, quorum_met } = r.summary!;
    const details = r.rows.flatMap(row => {
      const suffix = reasons[row.reason?.code ??
        (row.invalidated_packet_id ? 'attest_mismatch' : 'deadline_no_submission')];
      const label = findSeat(m, row.seat_id)?.optional ? '任意席' : '必須席';
      if (row.state === 'absent' || row.state === 'pending') return [row.seat_id + '（' + label + '・' + suffix + '）'];
      if (row.state === 'transcribed_pending_attest') return [row.seat_id + '（任意席・attest 未確定）'];
      return [];
    });
    return [
      r.state.round + ': 受領' + received + '/' + total,
      '欠席' + absent, '免除' + waived, ...details,
    ].join('・') + (quorum_met === false ? '（quorum未達）' : '');
  }).join('\n');
}

export function synthesis(m: Meeting, draft: SynthesisDraft, now: ClockSample): SynthesisBody {
  const allowed = draft.cited_materials.map(({ material_ref }) => {
    if (seatReference.test(material_ref)) {
      const rule = resolveMaterial(m, material_ref);
      return rule === 'share_freely' || (rule === 'share_with_confirmation' && m.confirmations.some(c =>
        c.material_ref === material_ref && c.purpose === 'cite_in_synthesis' && c.setup_version === m.setupVersion));
    }
    const p = findPacket(m, material_ref.slice('packet:'.length));
    if (!p) fail('not_found');
    return frozenAnswer(m, p) || (p.version === 'current' &&
      (p.packet.header.kind === 'agenda' || p.packet.header.kind === 'gate_decision'));
  });
  const offending = [...new Set(draft.cited_materials.filter((_, i) => !allowed[i]).map(c => c.material_ref))];
  if (offending.length) fail('invalid_state', { meeting_state: m.state, offending_materials: offending });
  if (m.state !== 'SYNTHESIZING') fail('invalid_state', { meeting_state: m.state });

  const unverified_items: SynthesisBody['unverified_items'] = [];
  const declared_missing_records: SynthesisBody['declared_missing_records'] = [];
  function match(entry: unknown) {
    if (!record(entry) || typeof entry.packet_id !== 'string' || typeof entry.seat_id !== 'string') return;
    const p = findPacket(m, entry.packet_id);
    if (p && answer(p) && p.packet.header.seat_id === entry.seat_id) return p;
  }
  for (const entry of draft.unverified_items ?? []) {
    const p = match(entry);
    if (p?.verification === 'unverified') {
      const { seat_id, packet_id, round } = p.packet.header;
      const seatState = findRow(findRound(m, round), seat_id)?.state;
      const state = p.reception !== 'superseded' && (seatState === 'waived' || seatState === 'absent')
        ? seatState : p.reception;
      unverified_items.push({ seat_id: seat_id!, packet_id, source: 'chair', state });
    } else audit(m, now, 'synthesize', 'discarded_unverified_item');
  }
  for (const entry of draft.missing_records ?? []) {
    const p = match(entry);
    if (p && record(entry) && typeof entry.note === 'string' && !/[\uD800-\uDFFF]/u.test(entry.note) &&
      frozenAnswer(m, p) && answer(p)?.claims === undefined) {
      declared_missing_records.push({ seat_id: p.packet.header.seat_id!, packet_id: p.packet.header.packet_id, note: entry.note });
    } else audit(m, now, 'synthesize', 'discarded_declared_missing_record');
  }
  for (const p of m.packets) {
    if (p.missing.length) unverified_items.push({
      seat_id: p.packet.header.seat_id!, packet_id: p.packet.header.packet_id, source: 'core',
      state: p.reception, missing: p.missing,
    });
  }
  return {
    agreements: draft.agreements, minority_opinions: draft.minority_opinions, reversal_conditions: draft.reversal_conditions,
    recommendation: draft.recommendation, cited_materials: draft.cited_materials, unverified_items, declared_missing_records,
    reception_summary: summary(m),
  };
}
