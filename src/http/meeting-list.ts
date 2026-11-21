import { closeSync, constants, openSync } from 'node:fs';
import { compare, iso, parseAbsolute } from '../core/clock.js';
import type { Meeting } from '../core/model.js';
import { MEETING_STATES } from '../core/types.js';
import type { Packet } from '../packet/index.js';
import { entryName, revisionGeneration, StoreFiles } from '../store/files.js';
import type { Checkpoint } from '../store/index.js';

type Manifest = { meetings: Record<string, string>; checkpoint: Pick<Checkpoint, 'wall'>; generation?: number };
type MeetingRevision = Omit<Meeting, 'packets'> & { generation?: number; packets: { packet_id: string }[] };

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
    const meeting = files.readRevision<MeetingRevision>(dir, name, generation > 0 && generation === manifest.generation);
    if (meeting.id !== id || (meeting.generation ?? 0) !== generation || typeof meeting.topic !== 'string' ||
        !MEETING_STATES.includes(meeting.state) || !Array.isArray(meeting.setup?.seats)) {
      throw new Error('Invalid meeting revision');
    }
    const seat_ids = meeting.setup.seats.map(seat => {
      if (typeof seat?.seat_id !== 'string' || !seat.seat_id) throw new Error('Invalid meeting seat');
      return seat.seat_id;
    });
    const packets = files.inDirectory(dir, 'packets', packetDir => meeting.packets.map(({ packet_id }) => {
      const { header } = files.read<Packet>(packetDir, entryName(packet_id) + '.json', 'packet');
      if (header.meeting_id !== id || header.packet_id !== packet_id) throw new Error('Invalid meeting packet');
      return { kind: header.kind, time: timestamp(header.created_at) };
    }));
    const agenda = packets[0];
    if (agenda?.kind !== 'agenda') throw new Error('Missing original meeting agenda');

    let updated = agenda.time;
    if (generation > 0) {
      const activity = generation === manifest.generation ? manifest : readManifest(files, generation);
      if (activity?.generation !== generation || activity.meetings[id] !== revision) {
        throw new Error('Invalid meeting checkpoint');
      }
      const wall = activity.checkpoint.wall;
      if (typeof wall !== 'string' || !/^-?\d+$/.test(wall)) throw new Error('Invalid meeting checkpoint time');
      updated = timestamp(iso(BigInt(wall)));
    } else {
      // Legacy revisions have no per-revision checkpoint wall time.
      const activity = [
        ...packets.map(packet => packet.time),
        ...meeting.audit.map(event => timestamp(event.at)),
        ...meeting.rounds.map(round => timestamp(round.state.opened_at)),
      ];
      updated = activity.reduce((latest, time) => compare(latest.instant, time.instant) < 0 ? time : latest, updated);
    }
    return {
      activity: updated.instant,
      summary: {
        meeting_id: id, topic: meeting.topic, meeting_state: meeting.state,
        created_at: agenda.time.value, updated_at: updated.value, seat_ids,
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
    const files = new StoreFiles(fd);
    const generation = files.checkpointGeneration();
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
    return meetings.sort((a, b) => compare(b.activity, a.activity)).map(({ summary }) => summary);
  } finally {
    closeSync(fd);
  }
}
