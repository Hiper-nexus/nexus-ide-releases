import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatTraceLine,
  getTraceFilePath,
  redactSecrets,
  setTraceDirectory,
  shouldRotate,
  trace,
} from './main-trace';

describe('formatTraceLine', () => {
  it('serializa NDJSON com timestamp e kind', () => {
    const line = formatTraceLine({ kind: 'worker-died', paneId: 'p1' }, 1234);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ kind: 'worker-died', paneId: 'p1', at: 1234 });
    expect(line.endsWith('\n')).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('redige valores de chaves sensíveis em qualquer profundidade', () => {
    const input = {
      apiKey: 'sk-secret',
      nested: { authorization: 'Bearer xyz', ok: 'visível' },
      token: 't',
      message: 'sem segredo',
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).ok).toBe('visível');
    expect(out.message).toBe('sem segredo');
  });

  it('não explode com valores não-objeto', () => {
    expect(redactSecrets('string')).toBe('string');
    expect(redactSecrets(undefined)).toBeUndefined();
  });
});

describe('shouldRotate', () => {
  it('gira acima do teto e mantém abaixo', () => {
    expect(shouldRotate(6 * 1024 * 1024)).toBe(true);
    expect(shouldRotate(1024)).toBe(false);
  });
});

describe('getTraceFilePath', () => {
  afterEach(() => setTraceDirectory(null));

  it('aponta para o arquivo que o trace realmente grava', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-trace-path-'));
    try {
      setTraceDirectory(dir);
      trace({ kind: 'path-probe' });
      const file = getTraceFilePath();
      expect(file).toBe(path.join(dir, 'logs', 'main.trace.ndjson'));
      expect(fs.readFileSync(file as string, 'utf8')).toContain('path-probe');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('devolve null quando não há diretório de userData resolvível', () => {
    setTraceDirectory(null);
    // Fora do Electron (vitest) o `electron` não expõe `app.getPath`.
    expect(getTraceFilePath()).toBeNull();
  });
});
