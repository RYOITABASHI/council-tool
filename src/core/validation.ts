import { parseAbsolute } from './clock.js';
import type { Operation, Operations, Setup, SetupUpdate } from './model.js';
import { QUOTA_LIMITS, ROUNDS } from './types.js';
import type { CouncilError, ErrorCode, SeatConfig } from './types.js';

export function fail(code: ErrorCode, detail?: Record<string, unknown>): never {
  throw (detail === undefined && code !== 'invalid_state' ? { code } :
    { code, detail: detail ?? {} }) as CouncilError;
}
export function requireArgument(condition: unknown): asserts condition {
  if (!condition) fail('invalid_argument');
}

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
type Obj = Record<string, unknown>;
export const record = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const string = (v: unknown): v is string => typeof v === 'string' &&
  !/[\uD800-\uDFFF]/u.test(v); // JCS rejects lone surrogates.
const integer: Check = v => typeof v === 'number' && Number.isInteger(v);
const positive: Check = v => integer(v) && (v as number) > 0;
const boolean: Check = v => typeof v === 'boolean';
const oneOf = (...choices: string[]): Check => v => typeof v === 'string' && choices.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check): Check => v => Array.isArray(v) && [...v].every(check);
const strings = array(string);
const id: Check = v => string(v) && /^[A-Za-z0-9_-]+$/.test(v) && !/\s/u.test(v);
const seatId: Check = v => id(v) && v !== 'chair' && v !== 'human';
const roundId: Check = v => {
  if (typeof v !== 'string' || !v.startsWith('R')) return false;
  const index = Number(v.slice(1));
  return Number.isSafeInteger(index) && index >= 0 && v === `R${index}`;
};
const shape = (required: Shape, optional: Shape = {}): Check => v =>
  record(v) && Object.entries(required).every(([k, check]) => Object.hasOwn(v, k) && check(v[k])) &&
  Object.entries(v).every(([k, value]) => Object.hasOwn(required, k)
    || (Object.hasOwn(optional, k) && optional[k](value)));
const deadline: Check = v =>
  shape({ kind: oneOf('relative'), seconds: positive })(v) ||
  shape({ kind: oneOf('absolute'), at: v => string(v) && !!parseAbsolute(v) })(v);
const roundSetting = shape({}, { deadline: nullable(deadline), quorum: positive });
const chair = { principal: string, display_name: nullable(string), seat_id: seatId };
const seat = {
  principal: string, connection: oneOf('cli', 'api', 'web', 'local'), role: string,
  shared_materials: strings, seat_specific_materials: array(shape({ id })),
  sharing_policy: (v: unknown) => oneOf('no_share', 'share_with_confirmation', 'share_freely')(v)
    || shape({ kind: oneOf('share_with_seat'), seat_ids: array(id) })(v),
  tool_access: oneOf('none', 'readonly_sandbox', 'full'), driver_principals: strings,
  optional: boolean, flash: boolean, quota: positive,
};
const setup = {
  shared_materials: strings, human_participants: strings,
  round_settings: shape({}, { R0: roundSetting, R1: roundSetting, R2: roundSetting }),
  quorum: positive, meeting_timeout: positive,
};

export const seatReference = /^seat:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;
export const packetReference = /^packet:([^:\s]+)$/;
const material = (v: unknown): v is string =>
  string(v) && !/\s/u.test(v) && (seatReference.test(v) || packetReference.test(v));
const meeting = { meeting_id: string };
const located = { ...meeting, round: roundId, seat_id: string };
const sub = { ...located, body: string };
const optionalSubmission = { supersedes: nullable(string) };
const verbatim = oneOf('verbatim_confirm');
const synthesisBody = shape({
  agreements: strings,
  minority_opinions: array(shape({ seat_id: string, opinion: string })),
  reversal_conditions: array(shape({ claim: string, condition: string, source_seat: string })),
  recommendation: nullable(string),
  cited_materials: array(shape({ material_ref: material })),
}, { unverified_items: Array.isArray, missing_records: Array.isArray, reception_summary: () => true });
const checks: Record<Operation, Check> = {
  create_meeting: shape({ topic: string, chair: shape({ principal: string }, chair),
    seats: array(shape({ seat_id: seatId, principal: string, connection: seat.connection }, seat)) }, setup),
  update_setup: shape(meeting, { ...setup, chair: shape({}, chair), seats: array(shape({ seat_id: seatId }, seat)) }),
  open_round: v => shape({ ...meeting, round: oneOf('R0', 'R1') }, { deadline })(v) ||
    shape({ ...meeting, mention: shape({ seat_id: seatId, text: v => string(v) && !blank(v) }) }, { deadline })(v),
  submit_answer: shape(sub, { ...optionalSubmission, claims: array(shape({}, {
    statement: nullable(string), reversal_condition: nullable(string),
  })) }),
  transcribe_web_seat: shape(sub, optionalSubmission),
  submit_flash: shape({ ...sub, basis: string }),
  submit_attest: shape({ ...meeting, target_packet_id: string, method: verbatim, result: oneOf('confirmed', 'mismatch'),
    evidence: shape({ method: verbatim, confirmer: v => string(v) && v.length > 0, target_packet_id: string }) }),
  get_state: shape(meeting),
  get_packets: shape({ ...meeting, caller_seat_id: string }, { round: roundId,
    view: oneOf('input', 'oversight'), ack_packet_ids: strings, delivery_epoch: integer }),
  declare_absent: shape(located),
  waive_seat: shape({ ...located, reason_code: oneOf('seat_unavailable', 'quota_exceeded',
    'duplicate_coverage', 'chair_judgment', 'other') }, { reason_note: string }),
  chair_gate: shape({ ...meeting, result: oneOf('pass', 'fail') }, {
    rationale: string, resolved_points: strings, unresolved_points: strings, next_round_scope: strings, r2_deadline: deadline,
  }),
  synthesize: shape({ ...meeting, body: synthesisBody }),
  approve: shape({ ...meeting, decision: oneOf('approve', 'reject', 'reopen') }, { reopen_points: strings }),
  get_quota: shape({ ...meeting, seat_id: string }),
  post_message: shape({ ...meeting, body: shape({ text: string }) }),
  confirm_share: shape({ ...meeting, material_ref: v => material(v) && seatReference.test(v),
    setup_version: integer, purpose: oneOf('share_with_seat', 'share_external', 'cite_in_synthesis') }, { to_seat_id: string }),
};

function unique(values: string[]): boolean {
  return values.length === new Set(values).size;
}

export function validate<N extends Operation>(name: N, value: unknown): Operations[N] {
  requireArgument(Object.hasOwn(checks, name) && checks[name](value));
  const args = value as Operations[N];
  if (name === 'create_meeting' || name === 'update_setup') {
    const input = args as Operations['create_meeting'] | SetupUpdate;
    requireArgument(unique(input.seats?.map(s => s.seat_id) ?? []));
    for (const s of input.seats ?? []) {
      requireArgument(unique(s.seat_specific_materials?.map(m => m.id) ?? []));
      if (s.connection && s.quota !== undefined) requireArgument(s.quota <= QUOTA_LIMITS[s.connection].max);
    }
    if (name === 'create_meeting') mergeSetup(args as Operations['create_meeting']);
  }
  if (name === 'get_packets') {
    const a = args as Operations['get_packets'];
    requireArgument(a.view === 'oversight' ? a.ack_packet_ids === undefined && a.delivery_epoch === undefined
      : !a.ack_packet_ids?.length || a.delivery_epoch !== undefined);
  }
  if (name === 'submit_attest') {
    const a = args as Operations['submit_attest'];
    requireArgument(a.target_packet_id === a.evidence.target_packet_id);
  }
  if (name === 'waive_seat') {
    const a = args as Operations['waive_seat'];
    requireArgument(a.reason_code !== 'other' || (a.reason_note !== undefined && !blank(a.reason_note)));
  }
  if (name === 'confirm_share') {
    const a = args as Operations['confirm_share'];
    requireArgument((a.purpose === 'share_with_seat') === (a.to_seat_id !== undefined));
  }
  if (name === 'chair_gate') {
    const a = args as Operations['chair_gate'];
    requireArgument(a.result === 'pass' ? a.r2_deadline === undefined :
      a.unresolved_points?.length && a.next_round_scope?.length);
  }
  if (name === 'approve') {
    const a = args as Operations['approve'];
    requireArgument(a.decision !== 'reopen' || a.reopen_points?.length);
  }
  return args;
}

export const blank = (v: string | null | undefined): boolean => v == null || /^\p{White_Space}*$/u.test(v);

export function mergeSetup(args: SetupUpdate, old?: Setup): Setup {
  const chair = { ...old?.chair, ...args.chair };
  requireArgument(chair.principal !== undefined);
  const previous = old?.seats ?? [];
  const updates = args.seats ?? [];
  const existing = (id: string) => previous.find(s => s.seat_id === id);
  const update = (id: string) => updates.find(s => s.seat_id === id);
  const ordered = previous.every(s => update(s.seat_id)) ? updates :
    [...previous, ...updates.filter(s => !existing(s.seat_id))];
  const seats = ordered.map(({ seat_id }) => {
    const item = { ...existing(seat_id), ...update(seat_id) };
    requireArgument(item.principal !== undefined && item.connection !== undefined);
    const limit = QUOTA_LIMITS[item.connection];
    const quota = item.quota ?? limit.default;
    requireArgument(quota <= limit.max);
    return { ...item, quota } as SeatConfig & { quota: number };
  });
  const ids = new Set(seats.map(s => s.seat_id));
  for (const s of seats) {
    const policy = s.sharing_policy;
    if (typeof policy === 'object') requireArgument(policy.seat_ids.every(id => ids.has(id)));
  }
  if (chair.seat_id !== undefined) {
    requireArgument(seats.some(s => s.seat_id === chair.seat_id && s.principal === chair.principal));
  }
  const round_settings = { ...old?.round_settings };
  for (const round of ROUNDS) {
    if (args.round_settings?.[round]) round_settings[round] = {
      ...round_settings[round], ...args.round_settings[round],
    };
  }
  const quorum = args.quorum ?? old?.quorum;
  for (const count of [quorum, ...Object.values(round_settings).map(r => r?.quorum)]) {
    requireArgument(count === undefined || count <= seats.length);
  }
  return {
    chair: { ...chair, principal: chair.principal }, seats, round_settings,
    shared_materials: args.shared_materials ?? old?.shared_materials ?? [],
    human_participants: args.human_participants ?? old?.human_participants ?? [],
    meeting_timeout: args.meeting_timeout ?? old?.meeting_timeout ?? 259200,
    ...(quorum === undefined ? {} : { quorum }),
  };
}
