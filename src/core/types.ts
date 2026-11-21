// PRODUCT.md §2.1–2.2, §3
export type SeatConnection = 'cli' | 'api' | 'web' | 'local';

// PRODUCT.md §2.2
export type SharingPolicy =
  | 'no_share'
  | 'share_with_confirmation'
  | 'share_freely'
  | { kind: 'share_with_seat'; seat_ids: string[] };

// PRODUCT.md §2.2–3, PROTOCOL.md §8.1 and §9
export interface SeatConfig {
  seat_id: string;
  principal: string;
  connection: SeatConnection;
  role?: string;
  shared_materials?: string[];
  seat_specific_materials?: { id: string }[];
  sharing_policy?: SharingPolicy;
  tool_access?: 'none' | 'readonly_sandbox' | 'full';
  driver_principals?: string[];
  optional?: boolean;
  flash?: boolean;
  quota?: number;
}

// PRODUCT.md §3, PROTOCOL.md §9
export type StoredSeatConfig = SeatConfig & { quota: number };

// PROTOCOL.md §9, PRODUCT.md §3
const nonWebQuota = { default: 10, max: 20 } as const;
export const QUOTA_LIMITS = {
  cli: nonWebQuota,
  api: nonWebQuota,
  web: { default: 4, max: 6 },
  local: nonWebQuota,
} as const satisfies Record<SeatConnection, { default: number; max: number }>;

// PROTOCOL.md §1.2 and §2
export const ROUNDS = ['R0', 'R1', 'R2'] as const;
// PROTOCOL.md §1.2 and §2
export type Round = (typeof ROUNDS)[number];

// PROTOCOL.md §1.2 (BARRIER is an internal transition marker)
export const MEETING_STATES = [
  'CREATED', 'OPEN', 'BARRIER', 'GATE', 'SYNTHESIZING',
  'AWAITING_APPROVAL', 'APPROVED', 'REJECTED',
] as const;
// PROTOCOL.md §1.2
export type MeetingState = (typeof MEETING_STATES)[number];

// PROTOCOL.md §1.2
export interface RoundState {
  round: Round;
  phase: 'open' | 'frozen';
  opened_at: string;
  deadline_at: string | null;
  quorum: number | null;
}

// PROTOCOL.md §4
export const RECEPTION_STATES = [
  'pending', 'transcribed_pending_attest', 'received', 'absent', 'waived',
] as const;
// PROTOCOL.md §4
export type ReceptionState = (typeof RECEPTION_STATES)[number];

// PROTOCOL.md §4.3, PRODUCT.md §3
export const ERROR_CODES = [
  'invalid_argument', 'unauthorized', 'not_found', 'invalid_state',
] as const;
// PROTOCOL.md §4.3, PRODUCT.md §3
export type ErrorCode = (typeof ERROR_CODES)[number];

// PRODUCT.md §3, PROTOCOL.md §4.3
export type CouncilError =
  | { code: 'invalid_state'; detail: Record<string, unknown> }
  | { code: Exclude<ErrorCode, 'invalid_state'>; detail?: unknown };

// PROTOCOL.md §4.3
export const INSPECTION_STAGES = {
  format: 0,
  authorization: 1,
  argumentValidation: 2,
  referenceExistence: 3,
  state: 4,
} as const;
// PROTOCOL.md §4.3
export type InspectionStage = (typeof INSPECTION_STAGES)[keyof typeof INSPECTION_STAGES];
