import summaries from './fixtures/meetings.json';
import livePackets from './fixtures/live/packets.json';
import liveState from './fixtures/live/state.json';
import proofPackets from './fixtures/proof/packets.json';
import proofState from './fixtures/proof/state.json';
import type { GetPacketsResponse, GetStateResponse, MeetingData, MeetingSummary } from './types';

export interface FixtureMeeting {
  summary: MeetingSummary;
  data: MeetingData;
}

export const FIXTURE_MEETING_ID = '97161c6b-8642-4a7e-bf78-4be1df5035bf';
const dataById = new Map<string, MeetingData>([
  [FIXTURE_MEETING_ID, {
    state: liveState as unknown as GetStateResponse,
    packets: livePackets as unknown as GetPacketsResponse,
  }],
  ['47445a40-d277-45c5-9349-eb7189de2ce3', {
    state: proofState as unknown as GetStateResponse,
    packets: proofPackets as unknown as GetPacketsResponse,
  }],
]);

const registry = new Map<string, FixtureMeeting>();
for (const summary of summaries as MeetingSummary[]) {
  const data = dataById.get(summary.meeting_id);
  if (data) registry.set(summary.meeting_id, { summary, data });
}

export function loadFixtureMeetings(): MeetingSummary[] {
  return Array.from(registry.values(), meeting => meeting.summary);
}

export function loadFixtureMeeting(meetingId: string): MeetingData | null {
  return registry.get(meetingId)?.data ?? null;
}
