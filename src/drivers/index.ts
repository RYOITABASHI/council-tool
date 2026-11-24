import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

export type ExecutionDisposition = 'execution_timeout' | 'execution_error' | 'output_overflow' | 'unparseable_output';

export class CliExecutionError extends Error {
  constructor(readonly disposition: ExecutionDisposition, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CliExecutionError';
  }
}

export const DEFAULT_EXECUTION_BOUNDS = { timeoutMs: 600000, outputLimitBytes: 4194304 } as const;

export interface CliSeatConfig {
  kind: keyof typeof CLI_PRESETS;
  command?: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
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

  let json = content;
  if (/^```json[ \t]*\r?\n/i.test(stdout.trimStart())) {
    const block = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(content);
    if (!block) throw new CliExecutionError('unparseable_output', 'Malformed CLI JSON answer fence');
    json = block[1];
  } else if (!content.startsWith('{')) {
    return { body: stdout };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new CliExecutionError('unparseable_output', 'Invalid JSON in structured CLI answer', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || !('body' in parsed) ||
      typeof parsed.body !== 'string' || !parsed.body.trim()) {
    throw new CliExecutionError('unparseable_output', 'Structured CLI answer must have a nonempty string body');
  }
  if (!('claims' in parsed)) return { body: parsed.body };
  if (!Array.isArray(parsed.claims)) {
    throw new CliExecutionError('unparseable_output', 'Structured CLI answer claims must be an array');
  }
  const claims = parsed.claims.map((claim: unknown) => {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      throw new CliExecutionError('unparseable_output', 'Each CLI claim must be an object');
    }
    const fields: NonNullable<AnswerBody['claims']>[number] = {};
    for (const key of ['statement', 'reversal_condition'] as const) {
      if (!Object.hasOwn(claim, key)) continue;
      const value = (claim as Record<string, unknown>)[key];
      if (value !== null && typeof value !== 'string') {
        throw new CliExecutionError('unparseable_output', `CLI claim ${key} must be a string or null`);
      }
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
  const { timeoutMs = DEFAULT_EXECUTION_BOUNDS.timeoutMs, outputLimitBytes = DEFAULT_EXECUTION_BOUNDS.outputLimitBytes } = config;
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let termination: CliExecutionError | undefined;

    function settle(result: string | CliExecutionError) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      if (typeof result === 'string') resolve(result);
      else reject(result);
    }

    function startError(cause: unknown) {
      const message = (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? `CLI executable not found or working directory missing: ${command}`
        : `Could not start CLI: ${command}`;
      settle(new CliExecutionError('execution_error', message, { cause }));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { cwd: config.cwd, stdio: 'pipe', detached: true });
    } catch (cause) {
      startError(cause);
      return;
    }
    const group = child.pid === undefined ? undefined : -child.pid;
    function signalGroup(signal: NodeJS.Signals | 0) {
      if (group === undefined) return false;
      try {
        process.kill(group, signal);
        return true;
      } catch (error) {
        // ESRCH is the only failure that confirms the group has exited.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    }

    function terminate(error: CliExecutionError) {
      if (settled || termination) return;
      termination = error;
      clearTimeout(timeoutTimer);
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        settle(error);
      }, 5000);
    }

    function terminateForTimeout() {
      terminate(new CliExecutionError('execution_timeout', `${command} exceeded its ${timeoutMs} ms execution timeout`));
    }

    function checkDeadline() {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        terminateForTimeout();
      } else {
        // Node clamps delays beyond the signed 32-bit range to 1 ms.
        timeoutTimer = setTimeout(checkDeadline, Math.min(Math.ceil(remaining), 2147483647));
      }
    }
    checkDeadline();

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let inputError: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || termination) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimitBytes) {
        terminate(new CliExecutionError('output_overflow', `${command} exceeded its ${outputLimitBytes}-byte stdout limit`));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const tail = chunk.subarray(-4096);
      const previousBytes = 4096 - tail.length;
      stderr = Buffer.concat([stderr.subarray(Math.max(0, stderr.length - previousBytes)), tail]);
    });
    child.stdin.on('error', (error: Error) => { inputError = error; });
    child.once('error', error => {
      if (!settled && !termination) startError(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (!termination && performance.now() >= deadline) terminateForTimeout();
      if (termination) {
        // Closed stdio does not imply that descendants in the group have exited.
        if (!signalGroup(0)) settle(termination);
      } else if (code !== 0 || signal) {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        const tail = stderr.toString('utf8').trim();
        settle(new CliExecutionError('execution_error', `${command} failed with ${reason}${tail ? `: ${tail}` : ''}`));
      } else if (inputError) {
        settle(new CliExecutionError('execution_error', `Could not send the prompt to ${command}`, { cause: inputError }));
      } else {
        settle(Buffer.concat(stdout, stdoutBytes).toString('utf8'));
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
