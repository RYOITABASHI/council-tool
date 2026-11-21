import type { Operations } from '../core/index.js';
import { blank, record, requireArgument, validate } from '../core/validation.js';

export const gateInstructions = `Chair gate. Review the agenda and frozen R0 and R1 packets below.
Return only a JSON object with result ("pass" or "fail") and optional rationale (string), resolved_points,
unresolved_points and next_round_scope (arrays of strings). Default to "pass". Use "fail" only for a specific
unresolved dispute that needs another round. If failing, name the dispute in unresolved_points and specify
what the seats must address in next_round_scope. Both arrays must then be nonempty.`;

export const synthesisInstructions = `Chair synthesis. Use the agenda and frozen meeting packets below.
Return only a JSON object with exactly these fields:
{"agreements":["text"],"minority_opinions":[{"seat_id":"id","opinion":"text"}],
 "reversal_conditions":[{"claim":"text","condition":"text","source_seat":"id"}],
 "recommendation":"text or null", "cited_materials":[{"material_ref":"packet:<packet_id>"}],
 "unverified_items":[{"seat_id":"id","packet_id":"id"}],
 "missing_records":[{"seat_id":"id","packet_id":"id","note":"text"}]}
Use empty arrays when there are no entries and JSON null if there is no recommendation. Use only seat IDs
and packet IDs from the record. Cite only the agenda, gate decision or frozen answers and critiques. Use
unverified_items only for unverified answers and missing_records only for omissions in unstructured frozen
answers. If the record has an earlier synthesis, update it using the new round and the human's note.`;

export function gateArgs(meeting_id: string, output: unknown): Operations['chair_gate'] {
  requireArgument(record(output) && !Object.hasOwn(output, 'meeting_id') && !Object.hasOwn(output, 'r2_deadline'));
  const args = validate('chair_gate', { ...output, meeting_id });
  if (args.result === 'fail') {
    requireArgument(args.unresolved_points?.every(point => !blank(point)) &&
      args.next_round_scope?.every(point => !blank(point)));
  }
  return args;
}

function references(value: unknown, keys: readonly string[]) {
  return Array.isArray(value) && value.every(entry => record(entry) && Object.keys(entry).length === keys.length &&
    keys.every(key => {
      const field = entry[key];
      return typeof field === 'string' && !/[\uD800-\uDFFF]/u.test(field);
    }));
}

export function synthesisArgs(meeting_id: string, output: unknown): Operations['synthesize'] {
  requireArgument(record(output) && !Object.hasOwn(output, 'reception_summary') &&
    references(output.unverified_items, ['seat_id', 'packet_id']) &&
    references(output.missing_records, ['seat_id', 'packet_id', 'note']));
  return validate('synthesize', { meeting_id, body: output });
}
