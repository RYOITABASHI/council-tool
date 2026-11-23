import { randomUUID } from 'node:crypto';
import { bodySha } from '../packet/index.js';
import { FileStore, requireClockEpoch, StorePresence, storePollIntervalMs, withStoreAccess } from '../store/index.js';
import type { Checkpoint, Store } from '../store/index.js';
import { compare, instant, systemClock } from './clock.js';
import type { Clock, ClockSample, Instant } from './clock.js';
import {
  absence, anySeat, append, audit, bound, checkOverride, currentRound, findPacket, findRound, findRow,
  findSeat, freeze, ok, open, pending, receptionDetail, sameSeatBinding, startRound, stateError,
} from './meeting.js';
import { answer } from './model.js';
import type { Delivery, Meeting, Operation, Operations, Principal, Setup } from './model.js';
import { resolveMaterial, synthesis } from './synthesis.js';
import type { CouncilError, StoredSeatConfig } from './types.js';
import { fail, mergeSetup, record, requireArgument, validate } from './validation.js';
import { getPackets, getState } from './views.js';

export type { Clock, ClockSample, Deadline } from './clock.js';
export type { ChairConfig, Operation, Operations, Principal, RoundSettings } from './model.js';
export type * from './types.js';

export interface CoreOptions {
  home?: string;
  store?: Store;
  clock?: Clock;
  /** Trusted host directory for principals whose identity type is known in advance. */
  isHuman?: (principal: string) => boolean;
}

interface Call {
  received: bigint;
  now: ClockSample;
  position: number;
  principal: string;
  principalHuman: boolean;
  human: boolean;
  add: (meeting: Meeting) => void;
}

function newDelivery(seat_id: string, epoch = 1): Delivery {
  return { seat_id, epoch, sent: [], ack: [], notices: [] };
}

function newMeeting(topic: string, setup: Setup, c: Call, reopens: string | null = null) {
  const m: Meeting = {
    id: randomUUID(), topic, setup, setupVersion: 1, convener: c.principal, convenerHuman: c.principalHuman,
    state: 'CREATED', reopens, created: String(c.now.monotonic), timeoutAt: null, timeoutOrder: 0,
    timeoutExceeded: false, rounds: [], packets: [], confirmations: [], audit: [],
    delivery: setup.seats.map(s => newDelivery(s.seat_id)),
  };
  append(m, c.now, 'agenda', { round: null, seat_id: null, supersedes: null },
    { topic, shared_materials: setup.shared_materials });
  c.add(m);
  return m.id;
}

function chairOnly(m: Meeting, c: Call) {
  if (m.setup.chair.principal !== c.principal) fail('unauthorized');
}

function humanOnly(c: Call) {
  if (!c.human) fail('unauthorized');
}

function seatOrFail(m: Meeting, id: string) {
  const seat = findSeat(m, id);
  if (!seat) fail('not_found');
  return seat;
}

function used(m: Meeting, seat: StoredSeatConfig): number {
  return m.packets.filter(p => p.packet.header.seat_id === seat.seat_id &&
    (answer(p) || p.packet.header.kind === 'flash')).length;
}

const terminal = (m: Meeting) => m.state === 'APPROVED' || m.state === 'REJECTED';
const closedSeat = (state: string | undefined) => state === 'absent' || state === 'waived';
const result = (packet: { header: { packet_id: string; packet_sha: string } }) =>
  ({ ...ok, packet_id: packet.header.packet_id, packet_sha: packet.header.packet_sha });

function postNote(m: Meeting, c: Call, body: Operations['post_message']['body']) {
  const round = m.state === 'OPEN' && !anySeat(m, c.principal) ? currentRound(m)?.state.round : undefined;
  return result(append(m, c.now, 'note', { round: null, seat_id: null, supersedes: null },
    body, round === undefined ? {} : { heldFor: round }));
}

function submit(m: Meeting, c: Call, a: Operations['submit_answer'], web: boolean) {
  const convenerTranscribing = web && m.convener === c.principal;
  if (!convenerTranscribing && !anySeat(m, c.principal)) fail('unauthorized');
  const seat = seatOrFail(m, a.seat_id);
  if (!bound(seat, c.principal) && !convenerTranscribing) fail('unauthorized');
  const r = findRound(m, a.round);
  const row = findRow(r, a.seat_id);
  const supersedes = a.supersedes ?? null;
  const predecessor = row?.current_packet_id ?? row?.invalidated_packet_id ?? null;
  requireArgument(supersedes === predecessor);
  // Every admitted first version was eligible. Its descendants inherit that fact.
  const deadline_eligible = !r ? null :
    !r.deadline || predecessor !== null || compare(instant(c.received), r.deadline) <= 0;
  const quotaExceeded = used(m, seat) >= seat.quota;
  if (!open(m, r) || (seat.connection === 'web') !== web ||
      (r?.directedSeatId !== undefined && r.directedSeatId !== a.seat_id) ||
      closedSeat(row?.state) || !deadline_eligible || quotaExceeded) {
    fail('invalid_state', {
      ...receptionDetail(r, row), deadline_eligible, ...(quotaExceeded ? { quota_exceeded: true } : {}),
    });
  }
  const body = { body: a.body, ...(a.claims === undefined ? {} : { claims: a.claims }) };
  const metadata = web ? { verification: 'unverified', reception: 'transcribed_pending_attest' } as const :
    { verification: 'not_applicable', reception: 'received' } as const;
  const state = metadata.reception;
  const location = { seat_id: a.seat_id, supersedes };
  const packet = a.round === 'R1' ? append(m, c.now, 'critique', { ...location, round: 'R1' }, body, metadata) :
    append(m, c.now, 'answer', { ...location, round: a.round }, body, metadata);
  row!.current_packet_id = packet.header.packet_id;
  row!.state = state;
  freeze(m, r!, c.now, c.position);
  return result(packet);
}

function markSeat(m: Meeting, c: Call, a: Operations['declare_absent'] | Operations['waive_seat']) {
  chairOnly(m, c);
  seatOrFail(m, a.seat_id);
  const r = findRound(m, a.round);
  const row = findRow(r, a.seat_id);
  if (!open(m, r) || !row || !pending(row)) fail('invalid_state', receptionDetail(r, row));
  if ('reason_code' in a) {
    row.state = 'waived';
    row.reason = { code: a.reason_code, text: a.reason_note ?? null };
  } else {
    absence(row, 'chair_declared');
  }
  audit(m, c.now, 'reason_code' in a ? 'waive_seat' : 'declare_absent', row.state, {
    round: a.round, seat_id: row.seat_id, reason: row.reason,
  });
  freeze(m, r!, c.now, c.position);
  return ok;
}

type Sweep = { id: string; at: Instant; kind: 'deadline' | 'timeout'; order: number };

function recoveredOffset(cp: Checkpoint, monotonic: bigint): bigint {
  // Different epochs have no common monotonic origin. Resume at the last durable tick.
  return BigInt(cp.monotonic) - monotonic;
}

export class Core {
  private readonly meetings = new Map<string, Meeting>();
  private readonly clock: Clock;
  private clockOffset = 0n;
  private readonly clockEpoch: string | undefined;
  private readonly store: Store | undefined;
  private readonly presence = new StorePresence();
  private fileBackend: FileStore | undefined;
  private readonly isHuman: CoreOptions['isHuman'];
  private readonly knownHumans = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly storePoll: ReturnType<typeof setInterval> | undefined;
  private position = 0;
  private closed = false;

  constructor(options: CoreOptions = {}) {
    const clock = options.clock ?? systemClock;
    const epoch = clock.epoch;
    this.store = options.store;
    if (this.store?.transaction) requireClockEpoch(epoch);
    if (!this.store && options.home !== undefined) {
      requireClockEpoch(epoch);
      this.store = new FileStore(options.home, { epoch });
    }
    this.isHuman = options.isHuman;
    this.clockEpoch = epoch;
    const store = this.store;
    this.clock = {
      now: () => {
        const sample = clock.now();
        return { ...sample, monotonic: sample.monotonic + this.clockOffset };
      },
    };
    try {
      const loaded = store && this.accessStore(() => store.load(epoch));
      const transaction = this.storeTransaction();
      const cp = loaded?.checkpoint;
      if (store && transaction) {
        requireClockEpoch(this.clockEpoch);
        if (cp) requireClockEpoch(cp.epoch);
        this.accessStore(() => transaction(() => this.restoreShared(store, clock.now())));
      } else {
        if (cp && (!this.clockEpoch || cp.epoch !== this.clockEpoch)) {
          this.clockOffset = recoveredOffset(cp, clock.now().monotonic);
        }
        this.restore(loaded);
      }
      this.arm();
    } catch (error) {
      this.presence.close();
      throw error;
    }
    if (store) {
      // One interval both detects late activation and polls an active backend.
      this.storePoll = setInterval(() => {
        void this.refreshStore().catch(() => undefined);
      }, storePollIntervalMs);
      this.storePoll.unref();
    }
  }

  private accessStore<T>(work: () => T): T {
    return withStoreAccess({
      epoch: this.clockEpoch,
      presence: this.presence,
      observeFileStore: backend => { this.fileBackend = backend; },
    }, work);
  }

  private storeTransaction(): Store['transaction'] {
    const backend = this.store?.transaction ? this.store : this.fileBackend;
    return backend?.transaction?.bind(backend);
  }

  private restore(loaded: ReturnType<Store['load']> | undefined): void {
    const cp = loaded?.checkpoint;
    if (cp && this.clockEpoch !== undefined && cp.epoch === this.clockEpoch) {
      this.clockOffset = BigInt(cp.offset);
    }
    this.position = cp?.position ?? 0;
    this.knownHumans.clear();
    for (const id of cp?.humanPrincipals ?? []) this.knownHumans.add(id);
    this.meetings.clear();
    for (const m of loaded?.meetings ?? []) {
      this.meetings.set(m.id, m);
      if (m.convenerHuman) this.knownHumans.add(m.convener);
    }
  }

  private restoreShared(store: Store, raw: ClockSample): void {
    const loaded = store.load(this.clockEpoch);
    requireClockEpoch(this.clockEpoch);
    const cp = loaded.checkpoint;
    if (cp) {
      requireClockEpoch(cp.epoch);
      if (cp.epoch !== this.clockEpoch && !this.presence.canReanchor) {
        throw new Error('Council store epoch recovery requires exclusive presence');
      }
    }
    this.restore(loaded);
    if (cp?.epoch !== this.clockEpoch) {
      this.clockOffset = cp ? recoveredOffset(cp, raw.monotonic) : 0n;
      store.commit([], this.checkpoint({ wall: raw.wall, monotonic: raw.monotonic + this.clockOffset }));
    } else if (raw.monotonic + this.clockOffset < BigInt(cp.monotonic)) {
      throw new Error('Council store clock sample moved backward');
    }
  }

  /** Stop background sweeps and release the core's shared store presence. */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.storePoll);
    this.presence.close();
  }

  private async refreshStore(): Promise<void> {
    const store = this.store;
    if (this.closed || !store) return;
    // Poll transactional peers even when an adapter preloaded the latest snapshot
    // before exposing its transaction lock.
    if (this.storeTransaction() || this.accessStore(() => store.hasChanges?.() ?? true)) {
      await this.enqueue(admitted => this.sweepBefore(admitted), true);
    }
  }

  /** Process due items with the injected clock, without waiting for the host timer. */
  sweep(): Promise<void> {
    return this.enqueue(admitted => this.sweepBefore(admitted));
  }

  readonly dispatch = (operation: Operation | `council.${Operation}`, args: unknown, principal: Principal) => {
    const name = operation.replace(/^council\./, '') as Operation;
    if (!Object.hasOwn(this, name) || !Object.hasOwn(operationNames, name)) {
      return Promise.reject({ code: 'invalid_argument' } satisfies CouncilError);
    }
    return this[name](principal, args);
  };

  private enqueue<T>(work: (received: bigint) => T, refresh = false): Promise<T> {
    const store = this.store;
    const local = this.storeTransaction() || refresh ? undefined : this.registerLocally(work);
    const register = (): T => this.accessStore(() => {
      if (this.closed) throw new Error('Council core is closed');
      let transaction = this.storeTransaction();
      if (store && !transaction && refresh) {
        const loaded = store.load(this.clockEpoch);
        transaction = this.storeTransaction();
        // A synchronous snapshot adapter can share the timeline without exposing a lock.
        if (!transaction && loaded.checkpoint?.epoch === this.clockEpoch && this.clockEpoch !== undefined) {
          requireClockEpoch(this.clockEpoch);
          this.restore(loaded);
        }
      }
      if (!store || !transaction) return (local ?? this.registerLocally(work))();
      requireClockEpoch(this.clockEpoch);
      return transaction(() => {
        // Registration and timer sweeps share the same order across processes.
        const now = this.clock.now();
        const raw = { wall: now.wall, monotonic: now.monotonic - this.clockOffset };
        this.restoreShared(store, raw);
        return work(raw.monotonic + this.clockOffset);
      });
    });
    const next = this.tail.then(register).finally(() => this.arm());
    this.tail = next.catch(() => undefined);
    return next;
  }

  private registerLocally<T>(work: (received: bigint) => T): () => T {
    const received = this.clock.now().monotonic;
    return () => work(received);
  }

  private scheduled(): Sweep[] {
    const items: Sweep[] = [];
    for (const m of this.meetings.values()) {
      const r = currentRound(m);
      if (open(m, r) && r?.deadline && !r.swept) {
        items.push({ id: m.id, at: r.deadline, kind: 'deadline', order: r.sweepOrder });
      }
      if (m.timeoutAt !== null) {
        items.push({ id: m.id, at: instant(BigInt(m.timeoutAt)), kind: 'timeout', order: m.timeoutOrder });
      }
    }
    return items.sort((a, b) => compare(a.at, b.at) ||
      (a.kind === b.kind ? a.order - b.order : a.kind === 'deadline' ? -1 : 1));
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.closed) return;
    const [next] = this.scheduled();
    if (!next) return;
    const delayMs = (BigInt(next.at.ns) - this.clock.now().monotonic) / 1_000_000n;
    const delay = delayMs >= 2_147_483_647n ? 2_147_483_647 : Math.max(1, Number(delayMs) + 1);
    this.timer = setTimeout(() => {
      // A failed file commit leaves the sweep pending. The next queue turn retries it.
      void this.sweep().catch(() => undefined);
    }, delay);
    this.timer.unref();
  }

  private checkpoint(now: ClockSample, observedHuman?: string): Checkpoint {
    const humanPrincipals = [...this.knownHumans];
    if (observedHuman !== undefined) humanPrincipals.push(observedHuman);
    return {
      monotonic: String(now.monotonic), wall: String(now.wall), position: this.position,
      offset: String(this.clockOffset), ...(this.clockEpoch === undefined ? {} : { epoch: this.clockEpoch }),
      ...(humanPrincipals.length ? { humanPrincipals } : {}),
    };
  }

  private persist(meetings: Meeting[], now: ClockSample, observedHuman?: string) {
    if (this.store?.transaction) requireClockEpoch(this.clockEpoch);
    this.store?.commit(meetings, this.checkpoint(now, observedHuman));
    if (observedHuman !== undefined) this.knownHumans.add(observedHuman);
    for (const m of meetings) this.meetings.set(m.id, m);
  }

  private sweepBefore(cutoff: bigint): void {
    for (;;) {
      const [item] = this.scheduled();
      if (!item || compare(item.at, instant(cutoff)) >= 0) return;
      const now = this.clock.now();
      const m = structuredClone(this.meetings.get(item.id)!);
      const position = ++this.position;
      if (item.kind === 'deadline') {
        const r = currentRound(m)!;
        r.swept = true;
        for (const row of r.rows) {
          if (row.state === 'pending') absence(row, 'deadline_no_submission');
        }
        freeze(m, r, now, position);
      } else {
        m.timeoutAt = null;
        m.timeoutExceeded = true;
        audit(m, now, 'sweep', 'timeout_exceeded');
      }
      this.persist([m], now);
    }
  }

  private identity(value: Principal): { id: string; human: boolean } {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string' || id.length === 0) fail('unauthorized');
    if (typeof value !== 'string' && value.kind !== 'human' && value.kind !== 'agent') fail('unauthorized');
    const human = this.isHuman?.(id) ??
      (typeof value === 'string' ? this.knownHumans.has(id) : value.kind === 'human');
    return { id, human };
  }

  private run<N extends Operation, T>(name: N, principal: Principal, raw: unknown,
    action: (m: Meeting, a: Operations[N], c: Call) => T, readOnly = false): Promise<T> {
    // Copy before queueing so caller mutations cannot change queued requests.
    let input: unknown;
    try {
      input = structuredClone(raw);
      principal = structuredClone(principal);
    } catch {
      return Promise.reject({ code: 'invalid_argument' } satisfies CouncilError);
    }
    return this.enqueue(received => {
      this.sweepBefore(received);
      const now = this.clock.now();
      const position = ++this.position;
      let original: Meeting | undefined;
      let next: Meeting | undefined;
      let observedHuman: string | undefined;
      const created: Meeting[] = [];
      let output: T;
      try {
        const a = validate(name, input);
        const { id, human: principalHuman } = this.identity(principal);
        if (!this.isHuman && principalHuman && !this.knownHumans.has(id)) observedHuman = id;
        let human = principalHuman;
        if ('meeting_id' in a) {
          original = this.meetings.get(a.meeting_id);
          if (!original) fail('unauthorized');
          next = structuredClone(original);
          const chair = next.setup.chair.principal === id;
          const convener = next.convener === id;
          human = principalHuman && (convener || chair || next.setup.human_participants.includes(id));
          if (!chair && !convener && !human && !anySeat(next, id)) {
            original = undefined;
            fail('unauthorized');
          }
        }
        output = action(next!, a, { received, now, position, principal: id, principalHuman, human,
          add: m => created.push(m) });
      } catch (error) {
        const rawMeeting = record(input) && typeof input.meeting_id === 'string'
          ? this.meetings.get(input.meeting_id) : undefined;
        const principalId = typeof principal === 'string' ? principal : principal?.id;
        const logMeeting = original ?? (name === 'submit_attest' || rawMeeting?.convener === principalId ||
          rawMeeting?.setup.chair.principal === principalId ||
          (rawMeeting && principalId && (anySeat(rawMeeting, principalId) ||
            rawMeeting.setup.human_participants.includes(principalId))) ? rawMeeting : undefined);
        if (record(error) && typeof error.code === 'string') {
          if (logMeeting) {
            const copy = structuredClone(logMeeting);
            audit(copy, now, name, error.code, error.detail);
            this.persist([copy], now, observedHuman);
          } else if (observedHuman !== undefined) {
            this.persist([], now, observedHuman);
          }
        }
        throw error;
      }
      const deliveryChanged = name === 'get_packets' && next && original && (next.audit.length !== original.audit.length ||
        next.delivery.some((d, i) => {
          const before = original!.delivery[i];
          return d.sent.length !== before.sent.length || d.ack.length !== before.ack.length ||
            d.notices.length !== before.notices.length;
        }));
      const write = !readOnly && (name !== 'get_packets' || deliveryChanged);
      const changed = [...(next && write ? [next] : []), ...created];
      if (changed.length || observedHuman !== undefined) this.persist(changed, now, observedHuman);
      return structuredClone(output);
    });
  }

  create_meeting = (p: Principal, a: unknown) =>
    this.run('create_meeting', p, a, (_, args, c) => ({
      ...ok, meeting_id: newMeeting(args.topic, mergeSetup(args), c),
    }));

  update_setup = (p: Principal, a: unknown) =>
    this.run('update_setup', p, a, (m, args, c) => {
      if (m.convener !== c.principal) chairOnly(m, c);
      const setup = mergeSetup(args, m.setup);
      if (m.state !== 'CREATED') stateError(m);
      m.delivery = setup.seats.map(s => {
        const before = findSeat(m, s.seat_id);
        const existing = m.delivery.find(d => d.seat_id === s.seat_id);
        if (!before || !existing) return newDelivery(s.seat_id);
        return sameSeatBinding(before, s) ? existing :
          newDelivery(s.seat_id, existing.epoch + 1);
      });
      if (JSON.stringify(m.setup.shared_materials) !== JSON.stringify(setup.shared_materials)) {
        const agenda = m.packets.find(p => p.packet.header.kind === 'agenda' && p.version === 'current')!;
        append(m, c.now, 'agenda', { round: null, seat_id: null, supersedes: agenda.packet.header.packet_id },
          { topic: m.topic, shared_materials: setup.shared_materials });
      }
      m.setup = setup;
      m.setupVersion++;
      return { ...ok, meeting_state: m.state };
    });

  open_round = (p: Principal, a: unknown) =>
    this.run('open_round', p, a, (m, args, c) => {
      chairOnly(m, c);
      checkOverride(args.deadline, c.now);
      const recognized = (id: string) => this.isHuman?.(id) ?? this.knownHumans.has(id);
      const hasHuman = () => c.principalHuman || recognized(m.convener) || m.setup.human_participants.some(recognized);
      if ('mention' in args) {
        if (m.state === 'OPEN' || terminal(m) || (m.state === 'CREATED' && !hasHuman())) stateError(m);
        const { seat_id, text } = args.mention;
        const seat = seatOrFail(m, seat_id);
        if (used(m, seat) >= seat.quota) fail('invalid_state', { meeting_state: m.state, seat_id, quota_exceeded: true });
        // Admit the note and its round together so a rejected opening leaves no stray note.
        postNote(m, c, { text });
        return { ...ok, round_state: startRound(m, `R${m.rounds.length}`, args.deadline, c.now, c.position, seat_id) };
      }
      if (args.round === 'R0' ? m.state !== 'CREATED' || !hasHuman()
        : m.state !== 'GATE' || currentRound(m)?.state.round !== 'R0') stateError(m);
      return { ...ok, round_state: startRound(m, args.round, args.deadline, c.now, c.position) };
    });

  submit_answer = (p: Principal, a: unknown) =>
    this.run('submit_answer', p, a, (m, args, c) => submit(m, c, args, false));

  transcribe_web_seat = (p: Principal, a: unknown) =>
    this.run('transcribe_web_seat', p, a, (m, args, c) =>
      ({ ...submit(m, c, args, true), attest_required: true as const }));

  submit_flash = (p: Principal, a: unknown) =>
    this.run('submit_flash', p, a, (m, args, c) => {
      const chair = args.seat_id === 'chair';
      if (chair) chairOnly(m, c);
      else if (!m.setup.seats.some(seat => seat.flash && bound(seat, c.principal))) fail('unauthorized');
      const seat = chair ? undefined : seatOrFail(m, args.seat_id);
      if (seat && (!seat.flash || !bound(seat, c.principal))) fail('unauthorized');
      const r = findRound(m, args.round);
      const row = chair ? undefined : findRow(r, args.seat_id);
      const quotaExceeded = seat !== undefined && used(m, seat) >= seat.quota;
      if (!open(m, r) || closedSeat(row?.state) || quotaExceeded) {
        fail('invalid_state', { ...receptionDetail(r, row), ...(quotaExceeded ? { quota_exceeded: true } : {}) });
      }
      return result(append(m, c.now, 'flash', { round: args.round, seat_id: args.seat_id, supersedes: null },
        { body: args.body, basis: args.basis }, anySeat(m, c.principal) ? {} : { heldFor: args.round }));
    });

  submit_attest = (p: Principal, a: unknown) =>
    this.run('submit_attest', p, a, (m, args, c) => {
      const convener = m.convener === c.principal;
      if (args.evidence.confirmer !== c.principal || (!convener &&
          !m.setup.seats.some(s => s.connection === 'web' && bound(s, c.principal)))) fail('unauthorized');
      const target = findPacket(m, args.target_packet_id);
      if (!target) fail('not_found');
      const { seat_id, round } = target.packet.header;
      const seat = findSeat(m, seat_id);
      if (seat?.connection !== 'web' || (!convener && !bound(seat, c.principal))) fail('unauthorized');
      const r = findRound(m, round);
      const row = findRow(r, seat_id);
      const version = answer(target);
      if (!version || !open(m, r) || row?.state !== 'transcribed_pending_attest' ||
          row.current_packet_id !== args.target_packet_id || target.reception !== 'transcribed_pending_attest') {
        fail('invalid_state', {
          target_reception_state: version ? row?.state ?? null : null,
          round_frozen: r?.state.phase === 'frozen',
        });
      }
      append(m, c.now, 'attest', { round: row.round, seat_id: row.seat_id, supersedes: null },
        { method: args.method, result: args.result }, { attest: {
          target_packet_id: args.target_packet_id, confirmer: args.evidence.confirmer,
          body_sha: bodySha(version.body), result: args.result, position: c.position,
        } });
      if (args.result === 'confirmed') {
        row.state = 'received';
        target.reception = 'received';
        target.verification = 'verified';
      } else {
        target.reception = 'invalidated';
        row.current_packet_id = null;
        row.invalidated_packet_id = args.target_packet_id;
        row.state = 'pending';
        if (r!.swept) absence(row, 'deadline_no_submission');
      }
      freeze(m, r!, c.now, c.position);
      return { ...ok, verified_result: args.result };
    });

  get_state = (p: Principal, a: unknown) =>
    this.run('get_state', p, a, (m, _, c) => getState(m, c.principal, c.human), true);

  get_packets = (p: Principal, a: unknown) =>
    this.run('get_packets', p, a, (m, args, c) => getPackets(m, c.principal, c.human, args, c.now, c.position),
      record(a) && a.view === 'oversight');

  declare_absent = (p: Principal, a: unknown) =>
    this.run('declare_absent', p, a, (m, args, c) => markSeat(m, c, args));

  waive_seat = (p: Principal, a: unknown) =>
    this.run('waive_seat', p, a, (m, args, c) => markSeat(m, c, args));

  chair_gate = (p: Principal, a: unknown) =>
    this.run('chair_gate', p, a, (m, args, c) => {
      chairOnly(m, c);
      checkOverride(args.r2_deadline, c.now);
      if (m.state !== 'GATE' || currentRound(m)?.state.round !== 'R1') stateError(m);
      const gate_decision_packet = append(m, c.now, 'gate_decision',
        { round: 'R1', seat_id: null, supersedes: null }, {
          result: args.result, rationale: args.rationale ?? '',
          resolved_points: args.resolved_points ?? [], unresolved_points: args.unresolved_points ?? [],
          next_round_scope: args.next_round_scope ?? [],
        });
      if (args.result === 'pass') {
        m.state = 'SYNTHESIZING';
        m.timeoutAt = null;
      } else startRound(m, 'R2', args.r2_deadline, c.now, c.position);
      return { ...ok, gate_decision_packet };
    });

  synthesize = (p: Principal, a: unknown) =>
    this.run('synthesize', p, a, (m, args, c) => {
      chairOnly(m, c);
      const body = synthesis(m, args.body, c.now);
      const previous = m.packets.find(p => p.packet.header.kind === 'synthesis' && p.version === 'current');
      const synthesis_packet = append(m, c.now, 'synthesis',
        { round: null, seat_id: null, supersedes: previous?.packet.header.packet_id ?? null }, body);
      m.state = 'AWAITING_APPROVAL';
      m.timeoutAt = null;
      return { ...ok, synthesis_packet };
    });

  approve = (p: Principal, a: unknown) =>
    this.run('approve', p, a, (m, args, c) => {
      humanOnly(c);
      if (m.state !== 'AWAITING_APPROVAL') stateError(m);
      m.state = args.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      if (args.decision === 'reopen') {
        m.rejectionReason = 'reopened';
        const new_meeting_id = newMeeting(args.reopen_points!.join(' / '), m.setup,
          { ...c, principalHuman: true }, m.id);
        return { ...ok, meeting_state: m.state, new_meeting_id };
      }
      if (args.decision === 'reject') m.rejectionReason = 'rejected';
      return { ...ok, meeting_state: m.state };
    });

  get_quota = (p: Principal, a: unknown) =>
    this.run('get_quota', p, a, (m, args, c) => {
      if (!anySeat(m, c.principal) && !c.human && m.setup.chair.principal !== c.principal) fail('unauthorized');
      const seat = seatOrFail(m, args.seat_id);
      return { used: used(m, seat), limit: seat.quota };
    }, true);

  post_message = (p: Principal, a: unknown) =>
    this.run('post_message', p, a, (m, args, c) => {
      if (!c.human) chairOnly(m, c);
      if (terminal(m)) stateError(m);
      return postNote(m, c, args.body);
    });

  confirm_share = (p: Principal, a: unknown) =>
    this.run('confirm_share', p, a, (m, args, c) => {
      humanOnly(c);
      const { meeting_id: _, ...confirmation } = args;
      if (args.setup_version !== m.setupVersion) fail('invalid_state', {
        meeting_state: m.state, expected_setup_version: m.setupVersion, provided_setup_version: args.setup_version,
      });
      const sharing_policy = resolveMaterial(m, args.material_ref);
      if (args.to_seat_id !== undefined) seatOrFail(m, args.to_seat_id);
      if (sharing_policy === 'no_share' || (typeof sharing_policy === 'object' &&
          (args.purpose !== 'share_with_seat' || !sharing_policy.seat_ids.includes(args.to_seat_id!)))) {
        fail('invalid_state', { meeting_state: m.state, sharing_policy });
      }
      m.confirmations.push(confirmation);
      return ok;
    });
}

const operationNames = {
  create_meeting: true, update_setup: true, open_round: true, submit_answer: true, transcribe_web_seat: true,
  submit_flash: true, submit_attest: true, get_state: true, get_packets: true, waive_seat: true,
  declare_absent: true, chair_gate: true, synthesize: true, approve: true, get_quota: true, post_message: true,
  confirm_share: true,
} satisfies Record<Operation, true>;

export function createCore(options: CoreOptions = {}): Core {
  return new Core(options);
}
