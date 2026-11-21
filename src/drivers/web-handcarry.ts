import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROUNDS } from '../core/types.js';
import { createMcpToolCaller, type SeatPrompt, type ToolCaller } from './index.js';

export async function handcarryWebSeat(
  { prompt, meeting_id, round, seat_id, supersedes }: SeatPrompt,
  call: ToolCaller,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
) {
  await new Promise<void>((resolve, reject) => {
    output.write(`${prompt}\n\n回答の原文を貼り付け、EOF で送信してください。\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const decoder = new StringDecoder('utf8');
  let body = '';
  for await (const chunk of input) body += typeof chunk === 'string' ? chunk : decoder.write(chunk);
  body += decoder.end();
  if (!body.trim()) throw new Error('Web seat answer is empty');
  return call('council.transcribe_web_seat', {
    meeting_id, round, seat_id, body, ...(supersedes === undefined ? {} : { supersedes }),
  });
}

async function main([meeting_id, round, seat_id, promptFile, currentPacket, separator, command, ...args]: string[]) {
  if (!meeting_id || !seat_id || !promptFile || !currentPacket || separator !== '--' || !command ||
      (round !== 'R0' && round !== 'R1' && round !== 'R2')) {
    throw new Error(
      `Usage: node dist/drivers/web-handcarry.js MEETING ${ROUNDS.join('|')} SEAT PROMPT_FILE SUPERSEDES_OR_- -- MCP_COMMAND [ARG ...]`,
    );
  }
  const prompt = await readFile(promptFile, 'utf8');
  const client = new Client({ name: 'council-web-handcarry', version: '0.1.0' });
  const env: Record<string, string> = {};
  for (const key of ['COUNCIL_HOME', 'COUNCIL_PRINCIPAL']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const transport = new StdioClientTransport({ command, args, env, stderr: 'inherit' });
  try {
    await client.connect(transport);
    const result = await handcarryWebSeat({
      meeting_id, round, seat_id, prompt, supersedes: currentPacket === '-' ? null : currentPacket,
    }, createMcpToolCaller(client));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await transport.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
