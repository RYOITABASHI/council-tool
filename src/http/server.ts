import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERROR_CODES } from '../core/types.js';
import { createMeetingViews } from './meeting-views.js';

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function coreErrorCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return ERROR_CODES.find(code => code === error.code);
  }
}

export function createConfiguredHttpServer(env: NodeJS.ProcessEnv = process.env) {
  const token = env.COUNCIL_HTTP_TOKEN;
  if (!token?.trim()) throw new Error('COUNCIL_HTTP_TOKEN must be set');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const views = createMeetingViews(env);

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

    if (request.method !== 'GET') return sendJson(response, 404, { code: 'not_found' });

    try {
      if (path === '/meetings') return sendJson(response, 200, views.list());
      const route = /^\/meetings\/([^/]+)\/(state|packets)$/.exec(path);
      if (!route) return sendJson(response, 404, { code: 'not_found' });

      let meetingId: string;
      try {
        meetingId = decodeURIComponent(route[1]);
      } catch {
        return sendJson(response, 404, { code: 'not_found' });
      }
      if (meetingId.includes('/')) return sendJson(response, 404, { code: 'not_found' });

      const body = route[2] === 'state' ? await views.state(meetingId) : await views.packets(meetingId);
      return sendJson(response, 200, body);
    } catch (error) {
      const code = coreErrorCode(error);
      // Phase 1 uses unauthorized for both missing and inaccessible meetings.
      if (code === 'unauthorized' || code === 'not_found') {
        return sendJson(response, 404, { code });
      }
      return sendJson(response, 500, { code: code ?? 'internal_error' });
    }
  });
  server.once('close', views.close);
  return server;
}

async function main() {
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
