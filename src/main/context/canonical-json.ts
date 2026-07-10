/** Deterministic JSON used as the input to security-relevant hashes. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  function visit(input: unknown, inArray: boolean): string | undefined {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') {
      return JSON.stringify(input);
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('canonical JSON rejects non-finite numbers');
      return JSON.stringify(Object.is(input, -0) ? 0 : input);
    }
    if (typeof input === 'undefined') return inArray ? 'null' : undefined;
    if (typeof input !== 'object') {
      throw new Error(`canonical JSON rejects ${typeof input}`);
    }
    if (seen.has(input)) throw new Error('canonical JSON rejects cyclic values');
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return `[${input.map((item) => visit(item, true) ?? 'null').join(',')}]`;
      }
      const record = input as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const encoded = visit(record[key], false);
        if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${members.join(',')}}`;
    } finally {
      seen.delete(input);
    }
  }

  const encoded = visit(value, false);
  if (encoded === undefined) throw new Error('canonical JSON root cannot be undefined');
  return encoded;
}
