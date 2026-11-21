import { statSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sameEntry } from '../src/store/files.js';

const fixture = new URL(import.meta.url);

it('accepts an unchanged file when only ctime advances', () => {
  const before = statSync(fixture, { bigint: true });
  const after = statSync(fixture, { bigint: true });
  after.ctimeNs = before.ctimeNs + 100_000_000n;

  expect(sameEntry(before, after)).toBe(true);
});

it.each(['mtimeNs', 'size'] as const)('rejects a tracked file when %s changes', field => {
  const before = statSync(fixture, { bigint: true });
  const after = statSync(fixture, { bigint: true });
  after.ctimeNs = before.ctimeNs;
  after[field] += 1n;

  expect(sameEntry(before, after)).toBe(false);
});
