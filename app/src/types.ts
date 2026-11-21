export type Round = `R${number}`;
export type MeetingState = 'CREATED' | 'OPEN' | 'BARRIER' | 'GATE' | 'SYNTHESIZING' |
  'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';

export type SeatKind = 'codex-cli' | 'claude-code-cli' | 'api' | 'local';

export interface CreateMeetingRequest {
  topic: string;
  seats: { seat_id: string; kind: SeatKind }[];
}

export interface CreateMeetingResponse {
  meeting_id: string;
}

export type RunnerPhase = 'idle' | 'running' | 'awaiting_approval' | 'error' | 'done';

export interface RunnerState {
  phase: RunnerPhase;
  detail: string | null;
  updated_at: string;
}

export interface MentionRequest {
  seat_id: string;
  text: string;
}

export type ApproveDecision = 'approve' | 'reject';

export interface MeetingSummary {
  meeting_id: string;
  topic: string;
  meeting_state: MeetingState;
  created_at: string;
  updated_at: string;
  seat_ids: string[];
}

export interface RoundState {
  round: Round;
  phase: 'open' | 'frozen';
  opened_at: string;
  deadline_at: string | null;
  quorum: number | null;
}

export interface ReceptionRow {
  seat_id: string;
  round: Round;
  state: 'pending' | 'transcribed_pending_attest' | 'received' | 'absent' | 'waived';
  reason: { code: string; text: string | null } | null;
  current_packet_id: string | null;
  invalidated_packet_id: string | null;
}

export interface GetStateResponse {
  meeting_state: MeetingState;
  round_states: RoundState[];
  reception_table: ReceptionRow[];
  timeout_exceeded: boolean;
  reopens: unknown | null;
  setup_version: number;
  seats: {
    seat_id: string;
    connection: 'cli' | 'api' | 'web' | 'local';
    quota: number;
    role?: string;
    shared_materials: string[];
    sharing_policy: unknown;
    tool_access: string;
    flash: boolean;
    optional: boolean;
    seat_specific_materials?: { id: string }[];
    seat_specific_materials_count?: number;
  }[];
}

export interface AnswerBody {
  body: string;
  claims?: { statement?: string | null; reversal_condition?: string | null }[];
}

export interface DeclaredMissingRecord {
  seat_id: string;
  packet_id: string;
  note: string;
}

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
  synthesis: {
    reception_summary: string;
    cited_materials: { material_ref: string }[];
    agreements: string[];
    minority_opinions: { seat_id: string; opinion: string }[];
    unverified_items: unknown[];
    declared_missing_records: DeclaredMissingRecord[];
    reversal_conditions: { claim: string; condition: string; source_seat: string }[];
    recommendation: string | null;
  };
  attest: { method: 'verbatim_confirm'; result: 'confirmed' | 'mismatch' };
  note: { text: string };
}

export type PacketKind = keyof PacketBodies;
export type Packet<K extends PacketKind = PacketKind> = {
  [Kind in K]: {
    header: {
      kind: Kind;
      meeting_id: string;
      round: Kind extends 'gate_decision' ? 'R1' : Kind extends 'synthesis' ? null : Round | null;
      seat_id: Kind extends 'gate_decision' | 'synthesis' ? null : string | null;
      created_at: string;
      supersedes: string | null;
      packet_id: string;
      packet_sha: string;
    };
    body: PacketBodies[Kind];
  };
}[K];

export type MissingRecord = 'claims' | 'statement' | 'reversal_condition';

export interface PacketEntry<K extends PacketKind = PacketKind> {
  packet: Packet<K> & { target_packet_id?: string };
  packet_state: {
    version: 'current' | 'superseded';
    verification: 'verified' | 'unverified' | 'not_applicable';
    reception: 'received' | 'transcribed_pending_attest' | 'invalidated' | 'superseded' | 'not_applicable';
  };
  missing_records: MissingRecord[];
  declared_missing_records: DeclaredMissingRecord[];
}

export interface GetPacketsResponse {
  superseded: { old_packet_id: string; new_packet_id: string }[];
  setup_version: number;
  new_packets: PacketEntry[];
}

export interface MeetingData {
  state: GetStateResponse;
  packets: GetPacketsResponse;
}

export function isPacketKind<K extends PacketKind>(
  entry: PacketEntry, kind: K,
): entry is PacketEntry<K> {
  return entry.packet.header.kind === kind;
}
