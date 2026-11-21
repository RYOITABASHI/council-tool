import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolCaller } from './index.js';

export function createMcpToolCaller(client: Pick<Client, 'callTool'>): ToolCaller {
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content) ? result.content.find(item => item.type === 'text')?.text : undefined;
    if (result.isError) throw new Error(`${name}: ${text ?? 'MCP tool error'}`);

    let payload: unknown = result.structuredContent;
    if (payload === undefined && typeof text === 'string') {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`${name}: expected a JSON tool response`, { cause: error });
      }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`${name}: expected a tool response object`);
    }
    const object = payload as Record<string, unknown>;
    if (object.status === 'error' || 'error' in object || typeof object.code === 'string') {
      throw new Error(`${name}: ${JSON.stringify(object)}`);
    }
    return object;
  };
}
