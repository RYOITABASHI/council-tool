import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blank, record, requireArgument, validate } from '../core/validation.js';
import type { runCli } from '../drivers/index.js';
import { assertCliCommandsResolvable, resolveCliConfigs } from './cli-config.js';
import { HostRunner, isCliSeatKind } from './host-runner.js';
import { createMeetingViews } from './meeting-views.js';

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

const errorStatuses = {
  invalid_argument: 400,
  // The core uses unauthorized for both missing and inaccessible meetings.
  unauthorized: 404,
  not_found: 404,
  invalid_state: 409,
  runner_active: 409,
  seat_kind_unavailable: 422,
} as const;

async function readJson(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  if (allowEmpty && chunks.length === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw { code: 'invalid_argument' };
  }
  requireArgument(record(body));
  return body;
}

function createArgs(body: Record<string, unknown>, principal: string) {
  const { topic, seats } = body;
  requireArgument(Object.keys(body).length === 2 && typeof topic === 'string' && !blank(topic) &&
    Array.isArray(seats) && seats.length > 0);
  const configuredSeats = seats.map(seat => {
    requireArgument(record(seat) && Object.keys(seat).length === 2 && typeof seat.seat_id === 'string');
    const { seat_id, kind } = seat;
    requireArgument(isCliSeatKind(kind) || kind === 'api' || kind === 'local');
    return {
      seat_id, principal: `agent:${seat_id}`, driver_principals: [principal],
      connection: isCliSeatKind(kind) ? 'cli' : kind, role: kind,
    };
  });
  const args = validate('create_meeting', {
    topic, chair: { principal }, human_participants: [principal], seats: configuredSeats,
  });
  if (configuredSeats.some(seat => seat.connection !== 'cli')) throw { code: 'seat_kind_unavailable' };
  return args;
}

export function createConfiguredHttpServer(env: NodeJS.ProcessEnv = process.env, options: { runCli?: typeof runCli } = {}) {
  const token = env.COUNCIL_HTTP_TOKEN;
  if (!token?.trim()) throw new Error('COUNCIL_HTTP_TOKEN must be set');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const views = createMeetingViews(env);
  const runner = new HostRunner(views.getCore, views.principal, options.runCli, resolveCliConfigs(env));

  const server = createServer(async (request, response) => {
    const path = request.url?.split('?', 1)[0] ?? '';
    if (request.method === 'GET' && path === '/health') {
      return sendJson(response, 200, { ok: true });
    }

    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(response, 401, { code: 'unauthorized' });
    }

    try {
      if (path === '/meetings') {
        if (request.method === 'GET') return sendJson(response, 200, views.list());
        if (request.method === 'POST') {
          const args = createArgs(await readJson(request), views.principal);
          const { meeting_id } = await views.getCore().create_meeting(views.principal, args);
          return sendJson(response, 201, { meeting_id });
        }
      }
      const route = /^\/meetings\/([^/]+)\/(state|packets|runner|start|mention|approve)$/.exec(path);
      if (!route) return sendJson(response, 404, { code: 'not_found' });

      let meetingId: string;
      try {
        meetingId = decodeURIComponent(route[1]);
      } catch {
        return sendJson(response, 404, { code: 'not_found' });
      }
      if (meetingId.includes('/')) return sendJson(response, 404, { code: 'not_found' });

      const action = route[2];
      if (request.method === 'GET') {
        if (action === 'state') return sendJson(response, 200, await views.state(meetingId));
        if (action === 'packets') return sendJson(response, 200, await views.packets(meetingId));
        if (action === 'runner') return sendJson(response, 200, await runner.status(meetingId));
      }
      if (request.method === 'POST') {
        if (action === 'start') {
          requireArgument(Object.keys(await readJson(request, true)).length === 0);
          const { phase } = await runner.start(meetingId);
          return sendJson(response, 202, { runner: { phase } });
        }
        if (action === 'mention') {
          const body = await readJson(request);
          const args = validate('open_round', { meeting_id: meetingId, mention: body });
          requireArgument('mention' in args);
          return sendJson(response, 202, { runner: await runner.mention(meetingId, args.mention) });
        }
        if (action === 'approve') {
          const body = await readJson(request);
          const { decision } = body;
          requireArgument(Object.keys(body).length === 1 && (decision === 'approve' || decision === 'reject'));
          const { meeting_state } = await views.getCore().approve(views.principal, { meeting_id: meetingId, decision });
          return sendJson(response, 200, { meeting_state });
        }
      }
      return sendJson(response, 404, { code: 'not_found' });
    } catch (error) {
      if (record(error) && typeof error.code === 'string' && Object.hasOwn(errorStatuses, error.code)) {
        const { code, detail } = error;
        return sendJson(response, errorStatuses[code as keyof typeof errorStatuses],
          { code, ...(detail === undefined ? {} : { detail }) });
      }
      return sendJson(response, 500, { code: 'internal_error' });
    }
  });
  server.once('close', views.close);
  return server;
}

async function main() {
  assertCliCommandsResolvable(process.env, resolveCliConfigs(process.env));
  const server = createConfiguredHttpServer();
  const host = process.env.COUNCIL_HTTP_HOST || '127.0.0.1';
  const port = Number(process.env.COUNCIL_HTTP_PORT || 8790);
  try {
    server.listen(port, host);
    await once(server, 'listening');
  } catch (error) {
    server.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
