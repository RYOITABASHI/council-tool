import { closeSync, constants, fstatSync, openSync, statSync } from 'node:fs';
import { compare, iso, parseAbsolute } from '../core/clock.js';
import type { Meeting } from '../core/model.js';
import { MEETING_STATES } from '../core/types.js';
import { entryName, ManifestFile, revisionGeneration, sameIdentity, StoreFiles } from '../store/files.js';
import { flock, trustedPacket } from '../store/index.js';
import type { Checkpoint } from '../store/index.js';

type Manifest = {
  meetings: Record<string, string>;
  checkpoint: Pick<Checkpoint, 'wall'>;
  generation?: number;
  revisionDigests?: Record<string, string>;
};
type MeetingRevision = Omit<Meeting, 'packets'> & {
  generation?: number;
  packets: { packet_id: string; packet_digest?: string }[];
};

function readManifest(files: StoreFiles, generation: number): Manifest | null {
  if (generation > 0) return JSON.parse(files.readCheckpoint(generation)) as Manifest;
  try {
    return files.read<Manifest | null>(files.root, 'manifest.json', 'manifest');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function timestamp(value: string) {
  const instant = typeof value === 'string' && parseAbsolute(value);
  if (!instant) throw new Error('Invalid meeting timestamp');
  return { value, instant };
}

function readSummary(files: StoreFiles, manifest: Manifest, id: string, revision: string) {
  const name = entryName(revision) + '.json';
  const generation = revisionGeneration(name);
  if (generation > (manifest.generation ?? 0)) throw new Error('Invalid meeting revision generation');

  return files.inDirectory(files.root, id, dir => {
    // A committed checkpoint can reference a revision whose final name is still being published.
    const meeting = files.readRevision<MeetingRevision>(dir, name, generation > 0 && generation === manifest.generation,
      manifest.revisionDigests?.[id]);
    if (meeting.id !== id || (meeting.generation ?? 0) !== generation || typeof meeting.topic !== 'string' ||
        !MEETING_STATES.includes(meeting.state) || !Array.isArray(meeting.setup?.seats)) {
      throw new Error('Invalid meeting revision');
    }
    const seat_ids = meeting.setup.seats.map(seat => {
      if (typeof seat?.seat_id !== 'string' || !seat.seat_id) throw new Error('Invalid meeting seat');
      return seat.seat_id;
    });
    const packets = files.inDirectory(dir, 'packets', packetDir => meeting.packets.map(({ packet_id, packet_digest }, index) => {
      const read = files.readPacketOrQuarantine<unknown>(packetDir, entryName(packet_id) + '.json', packet_digest);
      const packet = 'value' in read ? trustedPacket(read.value, id, packet_id) : undefined;
      // PR-D: a quarantined packet is not trusted for timing, but the meeting stays listed.
      if (!packet) return undefined;
      if (index === 0 && packet.header.kind !== 'agenda') throw new Error('Missing original meeting agenda');
      return { kind: packet.header.kind, time: timestamp(packet.header.created_at) };
    }));
    if (packets.length === 0) throw new Error('Missing original meeting agenda');
    const trusted = packets.flatMap(packet => packet ? [packet] : []);
    const roundTimes = () => meeting.rounds.map(round => timestamp(round.state.opened_at));
    const auditTimes = () => meeting.audit.map(event => timestamp(event.at));
    const checkpointTime = (wall: unknown) => {
      if (typeof wall !== 'string' || !/^-?\d+$/.test(wall)) throw new Error('Invalid meeting checkpoint time');
      return timestamp(iso(BigInt(wall)));
    };
    const earliest = (times: ReturnType<typeof timestamp>[]) =>
      times.reduce<ReturnType<typeof timestamp> | undefined>((first, time) =>
        !first || compare(time.instant, first.instant) < 0 ? time : first, undefined);

    let checkpointed: ReturnType<typeof timestamp> | undefined;
    if (generation > 0) {
      const activity = generation === manifest.generation ? manifest : readManifest(files, generation);
      if (activity?.generation !== generation || activity.meetings[id] !== revision) {
        throw new Error('Invalid meeting checkpoint');
      }
      checkpointed = checkpointTime(activity.checkpoint.wall);
    }
    // The original agenda's time is the creation time. PR-D: if it is quarantined, the earliest
    // trusted activity stands in for it, and failing that the revision's checkpoint time.
    const created = packets[0]?.time ?? earliest([...trusted.map(packet => packet.time), ...roundTimes(), ...auditTimes()]) ??
      checkpointed ?? checkpointTime(manifest.checkpoint?.wall);

    let updated = checkpointed ?? created;
    if (generation === 0) {
      // Legacy revisions have no per-revision checkpoint wall time.
      const activity = [
        ...trusted.map(packet => packet.time), ...auditTimes(), ...roundTimes(),
      ];
      updated = activity.reduce((latest, time) => compare(latest.instant, time.instant) < 0 ? time : latest, updated);
    }
    return {
      activity: updated.instant,
      summary: {
        meeting_id: id, topic: meeting.topic, meeting_state: meeting.state,
        created_at: created.value, updated_at: updated.value, seat_ids,
      },
    };
  });
}

export function listMeetings(home: string) {
  let fd: number;
  try {
    fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    flock(fd, '--shared');
    const identity = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity, statSync(home, { bigint: true, throwIfNoEntry: false }))) {
      throw new Error('Council store directory changed');
    }
    const files = new StoreFiles(fd);
    const generation = files.checkpointGeneration();
    const manifestFile = new ManifestFile(files.root.path, `${identity.dev}:${identity.ino}`, fd, files);
    const durable = manifestFile.readDurable();
    const init = manifestFile.classifyInit(generation, durable, manifestFile.readEnrollment(), true);
    if (init) return [];
    files.checkRevisionGeneration(generation);
    if (durable?.record.manifest) {
      const recorded = JSON.parse(durable.record.manifest) as Manifest | null;
      if (!recorded || (recorded.generation ?? 0) > generation) throw new Error('Invalid meeting manifest checkpoint record');
    }
    const manifest = readManifest(files, generation);
    if (manifest === null && generation === 0) return [];
    if (!manifest?.meetings || typeof manifest.meetings !== 'object' || Array.isArray(manifest.meetings) ||
        (manifest.generation ?? 0) !== generation) {
      throw new Error('Invalid meeting manifest');
    }
    const meetings = Object.entries(manifest.meetings).flatMap(([id, revision]) => {
      try {
        return [readSummary(files, manifest, id, revision)];
      } catch {
        // A damaged meeting does not prevent summaries for other meetings.
        return [];
      }
    });
    if (!sameIdentity(identity, statSync(home, { bigint: true, throwIfNoEntry: false }))) {
      throw new Error('Council store directory changed');
    }
    return meetings.sort((a, b) => compare(b.activity, a.activity)).map(({ summary }) => summary);
  } finally {
    closeSync(fd);
  }
}
