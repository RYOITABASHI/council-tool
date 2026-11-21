import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMeetingViews } from '../dist/http/meeting-views.js';

async function main() {
  const [meetingId, outputDir] = process.argv.slice(2);
  if (!meetingId || !outputDir) {
    throw new Error('Usage: COUNCIL_HOME=<home> COUNCIL_PRINCIPAL=<id> node scripts/dump-meeting.mjs <meeting_id> <output_dir>');
  }

  const views = createMeetingViews();
  try {
    const meetings = views.list();
    const state = await views.state(meetingId);
    const packets = await views.packets(meetingId);
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'meetings.json'), JSON.stringify(meetings, null, 2) + '\n');
    await writeFile(join(outputDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    await writeFile(join(outputDir, 'packets.json'), JSON.stringify(packets, null, 2) + '\n');
  } finally {
    views.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
