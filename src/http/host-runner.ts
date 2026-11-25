import type { Core } from '../core/index.js';
import { ERROR_CODES } from '../core/types.js';
import type { MeetingState, Round } from '../core/types.js';
import { record } from '../core/validation.js';
import { CliExecutionError, getSeatInput, runCli, runCliSeat } from '../drivers/index.js';
import type { CliSeatConfig, ToolCaller } from '../drivers/index.js';
import { gateArgs, gateInstructions, synthesisArgs, synthesisInstructions } from './chair-output.js';

export const cliSeatKinds = { 'codex-cli': 'codex', 'claude-code-cli': 'claude' } as const;
export const isCliSeatKind = (value: unknown): value is keyof typeof cliSeatKinds =>
  typeof value === 'string' && Object.hasOwn(cliSeatKinds, value);

type Phase = 'idle' | 'running' | 'awaiting_approval' | 'interrupted' | 'error' | 'done';
type RunnerState = { phase: Phase; detail: string | null; updated_at: string };
type Snapshot = Awaited<ReturnType<Core['get_state']>>;
type RunnerSnapshot = Awaited<ReturnType<Core['getRunnerState']>>;
type MeetingSeat = Snapshot['seats'][number];
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

const inPipeline = (state: MeetingState) =>
  state === 'OPEN' || state === 'GATE' || state === 'SYNTHESIZING';

export function continuation(state: RunnerSnapshot) {
  const round = state.round_states.at(-1);
  if (state.meeting_state === 'OPEN' && round?.phase === 'open') {
    const directed = state.directed?.round === round.round ? state.directed : null;
    const rows = state.reception_table.filter(row => row.round === round.round);
    const seats = state.seats.filter(seat => (!directed || directed.seat_id === seat.seat_id) &&
      rows.some(row => row.seat_id === seat.seat_id && row.state === 'pending'))
      .sort((a, b) => Number(b.optional) - Number(a.optional));
    if (directed?.text === null && seats.length > 0) {
      throw { code: 'invalid_state', detail: { meeting_state: state.meeting_state, round: round.round } };
    }
    const waive = directed ? rows.filter(row => row.seat_id !== directed.seat_id &&
      (row.state === 'pending' || row.state === 'transcribed_pending_attest')) : [];
    return { step: 'round', round: round.round, seats, directed, waive } as const;
  }
  if (state.meeting_state === 'GATE' && round?.phase === 'frozen') {
    if (round.round === 'R0') return { step: 'open_r1', seats: state.seats } as const;
    if (round.round === 'R1' && state.r1Gate === null) return { step: 'gate', seats: [] } as const;
  }
  // A gate commit moves to OPEN (R2) or SYNTHESIZING in the same write.
  // A synthesis commit moves to AWAITING_APPROVAL in the same write, even after a mention.
  if (state.meeting_state === 'SYNTHESIZING') return { step: 'synthesis', seats: [] } as const;
  if (state.meeting_state === 'AWAITING_APPROVAL') return { step: 'complete', seats: [] } as const;
  return stateConflict(state.meeting_state);
}

export class HostRunner {
  private readonly active = new Set<string>();
  private readonly states = new Map<string, RunnerState>();
  private readonly lastErrors = new Map<string, string>();

  constructor(
    private readonly getCore: () => Core,
    private readonly principal: string,
    private readonly execute = runCli,
    private readonly cliConfigs: Partial<Record<CliSeatConfig['kind'], CliSeatConfig>> = {},
  ) {}

  private cliConfig(kind: CliSeatConfig['kind']): CliSeatConfig {
    return this.cliConfigs[kind] ?? { kind };
  }

  async status(meeting_id: string) {
    const state = await this.getCore().get_state(this.principal, { meeting_id });
    return this.classify(meeting_id, state);
  }

  async reconcile(meetingIds: Iterable<string>) {
    for (const meeting_id of meetingIds) {
      if (this.active.has(meeting_id)) continue;
      try {
        const state = await this.getCore().snapshotState(this.principal, { meeting_id });
        if (!this.active.has(meeting_id)) this.classify(meeting_id, state);
      } catch (error) {
        if (!record(error) || error.code !== 'unauthorized') throw error;
      }
    }
  }

  private classify(meeting_id: string, { meeting_state, round_states }: Snapshot) {
    if (this.active.has(meeting_id)) return this.setPhase(meeting_id, 'running');
    if (terminal(meeting_state)) return this.setPhase(meeting_id, 'done');
    if (meeting_state === 'AWAITING_APPROVAL') return this.setPhase(meeting_id, 'awaiting_approval');
    if (inPipeline(meeting_state)) {
      const round = round_states.at(-1);
      const detail = round ? `${meeting_state} (${round.round} ${round.phase})` : meeting_state;
      const lastError = this.lastErrors.get(meeting_id);
      return this.setPhase(meeting_id, 'interrupted', lastError ? `${detail} | Last error: ${lastError}` : detail);
    }
    return this.setPhase(meeting_id, 'idle');
  }

  start(meeting_id: string) {
    return this.launch(meeting_id, async () => {
      const core = this.getCore();
      const state = await core.get_state(this.principal, { meeting_id });
      if (state.meeting_state !== 'CREATED') stateConflict(state.meeting_state);
      state.seats.forEach(cliSeat);
      await core.open_round(this.principal, { meeting_id, round: 'R0' });
      return () => this.continueRun(meeting_id);
    });
  }

  mention(meeting_id: string, mention: Mention) {
    return this.launch(meeting_id, async () => {
      const core = this.getCore();
      const state = await core.get_state(this.principal, { meeting_id });
      if (state.meeting_state === 'OPEN' || terminal(state.meeting_state)) stateConflict(state.meeting_state);
      const addressed = state.seats.find(seat => seat.seat_id === mention.seat_id);
      if (!addressed) throw { code: 'not_found' };
      cliSeat(addressed);
      // The facade mention route records the note as the human's, addressed to the seat.
      await core.openHumanMention(this.principal, { meeting_id, mention });
      return () => this.continueRun(meeting_id);
    });
  }

  resume(meeting_id: string) {
    return this.launch(meeting_id, async () => {
      const core = this.getCore();
      const { meeting_state } = await core.snapshotState(this.principal, { meeting_id });
      if (!inPipeline(meeting_state)) stateConflict(meeting_state);
      const state = await core.getRunnerState(this.principal, { meeting_id });
      if (!inPipeline(state.meeting_state)) stateConflict(state.meeting_state);
      const plan = continuation(state);
      plan.seats.forEach(cliSeat);
      // R1 is mandatory after an undirected R0, with fresh assignments for every seat.
      if (plan.step === 'round' && plan.round === 'R0' && !plan.directed) state.seats.forEach(cliSeat);
      return () => this.continueRun(meeting_id);
    });
  }

  private async launch(meeting_id: string, prepare: () => Promise<() => Promise<void>>) {
    if (this.active.has(meeting_id)) throw { code: 'runner_active' };
    this.active.add(meeting_id);
    try {
      const run = await prepare();
      this.lastErrors.delete(meeting_id);
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
    if (phase === 'error' && detail !== null) this.lastErrors.set(meeting_id, detail);
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

  private async continueRun(meeting_id: string) {
    const core = this.getCore();
    for (;;) {
      const plan = continuation(await core.getRunnerState(this.principal, { meeting_id }));
      switch (plan.step) {
        case 'complete':
          return;
        case 'open_r1':
          await core.open_round(this.principal, { meeting_id, round: 'R1' });
          break;
        case 'gate':
          await this.chairStep(meeting_id, 'gate', gateInstructions, gateArgs,
            args => core.chair_gate(this.principal, args));
          break;
        case 'synthesis':
          await this.synthesize(meeting_id);
          break;
        case 'round': {
          const seats = plan.seats.map(cliSeat);
          for (const { seat_id } of plan.waive) {
            await core.waive_seat(this.principal, {
              meeting_id, round: plan.round, seat_id, reason_code: 'chair_judgment',
              reason_note: `Human directed this round to ${plan.directed!.seat_id}.`,
            });
          }
          await this.runRound(meeting_id, plan.round, seats, plan.directed?.text ?? undefined);
          break;
        }
      }
    }
  }

  private async runRound(meeting_id: string, round: Round, seats: CliSeat[], mentionText?: string) {
    const core = this.getCore();
    const state = () => core.get_state(this.principal, { meeting_id });
    const frozen = (snapshot: Snapshot) =>
      snapshot.round_states.find(candidate => candidate.round === round)?.phase === 'frozen';
    const pending = (snapshot: Snapshot, seatId: string) => snapshot.reception_table.some(row =>
      row.round === round && row.seat_id === seatId && row.state === 'pending');
    if (frozen(await state())) return;
    for (const { seat_id, kind } of seats) {
      const snapshot = await state();
      if (frozen(snapshot)) break;
      if (!pending(snapshot, seat_id)) continue;
      const assignment = { meeting_id, round, seat_id };
      const input = await getSeatInput(assignment, (_operation, args) =>
        core.dispatch('council.get_packets', args, this.principal));
      const ready = await state();
      if (frozen(ready)) break;
      if (!pending(ready, seat_id)) continue;
      const submit: ToolCaller = (operation, args) => {
        if (operation === 'council.submit_answer') return core.submitAnswerWithInput(this.principal, args, input.receipt);
        throw new RunnerError('internal_error: driver requested an unsupported council operation');
      };
      const prompt = mentionText === undefined ? input.prompt :
        `Direct request from the human to @${seat_id}. Answer this request:\n${mentionText}\n\n${input.prompt}`;
      try {
        await runCliSeat({ ...assignment, prompt }, this.cliConfig(kind), submit, this.execute);
      } catch (error) {
        if (error instanceof CliExecutionError) {
          const failed = await state();
          if (!frozen(failed) && pending(failed, seat_id)) {
            const waiver = {
              ...assignment, reason_code: error.disposition, reason_note: error.message.slice(0, 200),
            };
            try {
              await core.waive_seat(this.principal, waiver);
            } catch (waiveError) {
              if (!record(waiveError) || waiveError.code !== 'invalid_state') throw waiveError;
              if (frozen(await state())) break;
            }
          }
          continue;
        }
        if (error instanceof Error) throw new RunnerError(`seat_driver_error: ${seat_id} failed in ${round}`);
        throw error;
      }
    }
    // The core freezes the round synchronously when the final required seat is resolved.
    if (!frozen(await state())) {
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
        output = await this.execute(this.cliConfig('codex'), `${instructions}${retry}\n\n${packets}`);
      } catch (error) {
        if (error instanceof CliExecutionError) {
          throw new RunnerError(`chair_driver_error: the ${stage} call failed (${error.disposition}: ${error.message})`);
        }
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
