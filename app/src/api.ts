import type {
  ApproveDecision, CliSeatKinds, CreateMeetingRequest, CreateMeetingResponse, GetPacketsResponse, GetStateResponse,
  MeetingData, MeetingSummary, MentionRequest, PairingClaim, RunnerPhase, RunnerState,
} from './types';

export type FacadeErrorKind = 'unreachable' | 'unauthorized' | 'not_found' | 'http';

export class FacadeError extends Error {
  constructor(
    public readonly kind: FacadeErrorKind,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(status === undefined ? kind : `${kind} (${status})`);
    this.name = 'FacadeError';
  }
}

async function request<T>(
  url: string, token: string, signal: AbortSignal, isValid: (data: unknown) => boolean,
  body?: object,
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const options: RequestInit = { headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new FacadeError('unreachable');
  }

  if (!response.ok) {
    const data: unknown = await response.json().catch(() => undefined);
    const code = isObject(data) && typeof data.code === 'string' ? data.code : undefined;
    switch (response.status) {
      case 401:
      case 403:
        throw new FacadeError('unauthorized', response.status, code);
      case 404:
        throw new FacadeError('not_found', response.status, code);
      default:
        throw new FacadeError('http', response.status, code);
    }
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (signal.aborted || error instanceof TypeError) throw new FacadeError('unreachable');
    throw new FacadeError('http', response.status);
  }
  if (!isValid(data)) throw new FacadeError('http', response.status);
  return data as T;
}

export const facadeErrorMessages: Record<FacadeErrorKind, string> = {
  unreachable: 'サーバに接続できません。URLとネットワークを確認してください',
  unauthorized: 'トークンが無効です',
  not_found: '会議が見つかりません。会議IDを確認してください',
  http: '会議の読み込みに失敗しました',
};

export const facadeCodeMessages: Record<string, string> = {
  seat_kind_unavailable: 'API席・ローカル席はまだ利用できません',
  runner_active: 'すでに実行中です',
};

export function describeFacadeError(error: unknown): string {
  if (!(error instanceof FacadeError)) return facadeErrorMessages.http;
  if (error.code && Object.hasOwn(facadeCodeMessages, error.code)) {
    return facadeCodeMessages[error.code];
  }
  return facadeErrorMessages[error.kind];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasArrays(data: unknown, ...fields: string[]): boolean {
  return isObject(data) && fields.every(field => Array.isArray(data[field]));
}

function isMeetingState(data: unknown): boolean {
  return hasArrays(data, 'round_states', 'reception_table', 'seats');
}

function isMeetingSummary(item: unknown): boolean {
  return isObject(item) && typeof item.meeting_id === 'string' && typeof item.topic === 'string' &&
    typeof item.meeting_state === 'string' && typeof item.created_at === 'string' &&
    (item.updated_at == null || typeof item.updated_at === 'string') &&
    Array.isArray(item.seat_ids) && item.seat_ids.every(seat => typeof seat === 'string');
}

const runnerPhases = new Set<unknown>([
  'idle', 'running', 'awaiting_approval', 'error', 'done',
] satisfies RunnerPhase[]);

function isRunnerState(data: unknown): data is RunnerState {
  return isObject(data) && runnerPhases.has(data.phase) &&
    typeof data.updated_at === 'string' && (data.detail === null || typeof data.detail === 'string');
}

async function withDeadline<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function post<T>(url: string, token: string, body: object, isValid: (data: unknown) => boolean): Promise<T> {
  return withDeadline(signal => request<T>(url, token, signal, isValid, body));
}

function meetingsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/meetings`;
}

function meetingUrl(baseUrl: string, meetingId: string): string {
  return `${meetingsUrl(baseUrl)}/${encodeURIComponent(meetingId)}`;
}

export function fetchMeetings(baseUrl: string, token: string): Promise<MeetingSummary[]> {
  return withDeadline(signal => request<MeetingSummary[]>(
    meetingsUrl(baseUrl), token, signal, data => Array.isArray(data) && data.every(isMeetingSummary),
  ));
}

export function fetchMeeting(baseUrl: string, token: string, meetingId: string): Promise<MeetingData> {
  const base = meetingUrl(baseUrl, meetingId);
  return withDeadline(async signal => {
    const [state, packets] = await Promise.all([
      request<GetStateResponse>(`${base}/state`, token, signal, isMeetingState),
      request<GetPacketsResponse>(`${base}/packets`, token, signal, data => hasArrays(data, 'new_packets', 'superseded')),
    ]);
    return { state, packets };
  });
}

export function createMeeting(baseUrl: string, token: string, body: CreateMeetingRequest): Promise<CreateMeetingResponse> {
  return post<CreateMeetingResponse>(
    meetingsUrl(baseUrl), token, body, data => isObject(data) && typeof data.meeting_id === 'string',
  );
}

export async function startMeeting(baseUrl: string, token: string, meetingId: string): Promise<{ phase: string }> {
  const { runner } = await post<{ runner: { phase: string } }>(
    `${meetingUrl(baseUrl, meetingId)}/start`, token, {},
    data => isObject(data) && isObject(data.runner) && typeof data.runner.phase === 'string',
  );
  return runner;
}

export function fetchRunner(baseUrl: string, token: string, meetingId: string): Promise<RunnerState> {
  return withDeadline(signal => request<RunnerState>(
    `${meetingUrl(baseUrl, meetingId)}/runner`, token, signal, isRunnerState,
  ));
}

export async function postMention(
  baseUrl: string, token: string, meetingId: string, body: MentionRequest,
): Promise<RunnerState> {
  const result = await post<RunnerState | { runner: RunnerState }>(
    `${meetingUrl(baseUrl, meetingId)}/mention`, token, body,
    data => isRunnerState(data) || (isObject(data) && isRunnerState(data.runner)),
  );
  return isRunnerState(result) ? result : result.runner;
}

export async function postApprove(
  baseUrl: string, token: string, meetingId: string, decision: ApproveDecision,
): Promise<GetStateResponse> {
  const url = meetingUrl(baseUrl, meetingId);
  const terminalState = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  const result = await post<GetStateResponse | Pick<GetStateResponse, 'meeting_state'>>(
    `${url}/approve`, token, { decision },
    data => isMeetingState(data) ||
      (isObject(data) && Object.keys(data).length === 1 && data.meeting_state === terminalState),
  );
  if ('round_states' in result) return result;

  // Some facades acknowledge the decision with only its terminal state.
  return withDeadline(signal => request<GetStateResponse>(`${url}/state`, token, signal, isMeetingState));
}

/** A GET or POST with no credentials and a short deadline; resolves to the parsed JSON body. */
async function requestPublic(url: string, method: 'GET' | 'POST', timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method, signal: controller.signal });
    } catch {
      throw new FacadeError('unreachable');
    }
    if (!response.ok) {
      throw new FacadeError(response.status === 404 ? 'not_found' : 'http', response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new FacadeError(controller.signal.aborted ? 'unreachable' : 'http', response.status);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * GET /health's CLI seat-kind availability. Resolves to undefined when the host cannot be read or
 * does not report it (availability unknown — callers must not block on it).
 */
export async function fetchCliSeatKinds(baseUrl: string): Promise<CliSeatKinds | undefined> {
  try {
    const data = await requestPublic(`${baseUrl.trim().replace(/\/+$/, '')}/health`, 'GET', 5_000);
    const kinds = isObject(data) ? data.cli_seat_kinds : undefined;
    if (!isObject(kinds) || typeof kinds.codex !== 'boolean' || typeof kinds.claude !== 'boolean') return undefined;
    return { codex: kinds.codex, claude: kinds.claude };
  } catch {
    return undefined;
  }
}

/** The facade on this device, where the one-shot first-run pairing claim is answered. */
export const PAIRING_CLAIM_URL = 'http://127.0.0.1:8790/pairing/claim';

function isPairingClaim(data: unknown): data is PairingClaim {
  return isObject(data) && typeof data.token === 'string' && data.token.trim() !== '' &&
    typeof data.baseUrl === 'string' && /^https?:\/\/[^\s]+$/.test(data.baseUrl.trim());
}

/**
 * One POST /pairing/claim. Throws FacadeError: 'unreachable' when the facade is not (yet) up,
 * 'not_found' when it is up but not armed (or already claimed), 'http' otherwise.
 * The token in the result must never be logged or shown.
 */
export async function claimPairing(): Promise<PairingClaim> {
  const data = await requestPublic(PAIRING_CLAIM_URL, 'POST', 4_000);
  if (!isPairingClaim(data)) throw new FacadeError('http');
  return { baseUrl: data.baseUrl.trim(), token: data.token };
}
