import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAppInfo,
  buildContext,
  buildDiagnostics,
  parseTraceTail,
  readFileTail,
  type DiagnosticsDeps,
} from './bug-report-diagnostics';
import { bugReportPayloadSchema } from '../../shared/bug-report';

const line = (event: Record<string, unknown>): string => JSON.stringify(event);

function deps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    appVersion: '0.76.161',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '27.2.0',
    listAgentSessions: () => [],
    readTraceTail: async () => null,
    ...overrides,
  };
}

describe('buildAppInfo', () => {
  it('maps the runtime to the contract shape', () => {
    expect(buildAppInfo(deps())).toEqual({
      version: '0.76.161',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '27.2.0',
    });
  });

  it('falls back to linux for platforms outside the contract and drops an empty OS version', () => {
    expect(buildAppInfo(deps({ platform: 'freebsd', osVersion: '  ' }))).toEqual({
      version: '0.76.161',
      platform: 'linux',
      arch: 'arm64',
    });
  });

  it('caps the OS version length', () => {
    const info = buildAppInfo(deps({ osVersion: '1'.repeat(200) }));
    expect(info.osVersion?.length).toBeLessThanOrEqual(64);
  });
});

describe('buildContext', () => {
  const sessions = [
    { paneId: 'p1', adapterId: 'claude', model: 'opus-5', missionId: undefined },
    { paneId: 'p2', adapterId: 'codex', model: 'gpt-6', missionId: 'm1' },
    { paneId: 'p3', adapterId: 'grok' },
  ];

  it('describes the focused agent pane and the fleet size', () => {
    expect(buildContext(deps({ listAgentSessions: () => sessions }), 'p2')).toEqual({
      adapter: 'codex',
      model: 'gpt-6',
      paneCount: 3,
      missionActive: true,
    });
  });

  it('falls back to the most recent agent when no pane was focused', () => {
    const context = buildContext(deps({ listAgentSessions: () => sessions }));
    expect(context.adapter).toBe('grok');
    expect(context.model).toBeUndefined();
  });

  it('does not guess an agent when the focused pane is not an agent pane', () => {
    const context = buildContext(deps({ listAgentSessions: () => sessions }), 'shell-1');
    expect(context.adapter).toBeUndefined();
    expect(context.paneCount).toBe(3);
  });

  it('reports an empty fleet', () => {
    expect(buildContext(deps())).toEqual({ paneCount: 0, missionActive: false });
  });

  it('reports an empty fleet instead of throwing when the inventory is unavailable', () => {
    const broken = deps({
      listAgentSessions: () => {
        throw new Error('pty manager indisponível');
      },
    });
    expect(buildContext(broken, 'p1')).toEqual({ paneCount: 0, missionActive: false });
  });

  it('counts a pane once, caps the count, and ignores malformed ids', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      paneId: `p${index}`,
      adapterId: 'claude',
    }));
    const twice = [...many, { paneId: 'p0', adapterId: 'claude' }];
    expect(buildContext(deps({ listAgentSessions: () => twice })).paneCount).toBe(64);
    const odd = buildContext(
      deps({ listAgentSessions: () => [{ paneId: 'a', adapterId: '/Users/x/evil path', model: 'm m' }] }),
      'a',
    );
    expect(odd.adapter).toBeUndefined();
    expect(odd.model).toBeUndefined();
  });

  it('keeps real model ids (dates, brackets, vendor slashes) and drops org-scoped or id-shaped ones', () => {
    const adapterWith = (model: string) =>
      buildContext(deps({ listAgentSessions: () => [{ paneId: 'a', adapterId: 'claude', model }] }), 'a');
    expect(adapterWith('claude-sonnet-4-5-20250929').model).toBe('claude-sonnet-4-5-20250929');
    expect(adapterWith('claude-opus-4-1[1m]').model).toBe('claude-opus-4-1[1m]');
    expect(adapterWith('moonshotai/kimi-k2').model).toBe('moonshotai/kimi-k2');
    expect(adapterWith('ft:gpt-4o:acme-corp:custom:abc123').model).toBeUndefined();
    expect(adapterWith('3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f').model).toBeUndefined();
  });

  it('never carries pane ids, cwd, accounts or mission ids', () => {
    const context = buildContext(
      deps({
        listAgentSessions: () => [
          {
            paneId: 'pane-secret-1',
            adapterId: 'claude',
            model: 'opus',
            missionId: 'mission-secret',
            cwd: '/Users/ana/projeto',
            accountId: 'acct-secret',
          } as never,
        ],
      }),
      'pane-secret-1',
    );
    const serialized = JSON.stringify(context);
    for (const forbidden of ['pane-secret-1', 'mission-secret', '/Users/ana', 'acct-secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('parseTraceTail', () => {
  it('keeps only the type and a short code of each event', () => {
    const raw = [
      line({ kind: 'main-boot', at: 900 }),
      line({
        kind: 'agent-pty-exit',
        at: 1000,
        code: 1,
        signal: 'SIGTERM',
        prompt: 'SENTINELA-PROMPT escreva o código secreto',
        cwd: '/Users/ana/projeto-secreto',
        argv: ['--token', 'SENTINELA-ARGV'],
        env: { HOME: '/Users/ana' },
        paneId: 'SENTINELA-PANE',
        message: 'SENTINELA-MENSAGEM',
      }),
    ].join('\n');
    const { events } = parseTraceTail(raw);
    expect(events).toEqual([
      { t: 900, kind: 'main-boot' },
      { t: 1000, kind: 'agent-pty-exit', code: '1' },
    ]);
    expect(JSON.stringify(events)).not.toContain('SENTINELA');
    expect(JSON.stringify(events)).not.toContain('/Users');
  });

  it('uses `outcome` as the code when there is no `code`', () => {
    const { events } = parseTraceTail(line({ kind: 'account-failover', at: 5, outcome: 'switched' }));
    expect(events).toEqual([{ t: 5, kind: 'account-failover', code: 'switched' }]);
  });

  it('drops codes that are not short tokens (paths, sentences, e-mails)', () => {
    const raw = [
      line({ kind: 'a', at: 1, code: '/Users/ana/log' }),
      line({ kind: 'b', at: 2, code: 'texto com espaços' }),
      line({ kind: 'c', at: 3, code: 'ana@exemplo.com' }),
      line({ kind: 'd', at: 4, code: 'x'.repeat(81) }),
      line({ kind: 'e', at: 5, code: 0 }),
      line({ kind: 'f', at: 6, code: -1 }),
    ].join('\n');
    expect(parseTraceTail(raw).events).toEqual([
      { t: 1, kind: 'a' },
      { t: 2, kind: 'b' },
      { t: 3, kind: 'c' },
      { t: 4, kind: 'd' },
      { t: 5, kind: 'e', code: '0' },
      { t: 6, kind: 'f', code: '-1' },
    ]);
  });

  it('skips malformed lines, non-objects, bad kinds and bad timestamps', () => {
    const raw = [
      'não é json',
      '123',
      'null',
      '[1,2]',
      line({ at: 1 }),
      line({ kind: 'tem espaço', at: 2 }),
      line({ kind: '/Users/ana/x', at: 3 }),
      line({ kind: 'k'.repeat(41), at: 4 }),
      line({ kind: 'sem-tempo' }),
      line({ kind: 'tempo-ruim', at: 'ontem' }),
      line({ kind: 'tempo-negativo', at: -5 }),
      line({ kind: 'valido', at: 7 }),
    ].join('\n');
    expect(parseTraceTail(raw).events).toEqual([{ t: 7, kind: 'valido' }]);
  });

  it('drops id-shaped, dotted, uppercase or path-like kinds (a future dynamic id cannot leak)', () => {
    const raw = [
      line({ kind: '3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f', at: 1 }),
      line({ kind: 'user.john.doe', at: 2 }),
      line({ kind: 'Main-Boot', at: 3 }),
      line({ kind: 'session-0123456789abcdef', at: 4 }),
      line({ kind: 'pane-spawn-timing', at: 5 }),
      line({ kind: 'account-failover', at: 6, outcome: 'switched' }),
    ].join('\n');
    expect(parseTraceTail(raw).events).toEqual([
      { t: 5, kind: 'pane-spawn-timing' },
      { t: 6, kind: 'account-failover', code: 'switched' },
    ]);
  });

  it('drops codes that look like ids or timestamps but keeps real codes', () => {
    const raw = [
      line({ kind: 'a-one', at: 1, code: '1790901515020' }),
      line({ kind: 'a-two', at: 2, code: '3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f' }),
      line({ kind: 'a-three', at: 3, code: 'deadbeefcafe0123' }),
      line({ kind: 'a-four', at: 4, code: 'ENOENT' }),
      line({ kind: 'a-five', at: 5, code: 137 }),
      line({ kind: 'a-six', at: 6, code: 'E_ACCES' }),
    ].join('\n');
    expect(parseTraceTail(raw).events).toEqual([
      { t: 1, kind: 'a-one' },
      { t: 2, kind: 'a-two' },
      { t: 3, kind: 'a-three' },
      { t: 4, kind: 'a-four', code: 'ENOENT' },
      { t: 5, kind: 'a-five', code: '137' },
      { t: 6, kind: 'a-six', code: 'E_ACCES' },
    ]);
  });

  it('drops events whose time is beyond what a Date can hold', () => {
    const raw = [
      line({ kind: 'far-future', at: Number.MAX_SAFE_INTEGER }),
      line({ kind: 'ok-event', at: 8.64e15 }),
    ].join('\n');
    expect(parseTraceTail(raw).events).toEqual([{ t: 8.64e15, kind: 'ok-event' }]);
  });

  it('returns the last 50 events in chronological order', () => {
    const raw = Array.from({ length: 120 }, (_, index) => line({ kind: 'tick', at: index })).join('\n');
    const { events } = parseTraceTail(raw);
    expect(events).toHaveLength(50);
    expect(events[0]?.t).toBe(70);
    expect(events[49]?.t).toBe(119);
  });

  it('derives short error codes from failure-like events only', () => {
    const raw = [
      line({ kind: 'agent-pty-exit', at: 1, code: 0 }),
      line({ kind: 'agent-pty-exit', at: 2, code: 137 }),
      line({ kind: 'pty-resize-dropped', at: 3 }),
      line({ kind: 'account-failover', at: 4, outcome: 'switch-respawn-failed' }),
      line({ kind: 'main-boot', at: 5 }),
      line({ kind: 'pty-resize-dropped', at: 6 }),
    ].join('\n');
    expect(parseTraceTail(raw).errors).toEqual([
      'agent-pty-exit:137',
      'pty-resize-dropped',
      'account-failover:switch-respawn-failed',
    ]);
  });

  it('caps the error list at 20 distinct entries, keeping the most recent', () => {
    const raw = Array.from({ length: 60 }, (_, index) =>
      line({ kind: `render-error-${index}`, at: index }),
    ).join('\n');
    const { errors } = parseTraceTail(raw);
    expect(errors).toHaveLength(20);
    expect(errors.at(-1)).toBe('render-error-59');
  });
});

describe('buildDiagnostics', () => {
  it('produces a payload fragment that satisfies the wire contract', async () => {
    const diagnostics = await buildDiagnostics(
      deps({ readTraceTail: async () => line({ kind: 'main-boot', at: 1700000000000 }) }),
    );
    const payload = {
      title: 'Titulo valido',
      description: 'Descricao valida do problema.',
      category: 'other',
      impact: 'annoying',
      app: buildAppInfo(deps()),
      consent: { diagnostics: true },
      diagnostics,
    };
    expect(bugReportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(diagnostics.events).toHaveLength(1);
  });

  it('returns empty diagnostics when there is no trace', async () => {
    expect(await buildDiagnostics(deps())).toEqual({ events: [], errors: [] });
  });

  it('never throws when reading the trace fails', async () => {
    const diagnostics = await buildDiagnostics(
      deps({
        readTraceTail: async () => {
          throw new Error('EACCES: permission denied, open /Users/ana/trace');
        },
      }),
    );
    expect(diagnostics).toEqual({ events: [], errors: [] });
  });
});

describe('readFileTail', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tmpFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-diag-tail-'));
    dirs.push(dir);
    const file = path.join(dir, 'main.trace.ndjson');
    fs.writeFileSync(file, content);
    return file;
  }

  it('returns the whole small file', async () => {
    const file = tmpFile('a\nb\n');
    expect(await readFileTail(file, 1024)).toBe('a\nb\n');
  });

  it('returns only the tail of a large file and drops the partial first line', async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `linha-${String(index).padStart(3, '0')}`);
    const file = tmpFile(`${lines.join('\n')}\n`);
    const tail = await readFileTail(file, 100);
    expect(tail).not.toBeNull();
    const parts = (tail as string).trim().split('\n');
    expect(parts.at(-1)).toBe('linha-199');
    expect(parts.every((part) => /^linha-\d{3}$/.test(part))).toBe(true);
    expect((tail as string).length).toBeLessThanOrEqual(100);
  });

  it('returns null for a missing file', async () => {
    expect(await readFileTail(path.join(os.tmpdir(), 'nexus-nao-existe-xyz.ndjson'), 100)).toBeNull();
  });
});
