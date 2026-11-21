import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCore } from '../core/index.js';
import { listMeetings } from './meeting-list.js';

export function createMeetingViews(env: NodeJS.ProcessEnv = process.env) {
  const principal = env.COUNCIL_PRINCIPAL;
  if (!principal?.trim()) throw new Error('COUNCIL_PRINCIPAL must be set');
  const home = resolve(env.COUNCIL_HOME ?? join(homedir(), '.council-tool'));
  const humans = new Set((env.COUNCIL_HUMAN_PRINCIPALS ?? '').split(',').map(id => id.trim()).filter(Boolean));
  const caller_seat_id = humans.has(principal) ? 'human' : 'chair';
  let core: ReturnType<typeof createCore> | undefined;
  // A failed full-store load must not prevent the independent summary read.
  const getCore = () => core ??= createCore({ home, isHuman: id => humans.has(id) });

  return {
    list: () => listMeetings(home),
    state: (meeting_id: string) => getCore().get_state(principal, { meeting_id }),
    packets: (meeting_id: string) => getCore().get_packets(principal, {
      meeting_id, caller_seat_id, view: 'oversight',
    }),
    close: () => core?.close(),
  };
}
