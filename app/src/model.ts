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

/** Milliseconds for ordering; an unparseable time sorts last rather than jumping to the top. */
function timeOf(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(value) ? Infinity : value;
}

export function buildTimeline(state: GetStateResponse, packets: GetPacketsResponse): TimelineItem[] {
  const { agenda, notes, sections, synthesis } = groupByRound(state, packets);
  const items: TimelineItem[] = [];
  if (agenda) items.push({ type: 'agenda', entry: agenda });

  // The round-structured body, each item paired with the time used to slot round-less notes in.
  // A round header takes its round's opened_at (else its first item's time), so it stays above
  // its own items and a note sent before the round opened lands above the header.
  const body: { item: TimelineItem; at: number }[] = [];
  for (const { round, phase, entries } of sections) {
    const openedAt = state.round_states.find(candidate => candidate.round === round)?.opened_at;
    const headerAt = openedAt ? timeOf(openedAt)
      : entries.length > 0 ? timeOf(entries[0].packet.header.created_at) : Infinity;
    body.push({ item: { type: 'roundHeader', round, phase }, at: headerAt });
    for (const entry of entries) {
      const at = timeOf(entry.packet.header.created_at);
      if (isPacketKind(entry, 'attest')) body.push({ item: { type: 'attest', entry }, at });
      else if (isPacketKind(entry, 'gate_decision')) body.push({ item: { type: 'gate', entry }, at });
      else if (isPacketKind(entry, 'answer') || isPacketKind(entry, 'critique') ||
        isPacketKind(entry, 'flash') || isPacketKind(entry, 'note')) {
        body.push({ item: { type: 'packet', entry }, at });
      }
    }
  }

  // Round-less notes (mentions sent between rounds) go in chronologically: each sits right after the
  // last body item that is not later than it, so everything earlier than a note is shown above it even
  // if the body itself is not strictly in time order. Body items with an unparseable time are not used
  // as anchors. The rounds' own order is left untouched. Notes later than every body item come last,
  // after the timeout notice, i.e. right before the synthesis card.
  const ordered = notes
    .map((entry, index) => ({ entry, index, at: timeOf(entry.packet.header.created_at) }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  // slots[i] holds the notes shown before body[i]; slots[body.length] the ones after the whole body.
  const slots: MessageEntry[][] = Array.from({ length: body.length + 1 }, () => []);
  for (const { entry, at } of ordered) {
    let anchor = -1;
    if (at !== Infinity) {
      for (let index = body.length - 1; index >= 0; index -= 1) {
        if (body[index].at !== Infinity && body[index].at <= at) {
          anchor = index;
          break;
        }
      }
    } else {
      anchor = body.length - 1;
    }
    slots[anchor + 1].push(entry);
  }
  body.forEach(({ item }, index) => {
    for (const entry of slots[index]) items.push({ type: 'packet', entry });
    items.push(item);
  });

  if (state.timeout_exceeded) items.push({ type: 'timeout' });
  for (const entry of slots[body.length]) items.push({ type: 'packet', entry });
  if (synthesis) items.push({ type: 'synthesis', entry: synthesis });
  return items;
}
