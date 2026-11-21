import type { AnswerBody, Packet, SynthesisBody } from '../packet/index.js';
import type { Deadline, Instant } from './clock.js';
import type { MeetingState, ReceptionState, Round, RoundState, SeatConfig, StoredSeatConfig } from './types.js';

export type Principal = string | { id: string; kind: 'human' | 'agent' };
export type ChairConfig = { principal: string; display_name?: string | null; seat_id?: string };
export type RoundSettings = Partial<Record<Round, { deadline?: Deadline | null; quorum?: number }>>;
export interface Setup {
  chair: ChairConfig;
  seats: StoredSeatConfig[];
  shared_materials: string[];
  human_participants: string[];
  round_settings: RoundSettings;
  quorum?: number;
  meeting_timeout: number;
}

export type SetupUpdate = Partial<Omit<Setup, 'chair' | 'seats'>> & {
  chair?: Partial<ChairConfig>;
  seats?: (Partial<SeatConfig> & Pick<SeatConfig, 'seat_id'>)[];
};

export interface ReceptionRow {
  seat_id: string;
  round: Round;
  state: ReceptionState;
  reason: { code: string; text: string | null } | null;
  current_packet_id: string | null;
  invalidated_packet_id: string | null;
}

export interface RoundRecord {
  state: RoundState;
  deadline: Instant | null;
  relativeSeconds: number | null;
  swept: boolean;
  sweepOrder: number;
  rows: ReceptionRow[];
  summary: {
    total: number;
    received: number;
    absent: number;
    waived: number;
    quorum_met: boolean | null;
  } | null;
}

export type Missing = 'claims' | 'statement' | 'reversal_condition';
export type Verification = 'verified' | 'unverified' | 'not_applicable';
export interface StoredPacket {
  packet: Packet;
  seq: number;
  version: 'current' | 'superseded';
  verification: Verification;
  reception: 'received' | 'transcribed_pending_attest' | 'invalidated' | 'superseded' | 'not_applicable';
  missing: Missing[];
  heldFor?: Round;
  attest?: { target_packet_id: string; confirmer: string; body_sha: string;
    result: 'confirmed' | 'mismatch'; position: number };
}

export interface Delivery {
  seat_id: string;
  epoch: number;
  sent: string[];
  ack: string[];
  notices: Round[];
}

export interface ShareConfirmation {
  material_ref: string;
  setup_version: number;
  purpose: 'share_with_seat' | 'share_external' | 'cite_in_synthesis';
  to_seat_id?: string;
}

export interface Meeting {
  id: string;
  topic: string;
  convener: string;
  convenerHuman: boolean;
  setup: Setup;
  setupVersion: number;
  state: MeetingState;
  reopens: string | null;
  rejectionReason?: 'reopened' | 'rejected';
  created: string;
  timeoutAt: string | null;
  timeoutOrder: number;
  timeoutExceeded: boolean;
  rounds: RoundRecord[];
  packets: StoredPacket[];
  delivery: Delivery[];
  confirmations: ShareConfirmation[];
  audit: { operation: string; event: string; at: string; detail?: unknown }[];
}

export type SynthesisDraft = Pick<SynthesisBody,
  'agreements' | 'minority_opinions' | 'reversal_conditions' | 'recommendation' | 'cited_materials'> & {
  reception_summary?: unknown;
  unverified_items?: unknown[];
  missing_records?: unknown[];
};

type Located = { meeting_id: string; round: Round; seat_id: string };
type Submission = Located & AnswerBody & { supersedes?: string | null };
export interface Operations {
  create_meeting: Partial<Omit<Setup, 'chair' | 'seats'>> & { topic: string; seats: SeatConfig[]; chair: ChairConfig };
  update_setup: SetupUpdate & { meeting_id: string };
  open_round: { meeting_id: string; round: 'R0' | 'R1'; deadline?: Deadline };
  submit_answer: Submission;
  transcribe_web_seat: Omit<Submission, 'claims'>;
  submit_flash: Located & { body: string; basis: string };
  submit_attest: { meeting_id: string; target_packet_id: string; method: 'verbatim_confirm';
    result: 'confirmed' | 'mismatch'; evidence: { method: 'verbatim_confirm'; target_packet_id: string; confirmer: string } };
  get_state: { meeting_id: string };
  get_packets: { meeting_id: string; caller_seat_id: string; round?: Round; view?: 'input' | 'oversight';
    ack_packet_ids?: string[]; delivery_epoch?: number };
  declare_absent: Located;
  waive_seat: Located & { reason_code: string; reason_note?: string };
  chair_gate: { meeting_id: string; result: 'pass' | 'fail'; rationale?: string; resolved_points?: string[];
    unresolved_points?: string[]; next_round_scope?: string[]; r2_deadline?: Deadline };
  synthesize: { meeting_id: string; body: SynthesisDraft };
  approve: { meeting_id: string; decision: 'approve' | 'reject' | 'reopen'; reopen_points?: string[] };
  get_quota: { meeting_id: string; seat_id: string };
  post_message: { meeting_id: string; body: { text: string } };
  confirm_share: { meeting_id: string } & ShareConfirmation;
}

export type Operation = keyof Operations;
export const answer = (record: StoredPacket): AnswerBody | undefined =>
  record.packet.header.kind === 'answer' || record.packet.header.kind === 'critique'
    ? record.packet.body as AnswerBody : undefined;
