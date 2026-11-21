import type { Core } from '../core/index.js';
import { ERROR_CODES } from '../core/types.js';
import type { MeetingState, Round } from '../core/types.js';
import { record } from '../core/validation.js';
import { getSeatInput, runCli, runCliSeat } from '../drivers/index.js';
import type { CliSeatConfig, ToolCaller } from '../drivers/index.js';
import { gateArgs, gateInstructions, synthesisArgs, synthesisInstructions } from './chair-output.js';

export const cliSeatKinds = { 'codex-cli': 'codex', 'claude-code-cli': 'claude' } as const;
export const isCliSeatKind = (value: unknown): value is keyof typeof cliSeatKinds =>
  typeof value === 'string' && Object.hasOwn(cliSeatKinds, value);

type Phase = 'idle' | 'running' | 'awaiting_approval' | 'error' | 'done';
type RunnerState = { phase: Phase; detail: string | null; updated_at: string };
type MeetingSeat = Awaited<ReturnType<Core['get_state']>>['seats'][number];
type CliSeat = { seat_id: string; kind: CliSeatConfig['kind'] };
type Mention = { seat_id: string; text: string };

class RunnerError extends Error {}

function cliSeat({ seat_id, connection, role }: MeetingSeat): CliSeat {
  if (connection !== 'cli' || !isCliSeatKind(role)) throw { code: 'seat_kind_unavailable' };
  return { seat_id, kind: cliSeatKinds[role] };
}

function stateConflict(meeting_state: MeetingState): never {
  throw { code: 'invalid_state', detail: { meeting_state } };
}

const terminal = (state: MeetingState) => state === 'APPROVED' || state === 'REJECTED';

export class HostRunner {
  private readonly active = new Set<string>();
  private readonly states = new Map<string, RunnerState>();

  constructor(
    private readonly getCore: () => Core,
    private readonly principal: string,
    private readonly execute = runCli,
  ) {}

  async status(meeting_id: string) {
    const { meeting_state } = await this.getCore().get_state(this.principal, { meeting_id });
    const current = this.states.get(meeting_id);
    if (this.active.has(meeting_id) && current?.phase === 'running') return current;
    if (terminal(meeting_state)) return this.setPhase(meeting_id, 'done');
    if (current?.phase === 'error') return current;
    return this.setPhase(meeting_id, meeting_state === 'AWAITING_APPROVAL' ? 'awaiting_approval' : 'idle');
  }

  start(meeting_id: string) {
    return this.launch(meeting_id, async () => {
      const core = this.getCore();
      const state = await core.get_state(this.principal, { meeting_id });
      if (state.meeting_state !== 'CREATED') stateConflict(state.meeting_state);
      // Optional seats submit first so the final required submission can freeze the barrier.
      const seats = state.seats.sort((a, b) => Number(b.optional) - Number(a.optional)).map(cliSeat);
      await core.open_round(this.principal, { meeting_id, round: 'R0' });
      return () => this.initialRun(meeting_id, seats);
    });
  }

  mention(meeting_id: string, mention: Mention) {
    return this.launch(meeting_id, async () => {
      const core = this.getCore();
      const state = await core.get_state(this.principal, { meeting_id });
      if (state.meeting_state === 'OPEN' || terminal(state.meeting_state)) stateConflict(state.meeting_state);
      const addressed = state.seats.find(seat => seat.seat_id === mention.seat_id);
      if (!addressed) throw { code: 'not_found' };
      const seat = cliSeat(addressed);
      const waived = state.seats.filter(other => other.seat_id !== seat.seat_id);
      const { round_state: { round } } = await core.open_round(this.principal, { meeting_id, mention });
      return async () => {
        for (const { seat_id } of waived) {
          await core.waive_seat(this.principal, {
            meeting_id, round, seat_id, reason_code: 'chair_judgment',
            reason_note: `Human directed this round to ${seat.seat_id}.`,
          });
        }
        await this.runRound(meeting_id, round, [seat], mention.text);
        await this.synthesize(meeting_id);
      };
    });
  }

  private async launch(meeting_id: string, prepare: () => Promise<() => Promise<void>>) {
    if (this.active.has(meeting_id)) throw { code: 'runner_active' };
    this.active.add(meeting_id);
    try {
      const run = await prepare();
      const started = this.setPhase(meeting_id, 'running');
      void run().then(
        () => this.finish(meeting_id, 'awaiting_approval'),
        error => this.finish(meeting_id, 'error', this.describeError(error)),
      );
      return started;
    } catch (error) {
      this.active.delete(meeting_id);
      throw error;
    }
  }

  private finish(meeting_id: string, phase: 'awaiting_approval' | 'error', detail: string | null = null) {
    this.setPhase(meeting_id, phase, detail);
    this.active.delete(meeting_id);
  }

  private setPhase(meeting_id: string, phase: Phase, detail: string | null = null): RunnerState {
    const current = this.states.get(meeting_id);
    if (current?.phase === phase && current.detail === detail) return current;
    const state = { phase, detail, updated_at: new Date().toISOString() };
    this.states.set(meeting_id, state);
    return state;
  }

  private describeError(error: unknown) {
    if (error instanceof RunnerError) return error.message;
    if (record(error) && ERROR_CODES.some(code => error.code === code)) return `council.${error.code}`;
    return 'internal_error';
  }

  private async initialRun(meeting_id: string, seats: CliSeat[]) {
    const core = this.getCore();
    await this.runRound(meeting_id, 'R0', seats);
    await core.open_round(this.principal, { meeting_id, round: 'R1' });
    await this.runRound(meeting_id, 'R1', seats);
    const gate = await this.chairStep(meeting_id, 'gate', gateInstructions, gateArgs,
      args => core.chair_gate(this.principal, args));
    if (gate.gate_decision_packet.body.result === 'fail') await this.runRound(meeting_id, 'R2', seats);
    await this.synthesize(meeting_id);
  }

  private async runRound(meeting_id: string, round: Round, seats: CliSeat[], mentionText?: string) {
    const core = this.getCore();
    const frozen = async () => (await core.get_state(this.principal, { meeting_id }))
      .round_states.find(candidate => candidate.round === round)?.phase === 'frozen';
    if (await frozen()) return;
    const call: ToolCaller = (operation, args) => {
      if (operation === 'council.get_packets' || operation === 'council.submit_answer') {
        return core.dispatch(operation, args, this.principal);
      }
      throw new RunnerError('internal_error: driver requested an unsupported council operation');
    };
    for (const { seat_id, kind } of seats) {
      const assignment = { meeting_id, round, seat_id };
      const input = await getSeatInput(assignment, call);
      const prompt = mentionText === undefined ? input.prompt :
        `Direct request from the human to @${seat_id}. Answer this request:\n${mentionText}\n\n${input.prompt}`;
      try {
        await runCliSeat({ ...assignment, prompt }, { kind }, call, this.execute);
      } catch (error) {
        if (error instanceof Error) throw new RunnerError(`seat_driver_error: ${seat_id} failed in ${round}`);
        throw error;
      }
      await input.acknowledge();
    }
    // The core freezes the round synchronously when the final required seat is resolved.
    if (!(await frozen())) {
      throw new RunnerError(`barrier_not_reached: ${round} is still open`);
    }
  }

  private synthesize(meeting_id: string) {
    return this.chairStep(meeting_id, 'synthesis', synthesisInstructions, synthesisArgs,
      args => this.getCore().synthesize(this.principal, args));
  }

  private async chairStep<Input, Result>(meeting_id: string, stage: 'gate' | 'synthesis', instructions: string,
    parse: (meeting_id: string, value: unknown) => Input, submit: (args: Input) => Promise<Result>) {
    const { new_packets } = await this.getCore().get_packets(this.principal, {
      meeting_id, view: 'oversight', caller_seat_id: 'chair',
    });
    const packets = JSON.stringify(new_packets, null, 2);
    let reason = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = reason ? `\nThe previous output was rejected. ${reason} Return corrected JSON only.` : '';
      let output: string;
      try {
        output = await this.execute({ kind: 'codex' }, `${instructions}${retry}\n\n${packets}`);
      } catch {
        throw new RunnerError(`chair_driver_error: the ${stage} call failed`);
      }
      let args: Input;
      try {
        args = parse(meeting_id, JSON.parse(output));
      } catch (error) {
        if (error instanceof SyntaxError) reason = 'Expected a single JSON object.';
        else if (record(error) && error.code === 'invalid_argument') reason = 'The JSON did not match the required fields.';
        else throw error;
        continue;
      }
      try {
        return await submit(args);
      } catch (error) {
        if (stage !== 'synthesis' || !record(error) || (error.code !== 'not_found' &&
            !(record(error.detail) && Object.hasOwn(error.detail, 'offending_materials')))) throw error;
        reason = 'The synthesis cited unknown or disallowed material.';
      }
    }
    throw new RunnerError(`invalid_chair_${stage}: ${reason}`);
  }
}
