import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWorkspacePolicyAllowsPathWrite,
  assertWorkspacePolicyAllowsWrite,
} from './governed-workspace-control-boundary';
import { resolveWritePathWithPolicy } from './workspace-path';

const WORKSPACE_ROOT = path.resolve('/ws/project');
const INSIDE_PATH = path.join(WORKSPACE_ROOT, 'src', 'main.ts');
const OUTSIDE_PATH = path.resolve('/other', 'file.ts');

// ── assertWorkspacePolicyAllowsWrite (mutation-oriented, path-agnostic) ──────

describe('assertWorkspacePolicyAllowsWrite', () => {
  it('read_only — denies any write and signals settings update', () => {
    expect(() => assertWorkspacePolicyAllowsWrite('read_only')).toThrow(
      /update.*settings/i,
    );
  });

  it('write_external — permits writes', () => {
    expect(() => assertWorkspacePolicyAllowsWrite('write_external')).not.toThrow();
  });

  it('default — permits writes (path check deferred to path-level assertion)', () => {
    expect(() => assertWorkspacePolicyAllowsWrite('default')).not.toThrow();
  });
});

// ── assertWorkspacePolicyAllowsPathWrite (path-aware, both directions) ───────

describe('assertWorkspacePolicyAllowsPathWrite', () => {
  it('read_only — denies write inside workspace (no writes allowed at all)', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite('read_only', WORKSPACE_ROOT, INSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });

  it('read_only — denies write outside workspace', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite('read_only', WORKSPACE_ROOT, OUTSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });

  it('write_external — permits write outside workspace', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite(
        'write_external',
        WORKSPACE_ROOT,
        OUTSIDE_PATH,
      ),
    ).not.toThrow();
  });

  it('write_external — permits write inside workspace', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite(
        'write_external',
        WORKSPACE_ROOT,
        INSIDE_PATH,
      ),
    ).not.toThrow();
  });

  it('default — permits write inside workspace (current behaviour preserved)', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite('default', WORKSPACE_ROOT, INSIDE_PATH),
    ).not.toThrow();
  });

  it('default — denies write outside workspace and signals settings update', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite('default', WORKSPACE_ROOT, OUTSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });
});

// ── same_checkout (mirrors default: write inside workspace only) ──────────────

describe('assertWorkspacePolicyAllowsWrite — same_checkout', () => {
  it('permits writes (path check deferred to path-level assertion)', () => {
    expect(() => assertWorkspacePolicyAllowsWrite('same_checkout')).not.toThrow();
  });
});

describe('assertWorkspacePolicyAllowsPathWrite — same_checkout', () => {
  it('permits write inside workspace', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite('same_checkout', WORKSPACE_ROOT, INSIDE_PATH),
    ).not.toThrow();
  });

  it('denies write outside workspace and signals settings update', () => {
    expect(() =>
      assertWorkspacePolicyAllowsPathWrite(
        'same_checkout',
        WORKSPACE_ROOT,
        OUTSIDE_PATH,
      ),
    ).toThrow(/update.*settings/i);
  });
});

// ── resolveWritePathWithPolicy (workspace-path) ───────────────────────────────

describe('resolveWritePathWithPolicy', () => {
  it('read_only — throws on any write attempt (path inside workspace)', () => {
    expect(() =>
      resolveWritePathWithPolicy('read_only', WORKSPACE_ROOT, INSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });

  it('read_only — throws on any write attempt (path outside workspace)', () => {
    expect(() =>
      resolveWritePathWithPolicy('read_only', WORKSPACE_ROOT, OUTSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });

  it('write_external — resolves absolute path outside workspace without throwing', () => {
    const result = resolveWritePathWithPolicy(
      'write_external',
      WORKSPACE_ROOT,
      OUTSIDE_PATH,
    );
    expect(result).toBe(OUTSIDE_PATH);
  });

  it('write_external — resolves path inside workspace without throwing', () => {
    const result = resolveWritePathWithPolicy(
      'write_external',
      WORKSPACE_ROOT,
      INSIDE_PATH,
    );
    expect(result).toBe(INSIDE_PATH);
  });

  it('default — denies path outside workspace and signals settings update', () => {
    expect(() =>
      resolveWritePathWithPolicy('default', WORKSPACE_ROOT, OUTSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });

  it('same_checkout — denies path outside workspace and signals settings update', () => {
    expect(() =>
      resolveWritePathWithPolicy('same_checkout', WORKSPACE_ROOT, OUTSIDE_PATH),
    ).toThrow(/update.*settings/i);
  });

  it('same_checkout — does not throw a policy denial for a path inside the workspace', () => {
    // resolvePathInsideRoot calls realpathSync which fails on fake paths in unit tests,
    // but the policy check itself must not throw the "update settings" error.
    expect(() =>
      resolveWritePathWithPolicy('same_checkout', WORKSPACE_ROOT, INSIDE_PATH),
    ).not.toThrow(/update.*settings/i);
  });
});
