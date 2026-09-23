import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const copies: string[] = [];
const removals: string[] = [];
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => {
        const s = String(p);
        if (s.includes('skills') && !s.includes('..')) return false;
        return actual.existsSync(s);
      },
      mkdirSync: () => {},
      cpSync: (_src: string, dest: string) => {
        copies.push(dest);
      },
      rmSync: (p: string) => {
        removals.push(String(p));
      },
      readdirSync: () => [],
    },
  };
});

import { skillOpsTool } from './tools-skill-ops';

function ctx() {
  return {
    role: 'user',
    sessionId: 's1',
    missionId: null,
    allowedTools: null,
    scope: { rootRealPath: '/tmp', projectId: 'p', checkoutId: 'c', version: '1' },
  } as never;
}

describe('nexus_skills safety', () => {
  it('refuses path traversal in skill name', async () => {
    await expect(
      skillOpsTool.handler({ op: 'install', name: '../.ssh' }, ctx(), undefined),
    ).rejects.toThrow(/slug|inválido/i);
    await expect(
      skillOpsTool.handler({ op: 'remove', name: 'foo/../../etc' }, ctx(), undefined),
    ).rejects.toThrow(/slug|inválido/i);
    expect(copies).toHaveLength(0);
    expect(removals).toHaveLength(0);
  });

  it('refuses to remove a skill that is not bundled with the app', async () => {
    const out = (await skillOpsTool.handler(
      { op: 'remove', name: 'users-personal-skill' },
      ctx(),
      undefined,
    )) as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('embarcadas');
    expect(removals).toHaveLength(0);
  });

  it('does not leak absolute home paths in list', async () => {
    const out = (await skillOpsTool.handler({ op: 'list' }, ctx(), undefined)) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(out)).not.toContain(path.join(process.env.HOME ?? '/Users', '.claude'));
    expect(out.rows[0]).not.toHaveProperty('dir');
    expect(out.rows[0]).toHaveProperty('cli');
  });
});
