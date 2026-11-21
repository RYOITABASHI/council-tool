import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.js';
import type { PacketHashInput } from './types.js';

export { canonicalize } from './jcs.js';
export type * from './types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** PROTOCOL.md §3.4 */
export function packetSha({ header, body }: PacketHashInput): string {
  const { created_at, kind, meeting_id, round, seat_id, supersedes } = header;
  return sha256(canonicalize({
    header: { created_at, kind, meeting_id, round, seat_id, supersedes },
    body,
  }));
}

/** PROTOCOL.md §3.2 and §4.3. Hash the stored body.body string as UTF-8. */
export function bodySha(body: string): string {
  return sha256(body);
}
