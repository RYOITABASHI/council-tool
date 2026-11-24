import { guardStoreLinks, installXattrTestTransport } from '../store-test-platform.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import type { MeetingState, Round } from '../../src/core/types.js';
import { createMcpToolCaller, getSeatInput, runCliSeat } from '../../src/drivers/index.js';
import { handcarryWebSeat } from '../../src/drivers/web-handcarry.js';
import { createConfiguredMcpServer, createMcpServer } from '../../src/mcp/server.js';

installXattrTestTransport();
guardStoreLinks();

const cliSeats = [
  { seat_id: 'codex', kind: 'codex' },
  { seat_id: 'claude', kind: 'claude' },
  { seat_id: 'agy', kind: 'antigravity' },
] as const;
const operator = 'human:operator';
const driver = 'driver:host';
const webSeat = { seat_id: 'web', principal: 'agent:web', connection: 'web', driver_principals: [driver] };
const seats = [
  ...cliSeats.map(({ seat_id }) => ({ seat_id, principal: `agent:${seat_id}`, connection: 'cli', driver_principals: [driver] })),
  webSeat,
];

const stub = `
  const fs = require('node:fs');
  const prompt = fs.readFileSync(0, 'utf8');
  if (!prompt.includes(process.argv[1])) process.exit(9);
  fs.writeSync(1, process.argv[2]);
`;
const answer = {
  body: '小規模な試行を承認します。',
  claims: [{ statement: '試行を開始する', reversal_condition: '費用が上限を超える' }],
};

async function connect(server: Server, cleanup: (() => Promise<void>)[]) {
  const client = new Client({ name: 'council-e2e', version: '1.0.0' });
  cleanup.push(() => server.close(), () => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return createMcpToolCaller(client);
}

test('MCP sends a CLI answer as the authenticated driver principal', async () => {
  const cleanup: (() => Promise<void>)[] = [];
  const assignment = { meeting_id: 'meeting', round: 'R0', seat_id: 'codex', prompt: '試行について' } as const;
  try {
    const call = await connect(createMcpServer((operation, args, principal) => {
      expect(operation).toBe('submit_answer');
      expect(principal).toBe(driver);
      expect(args).toEqual({ meeting_id: 'meeting', round: 'R0', seat_id: 'codex', ...answer });
      return { status: 'ok', packet_id: 'stub-answer' };
    }, driver), cleanup);
    await expect(runCliSeat(assignment, {
      kind: 'codex', command: process.execPath,
      args: ['-e', stub, assignment.prompt, JSON.stringify(answer)],
    }, call)).resolves.toMatchObject({ packet_id: 'stub-answer' });
  } finally {
    for (const close of cleanup.reverse()) await close();
  }
});

test('approves a meeting through MCP with three CLI seats and an attested Web seat', async () => {
  const home = await mkdtemp(join(tmpdir(), 'council-e2e-'));
  const cleanup: (() => Promise<void>)[] = [() => rm(home, { recursive: true, force: true })];
  try {
    const chair = await connect(createConfiguredMcpServer({
      COUNCIL_HOME: home, COUNCIL_PRINCIPAL: operator, COUNCIL_HUMAN_PRINCIPALS: ` other:human, ${operator} `,
    }), cleanup);
    const submit = await connect(createConfiguredMcpServer({
      COUNCIL_HOME: home, COUNCIL_PRINCIPAL: driver,
    }), cleanup);

    const created = await chair('council.create_meeting', {
      topic: '試行を開始するか', chair: { principal: operator }, human_participants: [operator, driver],
      seats: seats.map(seat => seat.seat_id === 'codex' ? { ...seat, seat_specific_materials: [{ id: 'memo' }] } : seat),
    });
    expect(created.status).toBe('ok');
    expect(typeof created.meeting_id).toBe('string');
    const meeting_id = created.meeting_id as string;
    const meeting = { meeting_id };
    const state = () => chair('council.get_state', meeting);
    async function expectState(meeting_state: MeetingState, rounds: [Round, 'open' | 'frozen'][]) {
      const actual = await state();
      expect(actual.meeting_state).toBe(meeting_state);
      expect(actual.round_states).toMatchObject(rounds.map(([round, phase]) => ({ round, phase })));
      return actual;
    }

    await expectState('CREATED', []);
    const confirmation = {
      ...meeting, setup_version: 1, material_ref: 'seat:codex:memo', purpose: 'cite_in_synthesis',
    };
    await expect(submit('council.confirm_share', confirmation)).rejects.toThrow(
      'council.confirm_share: {"code":"unauthorized"}',
    );
    await expect(chair('council.confirm_share', confirmation)).resolves.toMatchObject({ status: 'ok' });
    await Promise.all([
      chair('council.post_message', { ...meeting, body: { text: 'chair note' } }),
      submit('council.get_packets', { ...meeting, caller_seat_id: 'codex' }),
    ]);
    const packets = await submit('council.get_packets', { ...meeting, caller_seat_id: 'codex' });
    expect(packets.new_packets).toEqual(expect.arrayContaining([
      expect.objectContaining({ header: expect.objectContaining({ kind: 'note' }), body: { text: 'chair note' } }),
    ]));
    for (const round of ['R0', 'R1'] as const) {
      const history: [Round, 'frozen'][] = round === 'R0' ? [] : [['R0', 'frozen']];
      await chair('council.open_round', { ...meeting, round });
      const opened = await expectState('OPEN', [...history, [round, 'open']]);
      expect(opened.reception_table).toEqual(expect.arrayContaining(
        seats.map(({ seat_id }) => expect.objectContaining({ seat_id, round, state: 'pending' })),
      ));

      const packetIds = new Map<string, unknown>();
      for (const { seat_id, kind } of cliSeats) {
        const assignment = { ...meeting, round, seat_id };
        const input = await getSeatInput(assignment, submit);
        if (round === 'R0') {
          expect(input.packets).toEqual(expect.arrayContaining([
            expect.objectContaining({ header: expect.objectContaining({ kind: 'agenda' }) }),
          ]));
        } else {
          expect(input.packets).toEqual(expect.arrayContaining([
            expect.objectContaining({ header: expect.objectContaining({ kind: 'answer', round: 'R0', seat_id: 'web' }) }),
          ]));
        }
        const submitted = await runCliSeat({ ...assignment, prompt: input.prompt }, {
          kind, command: process.execPath,
          args: ['-e', stub, `ラウンド: ${round} / 席: ${seat_id}`, JSON.stringify(answer)],
        }, submit);
        expect(submitted).toMatchObject({ status: 'ok', packet_id: expect.any(String), packet_sha: expect.any(String) });
        packetIds.set(seat_id, submitted.packet_id);
        await input.acknowledge();
      }

      const assignment = { ...meeting, round, seat_id: webSeat.seat_id };
      const input = await getSeatInput(assignment, submit);
      const pasted = 'Web 席も試行に賛成です。\n';
      let displayed = '';
      const output = new Writable({
        write(chunk, _encoding, done) { displayed += chunk.toString(); done(); },
      });
      const transcription = await handcarryWebSeat(
        { ...assignment, prompt: input.prompt }, submit, Readable.from([pasted]), output,
      );
      expect(displayed).toContain(input.prompt);
      expect(transcription).toMatchObject({ status: 'ok', attest_required: true, packet_id: expect.any(String) });
      await input.acknowledge();
      const target_packet_id = transcription.packet_id;
      packetIds.set(webSeat.seat_id, target_packet_id);

      const pending = await expectState('OPEN', [...history, [round, 'open']]);
      expect(pending.reception_table).toEqual(expect.arrayContaining([
        expect.objectContaining({ round, seat_id: webSeat.seat_id, state: 'transcribed_pending_attest', current_packet_id: target_packet_id }),
      ]));
      const method = 'verbatim_confirm';
      await expect(chair('council.submit_attest', {
        ...meeting, target_packet_id, method, result: 'confirmed',
        evidence: { method, confirmer: operator, target_packet_id },
      })).resolves.toMatchObject({ status: 'ok', verified_result: 'confirmed' });

      const frozen = await expectState('GATE', [...history, [round, 'frozen']]);
      expect(frozen.reception_table).toEqual(expect.arrayContaining(
        [...packetIds].map(([seat_id, current_packet_id]) => expect.objectContaining({
          round, seat_id, current_packet_id, state: 'received',
        })),
      ));
    }

    const rounds = [['R0', 'frozen'], ['R1', 'frozen']] satisfies [Round, 'frozen'][];
    await chair('council.chair_gate', { ...meeting, result: 'pass', resolved_points: ['試行を開始する'] });
    await expectState('SYNTHESIZING', rounds);
    const synthesized = await chair('council.synthesize', {
      ...meeting, body: {
        agreements: ['試行を開始する'], minority_opinions: [],
        reversal_conditions: [{ claim: '試行を開始する', condition: '費用が上限を超える', source_seat: 'codex' }],
        recommendation: answer.body, cited_materials: [],
        unverified_items: [null], missing_records: [false], reception_summary: 'ignore this',
      },
    });
    expect(synthesized.synthesis_packet).toMatchObject({ body: {
      unverified_items: [], declared_missing_records: [], reception_summary: expect.stringContaining('R0: 受領4/4'),
    } });
    await expectState('AWAITING_APPROVAL', rounds);
    await expect(submit('council.approve', { ...meeting, decision: 'approve' })).rejects.toThrow(
      'council.approve: {"code":"unauthorized"}',
    );
    await chair('council.approve', { ...meeting, decision: 'approve' });
    await expectState('APPROVED', rounds);
  } finally {
    for (const close of cleanup.reverse()) await close();
  }
}, 90_000);
