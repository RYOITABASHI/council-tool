import { spawn } from 'node:child_process';
import type { Round } from '../core/types.js';
import type { AnswerBody, Packet } from '../packet/types.js';
export { createMcpToolCaller } from './mcp-client.js';

export interface SeatAssignment {
  meeting_id: string;
  round: Round;
  seat_id: string;
  supersedes?: string | null;
}

export interface SeatPrompt extends SeatAssignment {
  prompt: string;
}

export type ToolCaller = (
  name: string, args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export const CLI_PRESETS = {
  codex: { command: 'codex', args: ['exec', '--skip-git-repo-check', '-'] },
  claude: { command: 'claude', args: ['-p'] },
  antigravity: { command: 'agy', args: ['-p'] },
} as const;

export interface CliSeatConfig {
  kind: keyof typeof CLI_PRESETS;
  command?: string;
  args?: readonly string[];
  cwd?: string;
}

export function formatSeatPrompt(
  { meeting_id, round, seat_id }: SeatAssignment,
  packets: readonly Packet[],
): string {
  const task = round === 'R0' ? '議題に回答してください。' : round === 'R1' ? '凍結された回答を批評してください。' :
    '議長が指定した論点の範囲で回答してください。';
  return [
    `会議: ${meeting_id} / ラウンド: ${round} / 席: ${seat_id}`,
    task,
    '回答は自然文、または次の形の JSON オブジェクトで返してください。',
    '{"body":"回答本文","claims":[{"statement":"主張","reversal_condition":"判断が変わる条件"}]}',
    JSON.stringify(packets, null, 2),
    '',
  ].join('\n');
}

export async function getSeatInput(assignment: SeatAssignment, call: ToolCaller) {
  const args = { meeting_id: assignment.meeting_id, caller_seat_id: assignment.seat_id, view: 'input' };
  const result = await call('council.get_packets', args);
  const { new_packets, delivery_epoch } = result;
  if (!Array.isArray(new_packets) || typeof delivery_epoch !== 'number') {
    throw new Error('council.get_packets did not return seat input and delivery_epoch');
  }
  const packets = new_packets as Packet[];
  const receipt = { delivery_epoch, ack_packet_ids: packets.map(({ header }) => header.packet_id) };
  return {
    receipt,
    prompt: formatSeatPrompt(assignment, packets),
    packets,
    notices: result.notices,
    async acknowledge() {
      if (packets.length > 0) {
        return call('council.get_packets', { ...args, ...receipt });
      }
    },
  };
}

function readAnswer(stdout: string): AnswerBody {
  const content = stdout.trim();
  if (!content) throw new Error('CLI returned an empty answer');

  const json = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(content)?.[1] ?? content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { body: stdout };
  }
  if (parsed === null || typeof parsed !== 'object' || !('body' in parsed || 'claims' in parsed)) {
    return { body: stdout };
  }
  if (!('body' in parsed) || typeof parsed.body !== 'string' || !parsed.body.trim()) {
    throw new Error('Structured CLI answer must have a nonempty string body');
  }
  if (!('claims' in parsed)) return { body: parsed.body };
  if (!Array.isArray(parsed.claims)) throw new Error('Structured CLI answer claims must be an array');
  const claims = parsed.claims.map((claim: unknown) => {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      throw new Error('Each CLI claim must be an object');
    }
    const fields: NonNullable<AnswerBody['claims']>[number] = {};
    for (const key of ['statement', 'reversal_condition'] as const) {
      if (!Object.hasOwn(claim, key)) continue;
      const value = (claim as Record<string, unknown>)[key];
      if (value !== null && typeof value !== 'string') throw new Error(`CLI claim ${key} must be a string or null`);
      fields[key] = value;
    }
    return fields;
  });
  return { body: parsed.body, claims };
}

export function runCli(config: CliSeatConfig, prompt: string): Promise<string> {
  const preset = CLI_PRESETS[config.kind];
  const command = config.command ?? preset.command;
  const args = config.args ?? preset.args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: config.cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let inputError: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error: Error) => { inputError = error; });
    child.once('error', (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT'
        ? `CLI executable not found or working directory missing: ${command}`
        : `Could not start CLI: ${command}`;
      reject(new Error(message, { cause: error }));
    });
    child.once('close', (code, signal) => {
      if (code !== 0) {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`${command} failed with ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      } else if (inputError) {
        reject(new Error(`Could not send the prompt to ${command}`, { cause: inputError }));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.end(prompt, 'utf8');
  });
}

export async function runCliSeat(
  { prompt, meeting_id, round, seat_id, supersedes }: SeatPrompt,
  config: CliSeatConfig,
  call: ToolCaller,
  execute = runCli,
) {
  const answer = readAnswer(await execute(config, prompt));
  return call('council.submit_answer', {
    meeting_id, round, seat_id, ...answer, ...(supersedes === undefined ? {} : { supersedes }),
  });
}
