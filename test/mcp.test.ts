import { guardStoreLinks, installXattrTestTransport } from './store-test-platform.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { expect, test, vi } from 'vitest';
import { createCore } from '../src/core/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { CoreDispatch } from '../src/mcp/server.js';

installXattrTestTransport();
guardStoreLinks();
vi.setConfig({ testTimeout: 60_000 });

const principal = 'operator';

async function withClient(dispatch: CoreDispatch, run: (client: Client) => Promise<void>) {
  const server = createMcpServer(dispatch, principal);
  const client = new Client({ name: 'council-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('lists the 17 v1 council tools and forwards core errors unchanged', async () => {
  const error = { code: 'invalid_state', detail: { meeting_state: 'OPEN' } };
  await withClient((operation, args, caller) => {
    expect(operation).toBe('open_round');
    expect(args).toEqual({ meeting_id: 'meeting', round: 'R0' });
    expect(caller).toBe(principal);
    return error;
  }, async client => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'create_meeting', 'open_round', 'submit_answer', 'submit_flash',
      'transcribe_web_seat', 'submit_attest', 'get_state', 'get_packets',
      'declare_absent', 'waive_seat', 'chair_gate', 'synthesize', 'approve',
      'get_quota', 'confirm_share', 'update_setup', 'post_message',
    ].map(name => `council.${name}`).sort());

    expect(await client.callTool({
      name: 'council.open_round',
      arguments: { meeting_id: 'meeting', round: 'R0' },
    })).toMatchObject({
      isError: true,
      structuredContent: error,
      content: [{ type: 'text', text: JSON.stringify(error) }],
    });
  });
});

test('creates a meeting and opens R0 with the real core', async () => {
  const home = await mkdtemp(join(tmpdir(), 'council-mcp-'));
  const core = createCore({ home, isHuman: id => id === 'human:participant' });
  try {
    await withClient(core.dispatch, async client => {
      const created = await client.callTool({
        name: 'council.create_meeting',
        arguments: {
          topic: 'Smoke test',
          chair: { principal },
          seats: [{ seat_id: 'reviewer', principal: 'reviewer-agent', connection: 'cli' }],
          human_participants: ['human:participant'],
        },
      });
      expect(created.structuredContent).toMatchObject({ status: 'ok', meeting_id: expect.any(String) });
      expect(created.isError).not.toBe(true);

      const opened = await client.callTool({
        name: 'council.open_round',
        arguments: { meeting_id: (created.structuredContent as { meeting_id: string }).meeting_id, round: 'R0' },
      });
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        status: 'ok',
        round_state: {
          round: 'R0', phase: 'open', opened_at: expect.any(String), deadline_at: null, quorum: null,
        },
      });
    });
  } finally {
    core.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('advertises the optional synthesis fields accepted for core normalization', async () => {
  await withClient(() => ({}), async client => {
    const { tools } = await client.listTools();
    const schema = tools.find(tool => tool.name === 'council.synthesize')!.inputSchema;
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    const body = {
      agreements: [], minority_opinions: [], reversal_conditions: [], recommendation: null, cited_materials: [],
      unverified_items: [null, false, { unexpected: 'field' }],
      missing_records: ['bad', 42],
      reception_summary: { ignored: true },
    };
    expect(validate({ meeting_id: 'meeting', body })).toMatchObject({ valid: true });
    expect(validate({ meeting_id: 'meeting', body: { ...body, missing_records: null } })).toMatchObject({ valid: false });
    expect(validate({ meeting_id: 'meeting', body: { ...body, agreements: [false] } })).toMatchObject({ valid: false });
  });
});
