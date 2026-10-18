import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  hasSensitiveChange,
  sensitiveChanges,
  validateBinPath,
} from './provider-bin-trust';

describe('validateBinPath', () => {
  it('accepts an absolute path to an executable file', () => {
    // /bin/sh is present and executable on macOS and Linux.
    expect(validateBinPath('/bin/sh')).toEqual({ ok: true });
  });

  it('rejects a relative / bare path (no PATH resolution)', () => {
    expect(validateBinPath('sh').ok).toBe(false);
    expect(validateBinPath('./payload').ok).toBe(false);
  });

  it('rejects a path that does not exist', () => {
    expect(validateBinPath('/definitely/not/here/nexus-xyz').ok).toBe(false);
  });

  it('rejects a directory', () => {
    const result = validateBinPath(os.tmpdir());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/arquivo/);
  });

  it('rejects an existing but non-executable file', () => {
    // /etc/hosts exists and is not executable on macOS and Linux.
    const result = validateBinPath('/etc/hosts');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/executável/);
  });
});

describe('sensitiveChanges', () => {
  const current = {
    binPath: '/usr/local/bin/claude',
    extraArgs: ['--foo'],
    permissionMode: '',
  };

  it('flags a new, different binPath', () => {
    const c = sensitiveChanges({ binPath: '/tmp/evil' }, current);
    expect(c.binPath).toBe('/tmp/evil');
    expect(hasSensitiveChange(c)).toBe(true);
  });

  it('does not flag re-saving the same binPath', () => {
    const c = sensitiveChanges({ binPath: '/usr/local/bin/claude' }, current);
    expect(c.binPath).toBeUndefined();
    expect(hasSensitiveChange(c)).toBe(false);
  });

  it('does not flag clearing binPath (empty string)', () => {
    expect(sensitiveChanges({ binPath: '' }, current).binPath).toBeUndefined();
    expect(sensitiveChanges({ binPath: '   ' }, current).binPath).toBeUndefined();
  });

  it('flags changed non-empty extraArgs but not an unchanged or cleared set', () => {
    expect(sensitiveChanges({ extraArgs: ['--danger'] }, current).extraArgs).toEqual(['--danger']);
    expect(sensitiveChanges({ extraArgs: ['--foo'] }, current).extraArgs).toBeUndefined();
    expect(sensitiveChanges({ extraArgs: [] }, current).extraArgs).toBeUndefined();
  });

  it('flags both at once', () => {
    const c = sensitiveChanges({ binPath: '/tmp/x', extraArgs: ['--y'] }, current);
    expect(hasSensitiveChange(c)).toBe(true);
    expect(c.binPath).toBe('/tmp/x');
    expect(c.extraArgs).toEqual(['--y']);
  });

  it('requires confirmation when enabling full-auto but not when returning safe', () => {
    expect(sensitiveChanges({ permissionMode: 'yolo' }, current)).toMatchObject({
      permissionMode: 'yolo',
    });
    expect(
      hasSensitiveChange(
        sensitiveChanges(
          { permissionMode: '' },
          { ...current, permissionMode: 'yolo' },
        ),
      ),
    ).toBe(false);
  });
});

describe('F-1565: baseUrl é mudança sensível', () => {
  const current = { binPath: '', extraArgs: [], permissionMode: 'auto', baseUrl: '' };
  it('base URL nova (o endpoint que recebe a chave) exige confirmação nativa', () => {
    const c = sensitiveChanges(
      { baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
      current,
    );
    expect(c.baseUrl).toBeDefined();
    expect(hasSensitiveChange(c)).toBe(true);
  });
  it('limpar ou regravar a mesma URL não pede confirmação', () => {
    expect(hasSensitiveChange(sensitiveChanges({ baseUrl: '' }, { ...current, baseUrl: 'https://x' }))).toBe(false);
    expect(hasSensitiveChange(sensitiveChanges({ baseUrl: 'https://x' }, { ...current, baseUrl: 'https://x' }))).toBe(false);
  });
});
