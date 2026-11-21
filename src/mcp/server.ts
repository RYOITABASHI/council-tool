import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createCore } from '../core/index.js';
import { ERROR_CODES } from '../core/types.js';
import type { CouncilError } from '../core/types.js';
import { councilTools, inputSchemas } from './tools.js';
import type { CouncilOperation } from './tools.js';

type Payload = Record<string, unknown>;
export type CoreDispatch = (
  operation: CouncilOperation, args: Payload, principal: string,
) => Payload | Promise<Payload>;

function isCouncilError(value: unknown): value is CouncilError {
  return typeof value === 'object' && value !== null && 'code' in value
    && ERROR_CODES.some(code => code === value.code);
}

function toolResult(payload: Payload, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function errorResult({ code, detail }: CouncilError): CallToolResult {
  return toolResult({ code, ...(detail === undefined ? {} : { detail }) }, true);
}

export function createMcpServer(dispatch: CoreDispatch, principal: string): Server {
  const server = new Server({ name: 'council-tool', version: '0.1.0' }, {
    capabilities: { tools: {} },
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: councilTools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const prefix = 'council.';
    const operation = params.name.slice(prefix.length);
    if (!params.name.startsWith(prefix) || !Object.hasOwn(inputSchemas, operation)) {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown council tool');
    }

    try {
      const result = await dispatch(operation as CouncilOperation, params.arguments ?? {}, principal);
      return isCouncilError(result) ? errorResult(result) : toolResult(result);
    } catch (error) {
      if (isCouncilError(error)) return errorResult(error);
      console.error(error);
      throw new McpError(ErrorCode.InternalError, 'Council core failed');
    }
  });
  return server;
}

export function createConfiguredMcpServer(env: NodeJS.ProcessEnv = process.env): Server {
  const principal = env.COUNCIL_PRINCIPAL;
  if (!principal?.trim()) throw new Error('COUNCIL_PRINCIPAL must be set');
  const home = resolve(env.COUNCIL_HOME ?? join(homedir(), '.council-tool'));
  const humans = new Set((env.COUNCIL_HUMAN_PRINCIPALS ?? '').split(',').map(id => id.trim()).filter(Boolean));
  const core = createCore({ home, isHuman: id => humans.has(id) });
  const server = createMcpServer(core.dispatch, principal);
  server.onclose = () => core.close();
  return server;
}

async function main() {
  const server = createConfiguredMcpServer();
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await server.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
