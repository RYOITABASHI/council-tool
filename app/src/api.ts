import type { GetPacketsResponse, GetStateResponse, MeetingData, MeetingSummary } from './types';

export type FacadeErrorKind = 'unreachable' | 'unauthorized' | 'not_found' | 'http';

export class FacadeError extends Error {
  constructor(public readonly kind: FacadeErrorKind, public readonly status?: number) {
    super(status === undefined ? kind : `${kind} (${status})`);
    this.name = 'FacadeError';
  }
}

async function read<T>(
  url: string, token: string, signal: AbortSignal, isValid: (data: unknown) => boolean,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  } catch {
    throw new FacadeError('unreachable');
  }

  if (!response.ok) {
    switch (response.status) {
      case 401:
      case 403:
        throw new FacadeError('unauthorized', response.status);
      case 404:
        throw new FacadeError('not_found', response.status);
      default:
        throw new FacadeError('http', response.status);
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

function hasArrays(data: unknown, ...fields: string[]): boolean {
  return data !== null && typeof data === 'object' &&
    fields.every(field => Array.isArray((data as Record<string, unknown>)[field]));
}

function isMeetingSummary(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.meeting_id === 'string' && typeof item.topic === 'string' &&
    typeof item.meeting_state === 'string' && typeof item.created_at === 'string' &&
    (item.updated_at == null || typeof item.updated_at === 'string') &&
    Array.isArray(item.seat_ids) && item.seat_ids.every(seat => typeof seat === 'string');
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

function meetingsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/meetings`;
}

export function fetchMeetings(baseUrl: string, token: string): Promise<MeetingSummary[]> {
  return withDeadline(signal => read<MeetingSummary[]>(
    meetingsUrl(baseUrl), token, signal, data => Array.isArray(data) && data.every(isMeetingSummary),
  ));
}

export function fetchMeeting(baseUrl: string, token: string, meetingId: string): Promise<MeetingData> {
  const base = `${meetingsUrl(baseUrl)}/${encodeURIComponent(meetingId)}`;
  return withDeadline(async signal => {
    const [state, packets] = await Promise.all([
      read<GetStateResponse>(`${base}/state`, token, signal, data => hasArrays(data, 'round_states', 'reception_table', 'seats')),
      read<GetPacketsResponse>(`${base}/packets`, token, signal, data => hasArrays(data, 'new_packets', 'superseded')),
    ]);
    return { state, packets };
  });
}
