import { describe, expect, it } from 'vitest';
import { workerSpawnFailedNotice } from './worker-spawn-failed-controller';

const base = {
  missionId: '',
  deadAdapterId: 'kimi',
  message: 'rode `kimi login`',
  at: 1_789_000_000_000,
} as const;

describe('workerSpawnFailedNotice', () => {
  it('avisa (warn) quando outro CLI sentou o pane — o pane existe', () => {
    // Campo 10/09: o operador pediu kimi, o pane abriu claude e ele só
    // descobriu sozinho. A troca precisa de nome próprio no aviso.
    const notice = workerSpawnFailedNotice({
      ...base,
      title: 'Assento kimi → claude',
      successorCli: 'claude',
      successorName: 'Claude Code',
    });

    expect(notice.kind).toBe('warn');
    expect(notice.title).toBe('Assento kimi → claude');
    expect(notice.detail).toContain('kimi não sentou');
    expect(notice.detail).toContain('O pane abriu com Claude Code');
  });

  it('degrada para o id quando o rótulo do sucessor não vem', () => {
    const notice = workerSpawnFailedNotice({
      ...base,
      successorCli: 'claude',
    });

    expect(notice.kind).toBe('warn');
    expect(notice.title).toBe('Assento remapeado: kimi');
    expect(notice.detail).toContain('claude');
  });

  it('erra (error) quando nenhum CLI assumiu o pane', () => {
    const notice = workerSpawnFailedNotice(base);

    expect(notice.kind).toBe('error');
    expect(notice.title).toBe('kimi não subiu');
    expect(notice.detail).toBe('rode `kimi login`');
  });
});
