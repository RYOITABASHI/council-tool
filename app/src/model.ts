import { isPacketKind } from './types';
import type { GetPacketsResponse, GetStateResponse, PacketEntry, Round, RoundState } from './types';

export type MessageEntry = PacketEntry<'answer' | 'critique' | 'flash' | 'note'>;

export type TimelineItem =
  | { type: 'agenda'; entry: PacketEntry<'agenda'> }
  | { type: 'roundHeader'; round: Round; phase: RoundState['phase'] }
  | { type: 'packet'; entry: MessageEntry }
  | { type: 'attest'; entry: PacketEntry<'attest'> }
  | { type: 'gate'; entry: PacketEntry<'gate_decision'> }
  | { type: 'synthesis'; entry: PacketEntry<'synthesis'> }
  | { type: 'timeout' };

export function topicOf(packets: GetPacketsResponse): string {
  return packets.new_packets.find(entry => isPacketKind(entry, 'agenda'))?.packet.body.topic ?? '';
}

export function receptionRowsForRound(state: GetStateResponse, round: Round) {
  return state.reception_table.filter(row => row.round === round);
}

export function supersededInfo(packets: GetPacketsResponse) {
  const supersededBy = new Map(packets.superseded.map(pair => [pair.old_packet_id, pair.new_packet_id]));
  const supersededIds = new Set(supersededBy.keys());

  for (const entry of packets.new_packets) {
    if (entry.packet_state.version === 'superseded') supersededIds.add(entry.packet.header.packet_id);
  }
  return { supersededBy, supersededIds };
}

interface RoundGroup {
  round: Round;
  phase: RoundState['phase'];
  rows: ReturnType<typeof receptionRowsForRound>;
  entries: (MessageEntry | PacketEntry<'attest' | 'gate_decision'>)[];
}

export function groupByRound(state: GetStateResponse, packets: GetPacketsResponse) {
  const entries = packets.new_packets;
  const agenda = entries.find(entry => isPacketKind(entry, 'agenda'));
  const notes = entries.filter(entry => isPacketKind(entry, 'note'))
    .filter(entry => entry.packet.header.round === null);
  const synthesis = entries.find((entry): entry is PacketEntry<'synthesis'> =>
    isPacketKind(entry, 'synthesis') && entry.packet_state.version === 'current');
  const rounds = new Set(state.round_states.map(({ round }) => round));
  for (const { packet } of entries) {
    if (packet.header.round != null) rounds.add(packet.header.round);
  }

  const sections: RoundGroup[] = [];
  for (const round of [...rounds].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const roundState = state.round_states.find(candidate => candidate.round === round);
    const roundEntries = entries.filter(entry => entry.packet.header.round === round);

    const messages = roundEntries.filter(entry =>
      isPacketKind(entry, 'answer') || isPacketKind(entry, 'critique') ||
      isPacketKind(entry, 'flash') || isPacketKind(entry, 'note') || isPacketKind(entry, 'attest'));
    const gates = round === 'R1' ? roundEntries.filter(entry => isPacketKind(entry, 'gate_decision')) : [];
    sections.push({
      round,
      phase: roundState?.phase ?? 'open',
      rows: receptionRowsForRound(state, round),
      entries: [...messages, ...gates],
    });
  }

  return { agenda, notes, sections, synthesis };
}

export function buildTimeline(state: GetStateResponse, packets: GetPacketsResponse): TimelineItem[] {
  const { agenda, notes, sections, synthesis } = groupByRound(state, packets);
  const items: TimelineItem[] = [];
  if (agenda) items.push({ type: 'agenda', entry: agenda });
  for (const entry of notes) items.push({ type: 'packet', entry });

  for (const { round, phase, entries } of sections) {
    items.push({ type: 'roundHeader', round, phase });
    for (const entry of entries) {
      if (isPacketKind(entry, 'attest')) items.push({ type: 'attest', entry });
      else if (isPacketKind(entry, 'gate_decision')) items.push({ type: 'gate', entry });
      else if (isPacketKind(entry, 'answer') || isPacketKind(entry, 'critique') ||
        isPacketKind(entry, 'flash') || isPacketKind(entry, 'note')) {
        items.push({ type: 'packet', entry });
      }
    }
  }

  if (state.timeout_exceeded) items.push({ type: 'timeout' });
  if (synthesis) items.push({ type: 'synthesis', entry: synthesis });
  return items;
}
