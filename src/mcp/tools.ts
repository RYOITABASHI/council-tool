import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Operation } from '../core/index.js';
import { ROUNDS } from '../core/types.js';

type Schema = Record<string, unknown>;
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const positiveInteger = { type: 'integer', minimum: 1 };
const choices = (...values: string[]) => ({ type: 'string', enum: values });
const array = (items: Schema) => ({ type: 'array', items });
const strings = array(string);
const nullable = (schema: Schema) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, Schema>, ...required: string[]) => ({
  type: 'object' as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const id = { type: 'string', pattern: '^[A-Za-z0-9_-]+$' };
const meeting = { meeting_id: string };
const round = choices(...ROUNDS);
const seatTarget = { ...meeting, round, seat_id: string };
const seatTargetKeys = ['meeting_id', 'round', 'seat_id'];
const submission = { ...seatTarget, body: string, supersedes: nullable(string) };
const deadline = {
  oneOf: [
    object({
      kind: choices('absolute'),
      at: { type: 'string', format: 'date-time', pattern: '(Z|[+-][0-9]{2}:[0-9]{2})$' },
    }, 'kind', 'at'),
    object({ kind: choices('relative'), seconds: positiveInteger }, 'kind', 'seconds'),
  ],
};
const roundSettings = object(Object.fromEntries(ROUNDS.map(name => [
  name, object({ deadline: nullable(deadline), quorum: positiveInteger }),
])));
const chair = { principal: string, display_name: nullable(string), seat_id: id };
const seat = {
  seat_id: { ...id, not: { enum: ['chair', 'human'] } },
  principal: string,
  connection: choices('cli', 'api', 'web', 'local'),
  driver_principals: strings,
  quota: positiveInteger,
  optional: boolean,
  flash: boolean,
  role: string,
  shared_materials: strings,
  seat_specific_materials: array(object({ id }, 'id')),
  sharing_policy: {
    oneOf: [
      choices('no_share', 'share_with_confirmation', 'share_freely'),
      object({ kind: choices('share_with_seat'), seat_ids: array(id) }, 'kind', 'seat_ids'),
    ],
  },
  tool_access: choices('none', 'readonly_sandbox', 'full'),
};
const setup = {
  shared_materials: strings,
  human_participants: strings,
  round_settings: roundSettings,
  quorum: positiveInteger,
  meeting_timeout: positiveInteger,
};
const attestMethod = choices('verbatim_confirm');

export const inputSchemas = {
  create_meeting: object({
    ...setup, topic: string,
    seats: array(object(seat, 'seat_id', 'principal', 'connection')),
    chair: object(chair, 'principal'),
  }, 'topic', 'seats', 'chair'),
  open_round: object({ ...meeting, round: choices('R0', 'R1'), deadline }, 'meeting_id', 'round'),
  submit_answer: object({
    ...submission,
    claims: array(object({ statement: nullable(string), reversal_condition: nullable(string) })),
  }, ...seatTargetKeys, 'body'),
  submit_flash: object({ ...seatTarget, body: string, basis: string }, ...seatTargetKeys, 'body', 'basis'),
  transcribe_web_seat: object(submission, ...seatTargetKeys, 'body'),
  submit_attest: object({
    ...meeting,
    target_packet_id: string,
    method: attestMethod,
    result: choices('confirmed', 'mismatch'),
    evidence: object({
      method: attestMethod, confirmer: { type: 'string', minLength: 1 }, target_packet_id: string,
    }, 'method', 'confirmer', 'target_packet_id'),
  }, 'meeting_id', 'target_packet_id', 'method', 'result', 'evidence'),
  get_state: object(meeting, 'meeting_id'),
  get_packets: {
    ...object({
      ...meeting, caller_seat_id: string, round, ack_packet_ids: strings,
      delivery_epoch: { type: 'integer' }, view: choices('input', 'oversight'),
    }, 'meeting_id', 'caller_seat_id'),
    if: { required: ['view'], properties: { view: { const: 'oversight' } } },
    then: { not: { anyOf: [{ required: ['ack_packet_ids'] }, { required: ['delivery_epoch'] }] } },
    else: {
      if: { required: ['ack_packet_ids'], properties: { ack_packet_ids: { minItems: 1 } } },
      then: { required: ['delivery_epoch'] },
    },
  },
  declare_absent: object(seatTarget, ...seatTargetKeys),
  waive_seat: {
    ...object({
      ...seatTarget,
      reason_code: choices('seat_unavailable', 'quota_exceeded', 'duplicate_coverage', 'chair_judgment', 'other'),
      reason_note: string,
    }, ...seatTargetKeys, 'reason_code'),
    if: { properties: { reason_code: { const: 'other' } } },
    then: { required: ['reason_note'] },
  },
  chair_gate: {
    ...object({
      ...meeting, result: choices('pass', 'fail'), resolved_points: strings,
      unresolved_points: strings, next_round_scope: strings, r2_deadline: deadline, rationale: string,
    }, 'meeting_id', 'result'),
    if: { properties: { result: { const: 'fail' } } },
    then: {
      required: ['unresolved_points', 'next_round_scope'],
      properties: { unresolved_points: { minItems: 1 }, next_round_scope: { minItems: 1 } },
    },
    else: { not: { required: ['r2_deadline'] } },
  },
  synthesize: object({
    ...meeting,
    body: object({
      agreements: strings,
      minority_opinions: array(object({ seat_id: string, opinion: string }, 'seat_id', 'opinion')),
      unverified_items: {
        ...array({}),
        description: 'References to unverified answers. The core discards malformed entries and derives state.',
      },
      missing_records: {
        ...array({}),
        description: 'Declared omissions in unstructured answers. The core discards malformed entries.',
      },
      reception_summary: {},
      reversal_conditions: array(object({
        claim: string, condition: string, source_seat: string,
      }, 'claim', 'condition', 'source_seat')),
      recommendation: nullable(string),
      cited_materials: array(object({ material_ref: {
        type: 'string', pattern: '^(seat:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+|packet:[^:\\s]+)$',
      } }, 'material_ref')),
    }, 'agreements', 'minority_opinions', 'reversal_conditions', 'recommendation', 'cited_materials'),
  }, 'meeting_id', 'body'),
  approve: {
    ...object({
      ...meeting, decision: choices('approve', 'reject', 'reopen'), reopen_points: strings,
    }, 'meeting_id', 'decision'),
    if: { properties: { decision: { const: 'reopen' } } },
    then: { required: ['reopen_points'], properties: { reopen_points: { minItems: 1 } } },
  },
  get_quota: object({ ...meeting, seat_id: string }, 'meeting_id', 'seat_id'),
  confirm_share: {
    ...object({
      ...meeting,
      material_ref: { type: 'string', pattern: '^seat:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' },
      setup_version: { type: 'integer' },
      purpose: choices('share_with_seat', 'share_external', 'cite_in_synthesis'),
      to_seat_id: string,
    }, 'meeting_id', 'material_ref', 'setup_version', 'purpose'),
    if: { properties: { purpose: { const: 'share_with_seat' } } },
    then: { required: ['to_seat_id'] },
    else: { not: { required: ['to_seat_id'] } },
  },
  update_setup: object({
    ...meeting, ...setup, seats: array(object(seat, 'seat_id')), chair: object(chair),
  }, 'meeting_id'),
  post_message: object({ ...meeting, body: object({ text: string }, 'text') }, 'meeting_id', 'body'),
} satisfies Record<Operation, Tool['inputSchema']>;

export type CouncilOperation = keyof typeof inputSchemas;

export const councilTools: Tool[] = Object.entries(inputSchemas).map(([operation, inputSchema]) => ({
  name: `council.${operation}`,
  inputSchema,
}));
