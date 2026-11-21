import type { Round } from '../core/types.js';

// PROTOCOL.md §3.2–3.3
export interface AnswerBody {
  body: string;
  claims?: { statement?: string | null; reversal_condition?: string | null }[];
}

// PROTOCOL.md §3.2 and §4.3 (hash_match is reserved for a successor to v1)
export type AttestBody =
  | { method: 'verbatim_confirm'; result: 'confirmed' | 'mismatch'; source_hash?: never }
  | { method: 'hash_match'; result: 'confirmed' | 'mismatch'; source_hash: string };

// PROTOCOL.md §6
export interface SynthesisBody {
  reception_summary: string;
  cited_materials: { material_ref: string }[];
  agreements: string[];
  minority_opinions: { seat_id: string; opinion: string }[];
  unverified_items: ({
    seat_id: string;
    packet_id: string;
    state: string;
  } & (
    | { source: 'chair'; missing?: never }
    | { source: 'core'; missing: ('claims' | 'statement' | 'reversal_condition')[] }
  ))[];
  declared_missing_records: { seat_id: string; packet_id: string; note: string }[];
  reversal_conditions: { claim: string; condition: string; source_seat: string }[];
  recommendation: string | null;
}

// PROTOCOL.md §3.2
export interface PacketBodies {
  agenda: { topic: string; shared_materials: string[] };
  answer: AnswerBody;
  critique: AnswerBody;
  flash: { body: string; basis: string };
  gate_decision: {
    result: 'pass' | 'fail';
    rationale: string;
    resolved_points: string[];
    unresolved_points: string[];
    next_round_scope: string[];
  };
  synthesis: SynthesisBody;
  attest: AttestBody;
  note: { text: string };
}

// PROTOCOL.md §3.1–3.2
export type PacketKind = keyof PacketBodies;

type PacketLocation<K extends PacketKind> =
  K extends 'agenda' | 'synthesis' | 'note' ? { round: null; seat_id: null }
    : K extends 'gate_decision' ? { round: 'R1'; seat_id: null }
    : { round: K extends 'answer' ? 'R0' | 'R2' : K extends 'critique' ? 'R1' : Round; seat_id: string };

// PROTOCOL.md §3.1 and §3.4
export type HashablePacketHeader<K extends PacketKind = PacketKind> = {
  meeting_id: string;
  kind: K;
  created_at: string;
  supersedes: K extends 'attest' ? null : string | null;
} & PacketLocation<K>;

// PROTOCOL.md §3.1
export type PacketHeader<K extends PacketKind = PacketKind> = HashablePacketHeader<K> & {
  packet_id: string;
  packet_sha: string;
};

// PROTOCOL.md §3.1–3.2
export type Packet = {
  [K in PacketKind]: { header: PacketHeader<K>; body: PacketBodies[K] };
}[PacketKind];

// PROTOCOL.md §3.4 and §4.2
export type PacketHashInput = {
  [K in PacketKind]: {
    header: HashablePacketHeader<K> & {
      packet_id?: string;
      packet_sha?: string;
      seq?: number;
    };
    body: PacketBodies[K];
  };
}[PacketKind];
