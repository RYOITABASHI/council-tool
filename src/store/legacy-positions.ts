export interface LegacyPositionStep {
  next: LegacyPositionCursor | undefined;
  fixed?: number;
  tick?: bigint;
  pairedMeeting?: string;
}

export interface LegacyPositionCursor {
  key: number;
  minimum: number;
  steps(): LegacyPositionStep[];
}

export interface LegacyPositionHistory {
  id: string;
  anchors: ReadonlySet<number>;
  start: LegacyPositionCursor;
}

export function legacyPositionsFit(histories: LegacyPositionHistory[], limit: number): boolean {
  const owners = new Map<number, number>();
  const meetings = new Map(histories.map(({ id }, index) => [id, index]));
  for (const [index, { anchors }] of histories.entries()) {
    for (const position of anchors) {
      if (position < 1 || position > limit || owners.has(position)) return false;
      owners.set(position, index);
    }
  }
  const anchors = [...owners.keys()].sort((a, b) => a - b);
  type Placement = {
    cursors: (LegacyPositionCursor | undefined)[];
    position: number;
    anchor: number;
    tick?: bigint;
  };

  function* place({ cursors, position, anchor, tick }: Placement): Generator<Placement> {
    const fixed = anchors[anchor];
    if (cursors.reduce((sum, cursor) => sum + (cursor?.minimum ?? 0), 0) > limit - position + 1) return;
    const required = fixed === position ? owners.get(fixed) : undefined;
    // Try the meetings with the nearest recorded position first. At an
    // unrecorded position, only unanchored operations can be placed.
    const candidates = required === undefined ?
      [...cursors.keys()].sort((a, b) => nextAnchor(a) - nextAnchor(b)) : [required];
    function nextAnchor(index: number) {
      return anchors.find((value, i) => i >= anchor && owners.get(value) === index) ?? Infinity;
    }

    for (const index of candidates) {
      for (const step of cursors[index]?.steps() ?? []) {
        if (step.fixed !== (required === undefined ? undefined : position) ||
            (step.tick !== undefined && tick !== undefined && step.tick < tick)) continue;
        const nextTick = step.tick ?? tick;
        const placed = {
          position: position + 1, anchor: anchor + Number(required !== undefined),
          ...(nextTick === undefined ? {} : { tick: nextTick }),
        };
        const next = cursors.slice();
        next[index] = step.next;
        if (step.pairedMeeting !== undefined) {
          const partner = meetings.get(step.pairedMeeting);
          // The child has the creation tick. Evaluate the pair from that side.
          if (partner === undefined || step.tick === undefined) continue;
          // Reopening updates the parent and creates the child in one call.
          for (const other of cursors[partner]?.steps() ?? []) {
            if (other.pairedMeeting !== histories[index].id || other.fixed !== undefined || other.tick !== undefined) continue;
            next[partner] = other.next;
            yield { ...placed, cursors: next.slice() };
          }
        } else {
          yield { ...placed, cursors: next };
        }
      }
    }
    // Reads, rejected requests and omitted revisions can leave gaps in
    // the legacy evidence. Jump over gaps without enumerating their positions.
    if (fixed !== undefined && position < fixed) {
      yield { cursors, position: fixed, anchor, ...(tick === undefined ? {} : { tick }) };
    }
  }

  const first = { cursors: histories.map(({ start }) => start), position: 1, anchor: 0 };
  const earliest = new Map<string, number>();
  const search = [place(first)];
  while (search.length > 0) {
    const result = search.at(-1)!.next();
    if (result.done) {
      search.pop();
      continue;
    }
    const next = result.value;
    if (next.cursors.every(cursor => cursor === undefined) && next.anchor === anchors.length) return true;
    if (next.position > limit) continue;
    const atAnchor = next.position === anchors[next.anchor];
    const key = [next.anchor, atAnchor, next.tick, ...next.cursors.map(cursor => cursor?.key)].join(':');
    if ((earliest.get(key) ?? Infinity) <= next.position) continue;
    earliest.set(key, next.position);
    search.push(place(next));
  }
  return histories.length === 0;
}
