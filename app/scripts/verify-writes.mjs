import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(root, '.verify-writes-'));
const originalFetch = global.fetch;
const baseUrl = 'https://facade.example.test';
const token = 'mock-token';
const meetingId = 'm-123';
const topic = '会議の議題';
const createBody = { topic, seats: [{ seat_id: 'codex', kind: 'codex-cli' }] };
const mentionBody = { seat_id: 'codex', text: '意見を聞かせてください' };
const runner = { phase: 'running', detail: null, updated_at: '2026-11-21T00:00:00Z' };
const meetingState = {
  round_states: [], reception_table: [], seats: [], timeout_exceeded: false, reopens: null, setup_version: 1,
};

async function check(name, mock, expected, verify) {
  const requests = [];
  const replies = [mock].flat();
  const expectedRequests = [expected].flat();
  global.fetch = async (url, init) => {
    const reply = replies[requests.length];
    const headers = new Headers(init.headers);
    requests.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
      contentType: headers.get('Content-Type'),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    assert.ok(reply, `Unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await verify();
    assert.deepEqual(requests, expectedRequests.map(request => ({
      url: baseUrl + request.path,
      method: request.method,
      authorization: `Bearer ${token}`,
      contentType: request.method === 'POST' ? 'application/json' : null,
      body: request.body,
    })));
    console.log(`PASS ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${name}`, error);
  }
}

try {
  // TypeScript 6 requires explicit opt-outs for the standalone input and node10 resolution.
  const [command, compiler] = process.platform === 'win32'
    ? [process.execPath, require.resolve('typescript/bin/tsc')]
    : ['npx', 'tsc'];
  execFileSync(command, [
    compiler, 'src/api.ts', '--module', 'commonjs', '--target', 'es2022',
    '--moduleResolution', 'node', '--skipLibCheck', '--outDir', outDir,
    '--ignoreConfig', '--ignoreDeprecations', '6.0',
  ], { cwd: root, stdio: 'inherit' });

  const {
    createMeeting, describeFacadeError, FacadeError, fetchRunner, postApprove, postMention, startMeeting,
  } = require(join(outDir, 'api.js'));

  const create = { method: 'POST', path: '/meetings', body: createBody };
  await check('createMeeting sends topic and seats', { status: 201, body: { meeting_id: meetingId } }, create, async () => {
    assert.deepEqual(await createMeeting(baseUrl, token, createBody), { meeting_id: meetingId });
  });

  const start = { method: 'POST', path: '/meetings/m-123/start', body: {} };
  const startRunner = { phase: 'running' };
  await check('startMeeting parses the accepted runner', { status: 202, body: { runner: startRunner } }, start, async () => {
    assert.deepEqual(await startMeeting(baseUrl, token, meetingId), startRunner);
  });

  const getRunner = { method: 'GET', path: '/meetings/m-123/runner' };
  const erroredRunner = { ...runner, phase: 'error', detail: 'driver_failed' };
  await check('fetchRunner reads the runner state', { status: 200, body: erroredRunner }, getRunner, async () => {
    assert.deepEqual(await fetchRunner(baseUrl, token, meetingId), erroredRunner);
  });

  const mention = { method: 'POST', path: '/meetings/m-123/mention', body: mentionBody };
  await check('postMention sends the addressee and text', { status: 202, body: runner }, mention, async () => {
    assert.deepEqual(await postMention(baseUrl, token, meetingId, mentionBody), runner);
  });
  await check('postMention parses a wrapped runner', { status: 202, body: { runner } }, mention, async () => {
    assert.deepEqual(await postMention(baseUrl, token, meetingId, mentionBody), runner);
  });

  const approval = { method: 'POST', path: '/meetings/m-123/approve' };
  for (const [decision, phase] of [['approve', 'APPROVED'], ['reject', 'REJECTED']]) {
    const state = { ...meetingState, meeting_state: phase };
    await check(`postApprove sends ${decision}`, { status: 200, body: state }, { ...approval, body: { decision } }, async () => {
      assert.deepEqual(await postApprove(baseUrl, token, meetingId, decision), state);
    });
  }
  const approved = { meeting_state: 'APPROVED' };
  const approvedState = { ...meetingState, ...approved };
  await check('postApprove loads full state after a terminal acknowledgment', [
    { status: 200, body: approved },
    { status: 200, body: approvedState },
  ], [
    { ...approval, body: { decision: 'approve' } },
    { method: 'GET', path: '/meetings/m-123/state' },
  ], async () => {
    assert.deepEqual(await postApprove(baseUrl, token, meetingId, 'approve'), approvedState);
  });

  const refusesApi = { ...createBody, seats: [{ seat_id: 'api', kind: 'api' }] };
  for (const { status, code, message, request, send } of [
    {
      status: 422, code: 'seat_kind_unavailable', message: 'API席・ローカル席はまだ利用できません',
      request: { ...create, body: refusesApi }, send: () => createMeeting(baseUrl, token, refusesApi),
    },
    {
      status: 409, code: 'runner_active', message: 'すでに実行中です',
      request: start, send: () => startMeeting(baseUrl, token, meetingId),
    },
  ]) {
    await check(`HTTP ${status} surfaces ${code}`, { status, body: { code } }, request, async () => {
      await assert.rejects(send, error => {
        assert.ok(error instanceof FacadeError);
        assert.equal(error.kind, 'http');
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(describeFacadeError(error), message);
        return true;
      });
    });
  }
} catch (error) {
  process.exitCode = 1;
  console.error('FAIL harness setup', error);
} finally {
  global.fetch = originalFetch;
  rmSync(outDir, { recursive: true });
}
