import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { systemClock } from '../src/core/clock.js';
import { createCore } from '../src/core/index.js';
import { createConfiguredHttpServer } from '../src/http/server.js';
import { createConfiguredMcpServer } from '../src/mcp/server.js';

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
let port: number | undefined;
let client: Client;
let mcp: ReturnType<typeof createConfiguredMcpServer>;

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

function getResponse(path: string, token?: string, method = 'GET', streamServer?: Server) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', path, method,
      ...(streamServer || port === undefined
        ? { createConnection: () => connectOverStreams(streamServer ?? server) } : { port }),
      headers: { Connection: 'close', ...(token === undefined ? {} : { Authorization: token }) },
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
    req.end();
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

  server = createConfiguredHttpServer(env);
  try {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (address && typeof address === 'object') port = address.port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
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

test('rejects non-GET requests', async () => {
  expect(await getResponse('/health', undefined, 'POST')).toEqual({ status: 401, body: { code: 'unauthorized' } });
  expect(await getResponse('/meetings', authorization, 'POST')).toEqual({ status: 404, body: { code: 'not_found' } });
  expect(await getResponse(`/meetings/${meetingId}/state`, authorization, 'POST'))
    .toEqual({ status: 404, body: { code: 'not_found' } });
});

test.each([undefined, ''])('refuses to start with HTTP token %j', token => {
  expect(() => createConfiguredHttpServer({
    COUNCIL_HOME: home, COUNCIL_PRINCIPAL: principal,
    ...(token === undefined ? {} : { COUNCIL_HTTP_TOKEN: token }),
  })).toThrow('COUNCIL_HTTP_TOKEN must be set');
});
