import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import {
  LEGACY_PAIRING_RECORD_FILE, PAIRING_RECORD_DIR, isLoopbackAddress, isLoopbackHostHeader, pairingBaseUrl, tokenGeneration,
} from '../src/http/pairing.js';
import { createConfiguredHttpServer } from '../src/http/server.js';
import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';

installXattrTestTransport();
guardStoreLinks();
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const token = 'pairing-test-token-value';
const baseEnv = {
  COUNCIL_PRINCIPAL: 'host:operator',
  COUNCIL_HUMAN_PRINCIPALS: 'host:operator',
  COUNCIL_HTTP_TOKEN: token,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function serve(env: NodeJS.ProcessEnv) {
  const server = createConfiguredHttpServer(env);
  cleanup.push(() => new Promise<void>(done => server.close(() => done())));
  return server;
}

// Socket-free transport (as in http.test.ts) with a chosen peer address.
function connect(server: Server, remoteAddress: string | undefined): Duplex {
  function socketTo(peer: () => Duplex) {
    return new Duplex({
      read() {},
      write(chunk, _encoding, done) { peer().push(chunk); done(); },
      final(done) { peer().push(null); done(); },
    });
  }
  const inbound: Duplex = socketTo(() => outbound);
  const outbound: Duplex = socketTo(() => inbound);
  Object.defineProperty(inbound, 'remoteAddress', { value: remoteAddress });
  server.emit('connection', inbound);
  return outbound;
}

interface Call {
  method?: string; path?: string; remoteAddress?: string | null;
  host?: string; headers?: Record<string, string>;
}

function call(server: Server, { method = 'POST', path = '/pairing/claim', remoteAddress = '127.0.0.1', host = '127.0.0.1:8790', headers = {} }: Call = {}) {
  return new Promise<{ status: number | undefined; body: any }>((done, reject) => {
    const req = request({
      method, path, setHost: false,
      createConnection: () => connect(server, remoteAddress ?? undefined),
      headers: { Connection: 'close', Host: host, ...headers },
    }, async response => {
      try {
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) body += chunk;
        done({ status: response.statusCode, body: JSON.parse(body) });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end();
  });
}

const notFound = { status: 404, body: { code: 'not_found' } };
const recordPath = (home: string, value = token) => join(home, PAIRING_RECORD_DIR, tokenGeneration(value));

async function armedEnv(extra: NodeJS.ProcessEnv = {}) {
  const home = await tempDir('council-pairing-');
  return { ...baseEnv, COUNCIL_HOME: home, COUNCIL_PAIRING_ARM: '1', ...extra };
}

test('an unarmed facade answers claims with 404', async () => {
  const env = await armedEnv();
  for (const arm of [undefined, '0', 'true', '']) {
    const server = serve({ ...env, COUNCIL_PAIRING_ARM: arm });
    expect(await call(server)).toEqual(notFound);
  }
  await expect(readdir(env.COUNCIL_HOME)).resolves.not.toContain(PAIRING_RECORD_DIR);
});

test('an armed facade answers exactly one loopback claim, then 404', async () => {
  const env = await armedEnv();
  const server = serve(env);
  expect(await call(server)).toEqual({ status: 200, body: { baseUrl: 'http://127.0.0.1:8790', token } });
  expect(await call(server)).toEqual(notFound);
  expect(await call(server, { remoteAddress: '::1', host: '[::1]:8790' })).toEqual(notFound);

  expect(await readdir(join(env.COUNCIL_HOME, PAIRING_RECORD_DIR))).toEqual([tokenGeneration(token)]);
  const raw = await readFile(recordPath(env.COUNCIL_HOME), 'utf8');
  expect(raw).not.toContain(token);
  expect(JSON.parse(raw)).toEqual({ claimed: true, token_generation: tokenGeneration(token) });
  expect(tokenGeneration(token)).not.toContain(token);
});

test('concurrent claims hand the token out once', async () => {
  const server = serve(await armedEnv());
  const results = await Promise.all(Array.from({ length: 8 }, () => call(server)));
  expect(results.filter(result => result.status === 200)).toHaveLength(1);
  expect(results.filter(result => result.status === 404)).toHaveLength(7);
});

test('two armed facades sharing COUNCIL_HOME hand the token out once', async () => {
  const env = await armedEnv();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  cleanup.push(async () => { errors.mockRestore(); });
  const first = serve(env);
  const second = serve({ ...env, COUNCIL_HTTP_PORT: '8791' });
  const results = await Promise.all([call(first), call(second, { host: '127.0.0.1:8791' })]);
  expect(results.map(result => result.status).sort()).toEqual([200, 404]);
  expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
});

test('claims that fail the guards follow unknown-path auth without consuming the arm', async () => {
  const server = serve(await armedEnv({ COUNCIL_HTTP_HOST: '0.0.0.0' }));
  const unauthorized = { status: 401, body: { code: 'unauthorized' } };
  const blocked: Call[] = [
    ...[null, '192.168.1.20', '::ffff:10.0.0.2', 'fe80::1', '128.0.0.1'].map(remoteAddress => ({ remoteAddress })),
    { host: 'evil.example:8790' },
    { host: '' },
    { headers: { Origin: 'https://evil.example' } },
    { headers: { Origin: 'null' } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  ];
  for (const options of blocked) {
    expect(await call(server, options)).toEqual(unauthorized);
    expect(await call(server, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } })).toEqual(notFound);
  }
  // Still armed: a proper loopback claim succeeds once.
  expect(await call(server, { remoteAddress: '::ffff:127.0.0.1', host: 'localhost:8790' }))
    .toEqual({ status: 200, body: { baseUrl: 'http://127.0.0.1:8790', token } });
  expect(await call(server)).toEqual(notFound);
});

test('a claimed record survives facade restarts', async () => {
  const env = await armedEnv();
  expect((await call(serve(env))).status).toBe(200);
  expect(await call(serve(env))).toEqual(notFound);
  expect(await call(serve(env))).toEqual(notFound);
});

test('a token update re-arms, and the new token is handed out once', async () => {
  const env = await armedEnv();
  expect((await call(serve(env))).status).toBe(200);
  const rotated = { ...env, COUNCIL_HTTP_TOKEN: 'rotated-token-value' };
  const server = serve(rotated);
  expect(await call(server)).toEqual({ status: 200, body: { baseUrl: 'http://127.0.0.1:8790', token: 'rotated-token-value' } });
  expect(await call(server)).toEqual(notFound);
  expect(await call(serve(rotated))).toEqual(notFound);
  expect((await readdir(join(env.COUNCIL_HOME, PAIRING_RECORD_DIR))).sort())
    .toEqual([tokenGeneration(token), tokenGeneration('rotated-token-value')].sort());
  // Rotating back to an already claimed token (e.g. restored from a backup) stays disarmed.
  expect(await call(serve(env))).toEqual(notFound);
});

test('any entry at the record path keeps the generation claimed, whatever its content or type', async () => {
  for (const content of ['not json', '{}', '{"claimed":false}', '{"claimed":true,"token_generation":""}', '']) {
    const env = await armedEnv();
    await mkdir(join(env.COUNCIL_HOME, PAIRING_RECORD_DIR));
    await writeFile(recordPath(env.COUNCIL_HOME), content);
    expect(await call(serve(env))).toEqual(notFound);
  }
  const dirEnv = await armedEnv();
  await mkdir(recordPath(dirEnv.COUNCIL_HOME), { recursive: true });
  expect(await call(serve(dirEnv))).toEqual(notFound);
  // A non-directory where the record directory belongs is unknown: fail closed.
  // A record in the unreleased single-file layout also keeps the facade disarmed.
  const legacyEnv = await armedEnv();
  await writeFile(join(legacyEnv.COUNCIL_HOME, LEGACY_PAIRING_RECORD_FILE), '{"claimed":true}');
  expect(await call(serve(legacyEnv))).toEqual(notFound);
  const fileEnv = await armedEnv();
  await writeFile(join(fileEnv.COUNCIL_HOME, PAIRING_RECORD_DIR), '');
  expect(await call(serve(fileEnv))).toEqual(notFound);
});

const hasMkfifo = spawnSync('sh', ['-c', 'command -v mkfifo'], { encoding: 'utf8' }).status === 0;
test.runIf(hasMkfifo)('a FIFO at the record path neither blocks startup nor arms', async () => {
  const env = await armedEnv();
  await mkdir(join(env.COUNCIL_HOME, PAIRING_RECORD_DIR));
  execFileSync('mkfifo', [recordPath(env.COUNCIL_HOME)]);
  const server = serve(env);
  expect((await call(server, { method: 'GET', path: '/health' })).status).toBe(200);
  expect(await call(server)).toEqual(notFound);
});

test('a claim whose record cannot be persisted is refused, disarms, and logs no token', async () => {
  const env = await armedEnv();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const server = serve(env);
    // Armed at startup; the record directory becomes unusable before the claim.
    await writeFile(join(env.COUNCIL_HOME, PAIRING_RECORD_DIR), '');
    expect(await call(server)).toEqual(notFound);
    await rm(join(env.COUNCIL_HOME, PAIRING_RECORD_DIR));
    expect(await call(server)).toEqual(notFound);
    const output = JSON.stringify([...errors.mock.calls, ...logs.mock.calls]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(output).not.toContain(token);
  } finally {
    errors.mockRestore();
    logs.mockRestore();
  }
});

test('the claim path does not open other routes or change auth and /health', async () => {
  const server = serve(await armedEnv());
  const unauthorized = { status: 401, body: { code: 'unauthorized' } };
  expect(await call(server, { method: 'GET' })).toEqual(unauthorized);
  expect(await call(server, { method: 'GET', path: '/meetings' })).toEqual(unauthorized);
  expect(await call(server, { path: '/pairing/claim/' })).toEqual(unauthorized);
  expect(await call(server, { path: '/pairing' })).toEqual(unauthorized);
  expect(await call(server, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })).toEqual(notFound);
  const health = await call(server, { method: 'GET', path: '/health' });
  expect(health.status).toBe(200);
  expect(Object.keys(health.body).sort()).toEqual(['cli_seat_kinds', 'ok']);
  // The arm is untouched by all of the above.
  expect((await call(server)).status).toBe(200);
});

test('the claim baseUrl is built from the bind and port', async () => {
  const server = serve(await armedEnv({ COUNCIL_HTTP_HOST: '0.0.0.0', COUNCIL_HTTP_PORT: '9123' }));
  expect((await call(server, { host: '127.0.0.1:9123' })).body.baseUrl).toBe('http://127.0.0.1:9123');

  expect(pairingBaseUrl({ address: '127.0.0.1', port: 8790 }, {})).toBe('http://127.0.0.1:8790');
  expect(pairingBaseUrl({ address: '0.0.0.0', port: 4000 }, {})).toBe('http://127.0.0.1:4000');
  expect(pairingBaseUrl({ address: '::', port: 4000 }, {})).toBe('http://127.0.0.1:4000');
  expect(pairingBaseUrl({ address: '::1', port: 4000 }, {})).toBe('http://[::1]:4000');
  expect(pairingBaseUrl(null, {})).toBe('http://127.0.0.1:8790');
  expect(pairingBaseUrl(null, { COUNCIL_HTTP_HOST: '127.0.0.2', COUNCIL_HTTP_PORT: '8800' })).toBe('http://127.0.0.2:8800');
});

test('loopback classification', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(address)).toBe(true);
  for (const address of [undefined, '', '0.0.0.0', '10.0.0.1', '::', 'fe80::1', '::ffff:10.0.0.1', '1127.0.0.1']) {
    expect(isLoopbackAddress(address)).toBe(false);
  }
  for (const host of ['127.0.0.1', '127.0.0.1:8790', 'localhost:8790', 'LOCALHOST', '[::1]:8790', '127.255.255.255:65535']) expect(isLoopbackHostHeader(host)).toBe(true);
  for (const host of [undefined, '', 'evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '0.0.0.0:8790', '::1', '127.256.0.1', '127.0.256.1', '127.0.0.256', 'localhost:65536', '[::1]:99999']) {
    expect(isLoopbackHostHeader(host)).toBe(false);
  }
});

// A real listener on an ephemeral port: baseUrl must carry the assigned port.
test('the claim baseUrl uses the actually bound port on a real listener', async ctx => {
  const server = serve(await armedEnv({ COUNCIL_HTTP_PORT: '0' }));
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done());
    });
  } catch {
    ctx.skip();
    return;
  }
  const { port } = server.address() as { port: number };
  const result = await new Promise<{ status: number | undefined; body: any }>((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/pairing/claim', method: 'POST', headers: { Connection: 'close' } }, async response => {
      let body = '';
      response.setEncoding('utf8');
      for await (const chunk of response) body += chunk;
      done({ status: response.statusCode, body: JSON.parse(body) });
    });
    req.on('error', reject);
    req.end();
  });
  expect(port).toBeGreaterThan(0);
  expect(result).toEqual({ status: 200, body: { baseUrl: `http://127.0.0.1:${port}`, token } });
});

// The Fold launcher requests the arm; node and curl are stubbed so no facade runs.
const hasSh = spawnSync('sh', ['-c', 'command -v nohup'], { encoding: 'utf8' }).status === 0;
test.runIf(hasSh)('start-facade.sh requests the pairing arm by default and honours an opt-out', async () => {
  const bin = await tempDir('council-pairing-bin-');
  await writeFile(join(bin, 'node'),
    '#!/bin/sh\nprintf "%s" "${COUNCIL_PAIRING_ARM-unset}" > "$COUNCIL_HOME/arm"\n: > "$COUNCIL_HOME/up"\nexec sleep 60\n');
  await writeFile(join(bin, 'curl'), '#!/bin/sh\n[ -f "$COUNCIL_HOME/up" ]\n');
  await chmod(join(bin, 'node'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  const script = resolve('scripts/fold/start-facade.sh');
  for (const [arm, expected] of [[undefined, '1'], ['0', '0']] as const) {
    const home = await tempDir('council-pairing-home-');
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, COUNCIL_HOME: home,
      COUNCIL_HTTP_TOKEN: token, COUNCIL_HTTP_PORT: '1', COUNCIL_CODEX_COMMAND: 'unused',
    };
    delete env.COUNCIL_PAIRING_ARM;
    if (arm !== undefined) env.COUNCIL_PAIRING_ARM = arm;
    const { stdout, stderr } = await promisify(execFile)('sh', [script], { env });
    try {
      expect(stdout).toContain('OK');
      expect(stdout + stderr).not.toContain(token);
      expect(await readFile(join(home, 'arm'), 'utf8')).toBe(expected);
    } finally {
      const pid = Number((await readFile(join(home, 'facade.pid'), 'utf8')).trim());
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }
});
