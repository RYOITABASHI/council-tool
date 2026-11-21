import { expect, test } from 'vitest';
import { bodySha, canonicalize, packetSha } from '../src/packet/index.js';

// PROTOCOL.md §3.4. The extra header fields must not affect the hash.
const header = {
  meeting_id: '123e4567-e89b-12d3-a456-426614174000',
  round: 'R0',
  seat_id: 'seat_a',
  kind: 'answer',
  created_at: '2026-11-20T07:33:46.285Z',
  supersedes: null,
  packet_id: '123e4567-e89b-12d3-a456-426614174001',
  packet_sha: '0'.repeat(64),
  seq: 42,
} as const;

test.each([
  ['English', 'Hello', '356ce68553ab4089173f9d849521e857c99f44721c0fb4a9e7a3a119f4a0cbab'],
  ['Japanese', '判断が変わる条件：新しい証拠が出ること。', '3d18515e6894ce00d4f31e09940b899da6f105a7039c99bf93160326aa79e636'],
])('matches the %s packet_sha vector', (_language, body, expected) => {
  expect(packetSha({ header, body: { body, claims: [] } })).toBe(expected);
});

test('matches the body_sha vector', () => {
  expect(bodySha('Hello')).toBe('185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969');
});

test('sorts numeric-looking keys lexically and Unicode keys by UTF-16', () => {
  expect(canonicalize([{ '\uE000': null, '😀': true, 2: -0, 10: 1e30 }, 'e\u0301']))
    .toBe('[{"10":1e+30,"2":0,"😀":true,"\uE000":null},"e\u0301"]');
});

test('rejects lone surrogates and non-finite numbers', () => {
  expect(() => canonicalize('\uD800')).toThrow();
  expect(() => canonicalize({ value: Infinity })).toThrow();
});

test('preserves raw line endings in body_sha', () => {
  expect(bodySha('a\r\nb')).not.toBe(bodySha('a\nb'));
});
