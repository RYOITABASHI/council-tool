// RFC 8785 §3.2.2.2
function serializeString(value: string): string {
  if (/\p{Surrogate}/u.test(value)) {
    throw new TypeError('JCS strings must not contain lone UTF-16 surrogates');
  }
  return JSON.stringify(value);
}

/** RFC 8785 §3. Only accepts JSON data. Duplicate keys must be rejected before parsing. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return serializeString(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + Array.from(value, canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const object = value as Record<string, unknown>;
      // Append each key directly so JSON.stringify cannot reorder integer keys.
      const entries = Object.keys(object).sort().map((key) =>
        serializeString(key) + ':' + canonicalize(object[key]),
      );
      return '{' + entries.join(',') + '}';
    }
  }
  throw new TypeError('JCS requires a JSON value with finite numbers');
}
