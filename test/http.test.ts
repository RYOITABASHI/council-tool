import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { systemClock } from '../src/core/clock.js';
import { createCore } from '../src/core/index.js';
import { createConfiguredHttpServer } from '../src/http/server.js';
import { createConfiguredMcpServer } from '../src/mcp/server.js';
import type { Packet } from '../src/packet/index.js';

installXattrTestTransport();
guardStoreLinks();
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const principal = 'host:operator';
const authorization = 'Bearer test-council-token';
const unknownMeeting = '00000000-0000-0000-0000-000000000000';
const httpEnv = {
  COUNCIL_PRINCIPAL: principal,
  COUNCIL_HUMAN_PRINCIPALS: ` other , ${principal} , `,
  COUNCIL_HTTP_TOKEN: 'test-council-token',
};
const createdAt = '2026-01-01T00:00:00.000Z';
const secondCreatedAt = '2026-01-01T00:00:01.000Z';
const updatedAt = '2026-01-01T00:00:02.000Z';
const secondUpdatedAt = '2026-01-01T00:00:03.000Z';
let home: string;
let meetingId: string;
let secondMeetingId: string;
let server: Server;
let client: Client;
let mcp: ReturnType<typeof createConfiguredMcpServer>;
const runCli = vi.fn<(config: { kind: string }, prompt: string) => Promise<string>>();

// Socket-restricted sandboxes can still exercise Node's HTTP client and parser.
function connectOverStreams(server: Server): Duplex {
  function socketTo(peer: () => Duplex) {
    return new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        peer().push(chunk);
        done();
      },
      final(done) {
        peer().push(null);
        done();
      },
    });
  }
  const inbound: Duplex = socketTo(() => outbound);
  const outbound: Duplex = socketTo(() => inbound);
  server.emit('connection', inbound);
  return outbound;
}

function getResponse<Body = unknown>(path: string, token?: string, method = 'GET', streamServer?: Server, input?: unknown) {
  const payload = input === undefined ? undefined : JSON.stringify(input);
  return new Promise<{ status: number | undefined; body: Body }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', path, method,
      createConnection: () => connectOverStreams(streamServer ?? server),
      headers: {
        Connection: 'close',
        ...(token === undefined ? {} : { Authorization: token }),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      },
    }, async response => {
      try {
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, body: JSON.parse(body) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function clockAt(wall: () => string) {
  return {
    ...systemClock,
    now: () => ({ ...systemClock.now(), wall: BigInt(Date.parse(wall())) * 1_000_000n }),
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'council-http-'));
  let wall = createdAt;
  const core = createCore({
    home,
    isHuman: id => id === principal,
    clock: clockAt(() => wall),
  });
  try {
    ({ meeting_id: meetingId } = await core.create_meeting(principal, {
      topic: 'Facade test',
      chair: { principal: 'chair' },
      human_participants: [principal],
      seats: [{
        seat_id: 'reviewer', principal: 'reviewer', connection: 'cli',
        seat_specific_materials: [{ id: 'reviewer_notes' }],
      }],
    }));
    wall = secondCreatedAt;
    ({ meeting_id: secondMeetingId } = await core.create_meeting(principal, {
      topic: 'Another facade meeting',
      chair: { principal: 'chair' },
      human_participants: [principal],
      seats: [{ seat_id: 'observer', principal: 'observer', connection: 'cli' }],
    }));
    wall = updatedAt;
    await core.open_round('chair', { meeting_id: meetingId, round: 'R0' });
    await core.submit_answer('reviewer', {
      meeting_id: meetingId, round: 'R0', seat_id: 'reviewer', body: 'An answer',
    });
  } finally {
    core.close();
  }

  const env = { ...httpEnv, COUNCIL_HOME: home };
  mcp = createConfiguredMcpServer(env);
  client = new Client({ name: 'council-http-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);

  server = createConfiguredHttpServer(env, { runCli });
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await client?.close();
  await mcp?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

test('serves health without authentication', async () => {
  expect(await getResponse('/health')).toEqual({ status: 200, body: { ok: true } });
});

test('lists both meetings with their current state, newest activity first', async () => {
  const first = {
    meeting_id: meetingId, topic: 'Facade test', meeting_state: 'GATE',
    created_at: createdAt, updated_at: updatedAt, seat_ids: ['reviewer'],
  };
  const second = {
    meeting_id: secondMeetingId, topic: 'Another facade meeting', meeting_state: 'CREATED',
    created_at: secondCreatedAt, updated_at: secondCreatedAt, seat_ids: ['observer'],
  };
  expect(await getResponse('/meetings', authorization)).toEqual({
    status: 200, body: [first, second],
  });

  const core = createCore({ home, isHuman: id => id === principal, clock: clockAt(() => secondUpdatedAt) });
  try {
    await core.update_setup(principal, { meeting_id: secondMeetingId, meeting_timeout: 1000 });
  } finally {
    core.close();
  }
  expect(await getResponse('/meetings', authorization)).toEqual({
    status: 200, body: [{ ...second, updated_at: secondUpdatedAt }, first],
  });
});

test('skips a missing meeting revision even when it is missing at server startup', async () => {
  const manifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
  const revision = join(home, secondMeetingId, `${manifest.meetings[secondMeetingId]}.json`);
  const backup = revision + '.backup';
  await rename(revision, backup);
  let listServer: Server | undefined;
  try {
    listServer = createConfiguredHttpServer({ ...httpEnv, COUNCIL_HOME: home });
    expect(await getResponse('/meetings', authorization, 'GET', listServer)).toEqual({
      status: 200, body: [expect.objectContaining({ meeting_id: meetingId })],
    });
  } finally {
    const openedServer = listServer;
    if (openedServer) await new Promise<void>(resolve => openedServer.close(() => resolve()));
    await rename(backup, revision);
  }
});

test('returns the MCP state payload for a human oversight caller', async () => {
  const state = await client.callTool({
    name: 'council.get_state', arguments: { meeting_id: meetingId },
  });
  expect(state.isError).not.toBe(true);
  expect(state.structuredContent).toHaveProperty('seats.0.seat_specific_materials.0.id', 'reviewer_notes');
  expect(await getResponse(`/meetings/${meetingId}/state`, authorization))
    .toEqual({ status: 200, body: state.structuredContent });
});

test('returns the MCP oversight packet payload with packet state for all packets', async () => {
  const packets = await client.callTool({
    name: 'council.get_packets',
    arguments: { meeting_id: meetingId, view: 'oversight', caller_seat_id: 'human' },
  });
  expect(packets.isError).not.toBe(true);
  expect(packets.structuredContent).toHaveProperty('new_packets.length', 2);
  expect(packets.structuredContent).toHaveProperty('new_packets.1.packet_state.reception', 'received');
  expect(await getResponse(`/meetings/${meetingId}/packets?view=input&caller_seat_id=reviewer`, authorization))
    .toEqual({ status: 200, body: packets.structuredContent });
});

test.each([undefined, 'Bearer wrong-token'])('rejects invalid authorization %s', async token => {
  for (const path of ['/meetings', `/meetings/${meetingId}/state`]) {
    expect(await getResponse(path, token)).toEqual({ status: 401, body: { code: 'unauthorized' } });
  }
});

test.each(['state', 'packets'])('returns the core code for an unknown meeting on /%s', async route => {
  expect(await getResponse(`/meetings/${unknownMeeting}/${route}`, authorization))
    .toEqual({ status: 404, body: { code: 'unauthorized' } });
});

test('requires authentication before routing other paths', async () => {
  expect(await getResponse('/missing')).toEqual({ status: 401, body: { code: 'unauthorized' } });
  expect(await getResponse('/missing', authorization)).toEqual({ status: 404, body: { code: 'not_found' } });
});

test('rejects unsupported methods on read-only routes', async () => {
  expect(await getResponse('/health', undefined, 'POST')).toEqual({ status: 401, body: { code: 'unauthorized' } });
  expect(await getResponse(`/meetings/${meetingId}/state`, authorization, 'POST'))
    .toEqual({ status: 404, body: { code: 'not_found' } });
});

const synthesis = {
  agreements: ['Use a pilot'], minority_opinions: [], reversal_conditions: [],
  recommendation: 'Run a pilot first.', cited_materials: [], unverified_items: [], missing_records: [],
};
const post = <Body = unknown>(path: string, input: unknown = {}) =>
  getResponse<Body>(path, authorization, 'POST', undefined, input);
const get = (path: string) => getResponse(path, authorization);
const getPackets = (path: string) => getResponse<{ new_packets: { packet: Packet }[] }>(`${path}/packets`, authorization);
const codexSeat = { seat_id: 'reviewer', kind: 'codex-cli' };

async function createMeeting(seats = [codexSeat]) {
  const created = await post<{ meeting_id: string }>('/meetings', { topic: 'Should we run a pilot?', seats });
  expect(created).toEqual({ status: 201, body: { meeting_id: expect.any(String) } });
  return `/meetings/${created.body.meeting_id}`;
}

async function waitForPhase(path: string, phase: string) {
  return vi.waitFor(async () => {
    const response = await getResponse<{ detail: string | null }>(`${path}/runner`, authorization);
    expect(response).toEqual({
      status: 200, body: { phase, detail: phase === 'interrupted' ? expect.any(String) : null, updated_at: expect.any(String) },
    });
    return response.body;
  }, { timeout: 10_000 });
}

test.each([undefined, 'Bearer wrong-token'])('requires Bearer auth for every POST with token %j', async token => {
  for (const path of ['/meetings', ...['start', 'resume', 'mention', 'approve'].map(route => `/meetings/${meetingId}/${route}`)]) {
    expect(await getResponse(path, token, 'POST', undefined, {}))
      .toEqual({ status: 401, body: { code: 'unauthorized' } });
  }
  expect(await getResponse(`/meetings/${meetingId}/runner`, token))
    .toEqual({ status: 401, body: { code: 'unauthorized' } });
});

test.each([
  { topic: '', seats: [codexSeat] },
  { topic: 'Topic', seats: [{ seat_id: 'reviewer', kind: 'unknown' }] },
  { topic: 'Topic', seats: [] },
  { topic: 'Topic', seats: [codexSeat, codexSeat] },
])('rejects malformed create payload %j', async body => {
  expect(await post('/meetings', body)).toEqual({ status: 400, body: { code: 'invalid_argument' } });
});

test.each(['api', 'local'])('refuses %s seats with the pinned error', async kind => {
  expect(await post('/meetings', { topic: 'Topic', seats: [{ seat_id: 'reviewer', kind }] }))
    .toEqual({ status: 422, body: { code: 'seat_kind_unavailable' } });
});

test.each([['approve', 'APPROVED'], ['reject', 'REJECTED']])('can %s a pre-existing AWAITING_APPROVAL meeting', async (decision, state) => {
  const core = createCore({ home, isHuman: id => id === principal });
  let meeting_id: string;
  try {
    ({ meeting_id } = await core.create_meeting(principal, {
      topic: 'An externally prepared meeting', chair: { principal: 'chair' }, human_participants: [principal],
      seats: [{ seat_id: 'reviewer', principal: 'reviewer', connection: 'cli' }],
    }));
    for (const round of ['R0', 'R1']) {
      await core.open_round('chair', { meeting_id, round });
      await core.submit_answer('reviewer', { meeting_id, round, seat_id: 'reviewer', body: 'An answer' });
    }
    await core.chair_gate('chair', { meeting_id, result: 'pass' });
    await core.synthesize('chair', { meeting_id, body: synthesis });
  } finally {
    core.close();
  }
  const path = `/meetings/${meeting_id}`;
  expect((await get(`${path}/runner`)).body).toMatchObject({ phase: 'awaiting_approval' });
  expect(await post(`${path}/approve`, { decision })).toEqual({ status: 200, body: { meeting_state: state } });
  expect((await get(`${path}/runner`)).body).toMatchObject({ phase: 'done' });
});

test('rejects a mention while a round is open even without a host runner', async () => {
  const path = await createMeeting();
  const core = createCore({ home, isHuman: id => id === principal });
  try {
    await core.open_round(principal, { meeting_id: path.split('/').at(-1), round: 'R0' });
  } finally {
    core.close();
  }
  expect(await post(`${path}/mention`, { seat_id: 'reviewer', text: 'Please elaborate.' }))
    .toEqual({ status: 409, body: { code: 'invalid_state', detail: { meeting_state: 'OPEN' } } });
  expect((await getPackets(path)).body.new_packets).toHaveLength(1);
});

test('starts single-flight and records a directed round and superseding synthesis', async () => {
  runCli.mockReset();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  runCli.mockImplementation(async (_config, prompt) => {
    if (prompt.includes('席: reviewer') && prompt.includes('ラウンド: R0')) await blocked;
    if (prompt.startsWith('Chair gate')) return '{"result":"pass"}';
    if (prompt.startsWith('Chair synthesis')) return JSON.stringify(synthesis);
    return 'A stub seat answer.';
  });
  const path = await createMeeting([codexSeat, { seat_id: 'observer', kind: 'codex-cli' }]);
  expect((await get(`${path}/runner`)).body).toEqual({ phase: 'idle', detail: null, updated_at: expect.any(String) });
  try {
    const starts = await Promise.all([post(`${path}/start`), post(`${path}/start`)]);
    expect(starts).toEqual(expect.arrayContaining([
      { status: 202, body: { runner: { phase: 'running' } } },
      { status: 409, body: { code: 'runner_active' } },
    ]));
    expect((await get(`${path}/state`)).body).toMatchObject({ meeting_state: 'OPEN' });
    expect(await getResponse(`${path}/resume`, authorization, 'POST'))
      .toEqual({ status: 409, body: { code: 'runner_active' } });
    expect(await post(`${path}/mention`, { seat_id: 'observer', text: 'Too soon' }))
      .toEqual({ status: 409, body: { code: 'runner_active' } });
  } finally {
    release();
  }
  await waitForPhase(path, 'awaiting_approval');
  expect(runCli.mock.calls.map(([config]) => config.kind)).toEqual(Array(6).fill('codex'));
  const before = (await getPackets(path)).body;
  const first = before.new_packets.find(entry => entry.packet.header.kind === 'synthesis');
  expect(first).toBeDefined();
  runCli.mockClear();
  const text = 'What changes if the budget is cut?';
  expect(await post(`${path}/mention`, { seat_id: 'observer', text })).toEqual({
    status: 202, body: { runner: { phase: 'running', detail: null, updated_at: expect.any(String) } },
  });
  await waitForPhase(path, 'awaiting_approval');
  expect(runCli.mock.calls).toHaveLength(2);
  expect(runCli.mock.calls[0][1]).toContain('ラウンド: R2 / 席: observer');
  expect(runCli.mock.calls[0][1]).toContain(text);
  expect((await get(`${path}/state`)).body).toMatchObject({
    meeting_state: 'AWAITING_APPROVAL',
    reception_table: expect.arrayContaining([
      expect.objectContaining({ round: 'R2', seat_id: 'reviewer', state: 'waived' }),
      expect.objectContaining({ round: 'R2', seat_id: 'observer', state: 'received' }),
    ]),
  });
  const packets = (await getPackets(path)).body;
  expect(packets.new_packets).toEqual(expect.arrayContaining([
    expect.objectContaining({ packet: expect.objectContaining({
      header: expect.objectContaining({ kind: 'note' }), body: { text },
    }) }),
    expect.objectContaining({ packet: first?.packet, packet_state: expect.objectContaining({ version: 'superseded' }) }),
    expect.objectContaining({ packet: expect.objectContaining({
      header: expect.objectContaining({ kind: 'synthesis', supersedes: first?.packet.header.packet_id }),
    }) }),
  ]));
  expect((await post(`${path}/mention`, { seat_id: 'observer', text: 'One more question' })).status).toBe(202);
  await waitForPhase(path, 'awaiting_approval');
  expect((await get(`${path}/state`)).body).toMatchObject({
    round_states: [
      { round: 'R0', phase: 'frozen' }, { round: 'R1', phase: 'frozen' },
      { round: 'R2', phase: 'frozen' }, { round: 'R3', phase: 'frozen' },
    ],
  });
  expect(await post(`${path}/approve`, { decision: 'approve' }))
    .toEqual({ status: 200, body: { meeting_state: 'APPROVED' } });
}, 90_000);

test('preserves pending approval when the mentioned seat has exhausted its quota', async () => {
  const core = createCore({ home, isHuman: id => id === principal });
  let meeting_id: string;
  try {
    ({ meeting_id } = await core.create_meeting(principal, {
      topic: 'Meeting with a small seat quota', chair: { principal }, human_participants: [principal],
      seats: [{ seat_id: codexSeat.seat_id, principal, connection: 'cli', role: codexSeat.kind, quota: 2 }],
    }));
    for (const round of ['R0', 'R1']) {
      await core.open_round(principal, { meeting_id, round });
      await core.submit_answer(principal, { meeting_id, round, seat_id: codexSeat.seat_id, body: 'An answer' });
    }
    await core.chair_gate(principal, { meeting_id, result: 'pass' });
    await core.synthesize(principal, { meeting_id, body: synthesis });
  } finally {
    core.close();
  }
  const path = `/meetings/${meeting_id}`;
  expect(await post(`${path}/mention`, { seat_id: codexSeat.seat_id, text: 'Can you elaborate?' })).toEqual({
    status: 409, body: { code: 'invalid_state', detail: {
      meeting_state: 'AWAITING_APPROVAL', seat_id: codexSeat.seat_id, quota_exceeded: true,
    } },
  });
  expect((await getPackets(path)).body.new_packets.some(({ packet }) => packet.header.kind === 'note')).toBe(false);
  expect(await post(`${path}/approve`, { decision: 'approve' })).toEqual({ status: 200, body: { meeting_state: 'APPROVED' } });
});

test('runs a directed round from GATE for an optional seat without changing required quorum', async () => {
  const core = createCore({ home, isHuman: id => id === principal });
  let meeting_id: string;
  try {
    ({ meeting_id } = await core.create_meeting(principal, {
      topic: 'Optional seat follow-up', chair: { principal }, human_participants: [principal], quorum: 1,
      seats: [
        { seat_id: 'required', principal, connection: 'cli', role: codexSeat.kind },
        { seat_id: 'optional', principal, connection: 'cli', role: codexSeat.kind, optional: true },
      ],
    }));
    await core.open_round(principal, { meeting_id, round: 'R0' });
    await core.submit_answer(principal, { meeting_id, round: 'R0', seat_id: 'required', body: 'An answer' });
  } finally {
    core.close();
  }
  runCli.mockReset().mockImplementation(async (_config, prompt) =>
    prompt.startsWith('Chair synthesis') ? JSON.stringify(synthesis) : 'An optional answer.');
  const path = `/meetings/${meeting_id}`;
  expect((await post(`${path}/mention`, { seat_id: 'optional', text: 'Your thoughts?' })).status).toBe(202);
  await waitForPhase(path, 'awaiting_approval');
  expect(runCli.mock.calls).toHaveLength(2);
  expect((await getPackets(path)).body.new_packets).toEqual(expect.arrayContaining([
    expect.objectContaining({ packet: expect.objectContaining({
      header: expect.objectContaining({ kind: 'synthesis' }),
      body: expect.objectContaining({ reception_summary: expect.stringContaining('R1: 受領1/2・欠席0・免除1（quorum未達）') }),
    }) }),
  ]));
});

test('a chair gate can open R2 for a designated dispute', async () => {
  runCli.mockReset().mockImplementation(async (_config, prompt) => {
    if (prompt.startsWith('Chair gate')) {
      return JSON.stringify({ result: 'fail', unresolved_points: ['Budget limit'], next_round_scope: ['Estimate a budget limit'] });
    }
    if (prompt.startsWith('Chair synthesis')) return JSON.stringify(synthesis);
    return 'A stub seat answer about the budget limit.';
  });
  const path = await createMeeting();
  expect((await post(`${path}/start`)).status).toBe(202);
  await waitForPhase(path, 'awaiting_approval');
  expect((await get(`${path}/state`)).body).toMatchObject({
    round_states: [{ round: 'R0', phase: 'frozen' }, { round: 'R1', phase: 'frozen' }, { round: 'R2', phase: 'frozen' }],
  });
});

test.each(['gate', 'synthesis'])('retries malformed chair %s once and reports the interruption', async stage => {
  const prefix = `Chair ${stage}`;
  const malformed = stage === 'gate' ? '{"result":"fail"}' : JSON.stringify({ ...synthesis, missing_records: [false] });
  runCli.mockReset().mockImplementation(async (_config, prompt) => {
    if (prompt.startsWith(prefix)) return malformed;
    if (prompt.startsWith('Chair gate')) return '{"result":"pass"}';
    return 'A stub seat answer.';
  });
  const path = await createMeeting();
  expect((await post(`${path}/start`)).status).toBe(202);
  expect((await waitForPhase(path, 'interrupted')).detail).toContain(`invalid_chair_${stage}`);
  expect(runCli.mock.calls.filter(([, prompt]) => prompt.startsWith(prefix))).toHaveLength(2);
  expect((await getPackets(path)).body.new_packets).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ packet: expect.objectContaining({ header: expect.objectContaining({ kind: 'synthesis' }) }) }),
  ]));
});

test.each([undefined, ''])('refuses to start with HTTP token %j', token => {
  expect(() => createConfiguredHttpServer({
    COUNCIL_HOME: home, COUNCIL_PRINCIPAL: principal,
    ...(token === undefined ? {} : { COUNCIL_HTTP_TOKEN: token }),
  })).toThrow('COUNCIL_HTTP_TOKEN must be set');
});

test('threads operator CLI overrides through seat rounds and chair steps', async () => {
  const execute = vi.fn(async (_config: { kind: string }, prompt: string) => {
    if (prompt.startsWith('Chair gate')) return '{"result":"pass"}';
    if (prompt.startsWith('Chair synthesis')) return JSON.stringify(synthesis);
    return 'A stub seat answer.';
  });
  const configured = createConfiguredHttpServer({
    ...httpEnv,
    COUNCIL_HOME: home,
    COUNCIL_CODEX_COMMAND: 'codex_exec',
    COUNCIL_CODEX_ARGS: '--skip-git-repo-check -',
  }, { runCli: execute });

  try {
    const created = await getResponse<{ meeting_id: string }>('/meetings', authorization, 'POST', configured, {
      topic: 'Should we run a pilot?', seats: [codexSeat],
    });
    expect(created.status).toBe(201);
    const path = `/meetings/${created.body.meeting_id}`;
    expect((await getResponse(`${path}/start`, authorization, 'POST', configured, {})).status).toBe(202);
    await vi.waitFor(async () => {
      const { body } = await getResponse(`${path}/runner`, authorization, 'GET', configured);
      expect(body).toMatchObject({ phase: 'awaiting_approval' });
    }, { timeout: 10_000 });

    expect(execute.mock.calls.map(([, prompt]) => prompt)).toEqual(expect.arrayContaining([
      expect.stringContaining('ラウンド: R0 / 席: reviewer'),
      expect.stringMatching(/^Chair gate/),
      expect.stringMatching(/^Chair synthesis/),
    ]));
    for (const [config] of execute.mock.calls) {
      expect(config).toEqual({ kind: 'codex', command: 'codex_exec', args: ['--skip-git-repo-check', '-'] });
    }
  } finally {
    await new Promise<void>(resolve => configured.close(() => resolve()));
  }
});

test('threads bare CLI configs through seat rounds and chair steps', async () => {
  const execute = vi.fn(async (_config: { kind: string }, prompt: string) => {
    if (prompt.startsWith('Chair gate')) return '{"result":"pass"}';
    if (prompt.startsWith('Chair synthesis')) return JSON.stringify(synthesis);
    return 'A stub seat answer.';
  });
  const configured = createConfiguredHttpServer({
    ...httpEnv,
    COUNCIL_HOME: home,
  }, { runCli: execute });

  try {
    const created = await getResponse<{ meeting_id: string }>('/meetings', authorization, 'POST', configured, {
      topic: 'Should we run a pilot?', seats: [codexSeat],
    });
    expect(created.status).toBe(201);
    const path = `/meetings/${created.body.meeting_id}`;
    expect((await getResponse(`${path}/start`, authorization, 'POST', configured, {})).status).toBe(202);
    await vi.waitFor(async () => {
      const { body } = await getResponse(`${path}/runner`, authorization, 'GET', configured);
      expect(body).toMatchObject({ phase: 'awaiting_approval' });
    }, { timeout: 10_000 });

    expect(execute.mock.calls.map(([, prompt]) => prompt)).toEqual(expect.arrayContaining([
      expect.stringContaining('ラウンド: R0 / 席: reviewer'),
      expect.stringMatching(/^Chair gate/),
      expect.stringMatching(/^Chair synthesis/),
    ]));
    for (const [config] of execute.mock.calls) {
      expect(config).toEqual({ kind: 'codex' });
    }
  } finally {
    await new Promise<void>(resolve => configured.close(() => resolve()));
  }
});

test.each(['CREATED', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED'])('resume rejects %s', async meeting_state => {
  const core = createCore({ home, isHuman: id => id === principal });
  let id: string;
  try {
    ({ meeting_id: id } = await core.create_meeting(principal, {
      topic: 'Resume conflict', chair: { principal },
      seats: [{ seat_id: 'a', principal, connection: 'cli', role: 'codex-cli' }],
    }));
    if (meeting_state !== 'CREATED') {
      for (const round of ['R0', 'R1']) {
        await core.open_round(principal, { meeting_id: id, round });
        await core.submit_answer(principal, { meeting_id: id, round, seat_id: 'a', body: 'Answer' });
      }
      await core.chair_gate(principal, { meeting_id: id, result: 'pass' });
      await core.synthesize(principal, { meeting_id: id, body: synthesis });
      if (meeting_state === 'APPROVED' || meeting_state === 'REJECTED') {
        await core.approve(principal, { meeting_id: id, decision: meeting_state === 'APPROVED' ? 'approve' : 'reject' });
      }
    }
  } finally {
    core.close();
  }
  expect(await getResponse(`/meetings/${id}/resume`, authorization, 'POST')).toEqual({
    status: 409, body: { code: 'invalid_state', detail: { meeting_state } },
  });
});

test('resume uses the same masked response as a state read for an unknown meeting', async () => {
  const path = `/meetings/${unknownMeeting}`;
  const masked = await get(`${path}/state`);
  expect(masked.status).toBe(404);
  expect(await getResponse(`${path}/resume`, authorization, 'POST')).toEqual(masked);
});

test('resume validates pending bindings before invoking any driver', async () => {
  const core = createCore({ home, isHuman: id => id === principal });
  let id: string;
  try {
    ({ meeting_id: id } = await core.create_meeting(principal, {
      topic: 'Driver validation', chair: { principal },
      seats: [
        { seat_id: 'supported', principal, connection: 'cli', role: 'codex-cli' },
        { seat_id: 'unsupported', principal, connection: 'api' },
      ],
    }));
    await core.open_round(principal, { meeting_id: id, round: 'R0' });
  } finally {
    core.close();
  }
  runCli.mockClear();
  const path = `/meetings/${id}`;
  expect(await get(`${path}/runner`)).toMatchObject({ status: 200, body: { phase: 'interrupted' } });
  expect(await getResponse(`${path}/resume`, authorization, 'POST')).toEqual({
    status: 422, body: { code: 'seat_kind_unavailable' },
  });
  expect(runCli).not.toHaveBeenCalled();
});

test('startup reconciliation keeps a stranded meeting ready to resume over HTTP', async () => {
  const path = await createMeeting();
  const core = createCore({ home, isHuman: id => id === principal });
  try {
    await core.open_round(principal, { meeting_id: path.split('/').at(-1), round: 'R0' });
  } finally {
    core.close();
  }
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const execute = vi.fn(async (_config, prompt: string) => {
    if (prompt.includes('ラウンド: R0 / 席: reviewer')) await blocked;
    if (prompt.startsWith('Chair gate')) return '{"result":"pass"}';
    if (prompt.startsWith('Chair synthesis')) return JSON.stringify(synthesis);
    return 'A stub seat answer.';
  });
  const configured = createConfiguredHttpServer({ ...httpEnv, COUNCIL_HOME: home }, { runCli: execute });
  const readRunner = () => getResponse(`${path}/runner`, authorization, 'GET', configured);
  try {
    await configured.reconcile();
    expect(execute).not.toHaveBeenCalled();
    expect(await readRunner()).toMatchObject({ status: 200, body: { phase: 'interrupted' } });
    expect(await getResponse(`${path}/resume`, authorization, 'POST', configured)).toEqual({
      status: 202, body: { runner: { phase: 'running' } },
    });
    const running = await readRunner();
    expect(running.body).toMatchObject({ phase: 'running' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const attempts = execute.mock.calls.length;
    await configured.reconcile();
    expect(execute.mock.calls.length).toBe(attempts);
    expect(await readRunner()).toEqual(running);
    release();
    await vi.waitFor(async () => {
      expect(await readRunner()).toMatchObject({ status: 200, body: { phase: 'awaiting_approval' } });
    }, { timeout: 10_000 });
  } finally {
    release();
    await new Promise<void>(resolve => configured.close(() => resolve()));
  }
});
