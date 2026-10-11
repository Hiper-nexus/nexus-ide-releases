/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionCheckpointListResult,
  MissionCheckpointPreviewResult,
  MissionCheckpointRestoreResult,
} from '../../../shared/mission-checkpoints';
import { MissionCheckpoints } from './MissionCheckpoints';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const REF_TURN = `refs/nexus-checkpoint/${'a'.repeat(32)}/ordinal/2`;
const REF_OLD = `refs/nexus-checkpoint/${'a'.repeat(32)}/ordinal/1`;
const ROOT = '/projetos/app/.nexus/worktrees/writer-ada';

const LIST: MissionCheckpointListResult = {
  ok: true,
  missionId: 'mission-a',
  scopes: [
    {
      root: ROOT,
      branch: 'nexus/writer-ada',
      checkpoints: [
        {
          ref: REF_TURN,
          ordinal: 2,
          createdAt: Date.UTC(2026, 9, 11, 13, 5),
          kind: 'turn',
          writer: 'Ada',
          changed: { files: ['src/app.ts', 'src/app.test.ts'], total: 2 },
        },
        {
          ref: REF_OLD,
          ordinal: 1,
          createdAt: Date.UTC(2026, 9, 11, 12, 0),
          kind: 'backup',
          writer: null,
          changed: { files: [], total: 0 },
        },
      ],
    },
  ],
};

const PLAN = {
  ref: REF_TURN,
  root: ROOT,
  overwrite: { files: ['src/app.ts'], total: 1 },
  create: { files: ['src/app.test.ts'], total: 1 },
  keptExtra: { files: [], total: 0 },
  conflicts: { files: [], total: 0 },
};

const FP_1 = '1'.repeat(64);
const FP_2 = '2'.repeat(64);

let host: HTMLElement;
let root: Root;
type ListFn = (input: { missionId: string }) => Promise<MissionCheckpointListResult>;
type PreviewFn = (input: { missionId: string; ref: string }) => Promise<MissionCheckpointPreviewResult>;
type RestoreFn = (input: { missionId: string; ref: string }) => Promise<MissionCheckpointRestoreResult>;

function createApi() {
  return {
    listMissionCheckpoints: vi.fn<ListFn>(async () => LIST),
    previewMissionCheckpoint: vi.fn<PreviewFn>(async () => ({ ok: true, fingerprint: FP_1, ...PLAN })),
    restoreMissionCheckpoint: vi.fn<RestoreFn>(async () => ({
      ok: true,
      applied: true,
      backupRef: `refs/nexus-checkpoint/${'a'.repeat(32)}/ordinal/3`,
      ...PLAN,
    })),
  };
}

let api: ReturnType<typeof createApi>;

beforeEach(() => {
  api = createApi();
  (window as unknown as { nexus: unknown }).nexus = { orch: api };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  delete (window as unknown as { nexus?: unknown }).nexus;
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderCheckpoints(): Promise<void> {
  act(() => root.render(<MissionCheckpoints missionId="mission-a" />));
  await flush();
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    label.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''),
  );
  if (!found) throw new Error(`botão ${label} ausente`);
  return found;
}

describe('MissionCheckpoints (F-1173)', () => {
  it('lista por árvore com branch, pasta, writer, data e arquivos', async () => {
    await renderCheckpoints();

    expect(api.listMissionCheckpoints).toHaveBeenCalledWith({ missionId: 'mission-a' });
    const text = host.textContent ?? '';
    expect(text).toContain('nexus/writer-ada');
    expect(text).toContain('writer-ada');
    expect(text).toContain('Fim do turno de Ada');
    expect(text).toContain('Cópia de segurança (antes de uma restauração)');
    expect(text).toContain('2 arquivos');
    expect(host.querySelector('.mission-checkpoints__files li')?.textContent).toBe('src/app.ts');
    expect(host.querySelector('.mission-checkpoints__when')?.textContent).toMatch(/\d{2}\/10/);
  });

  it('restaurar pede confirmação em linha que diz a verdade sobre o que acontece, sem window.confirm', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    await renderCheckpoints();

    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();

    expect(api.previewMissionCheckpoint).toHaveBeenCalledWith({ missionId: 'mission-a', ref: REF_TURN });
    expect(api.restoreMissionCheckpoint).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
    const confirmation = host.querySelector('.mission-checkpoints__confirm');
    expect(confirmation?.getAttribute('role')).toBe('group');
    const text = confirmation?.textContent ?? '';
    expect(text).toContain('1 arquivo será sobrescrito e 1 será criado na worktree writer-ada (branch nexus/writer-ada)');
    expect(text).toContain('guarda o estado atual desta worktree como um checkpoint novo');
    expect(text).toContain('nada é apagado');
    expect(text).toContain('Alterações não salvas no editor não estão no disco');
    expect(text).toContain('a restauração é recusada');
    // Foco no lado seguro (revisão sênior): nunca no botão destrutivo.
    expect(document.activeElement?.textContent).toBe('Cancelar');

    await act(async () => button(/^Cancelar$/).click());
    expect(host.querySelector('.mission-checkpoints__confirm')).toBeNull();
    expect(api.restoreMissionCheckpoint).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it('Enter repetido depois de abrir a confirmação só cancela: o foco está em Cancelar', async () => {
    await renderCheckpoints();
    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();

    const focused = document.activeElement as HTMLButtonElement;
    expect(focused.textContent).toBe('Cancelar');
    expect(focused.classList.contains('mission-checkpoints__button--danger')).toBe(false);
    // Enter num botão focado = clique nele; duas vezes não chega ao destrutivo.
    await act(async () => focused.click());
    await act(async () => (document.activeElement as HTMLElement | null)?.click());
    await flush();
    expect(api.restoreMissionCheckpoint).not.toHaveBeenCalled();
    expect(host.querySelector('.mission-checkpoints__confirm')).toBeNull();
  });

  it('árvore mudou desde a prévia: mostra a recusa e oferece nova prévia, que restaura com a impressão nova', async () => {
    api.restoreMissionCheckpoint.mockResolvedValueOnce({
      ok: false,
      error: 'o checkpoint ou a árvore mudou desde a prévia; reveja a prévia antes de restaurar',
      stale: true,
    });
    await renderCheckpoints();
    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();
    await act(async () => button(/^Restaurar agora$/).click());
    await flush();

    expect(api.restoreMissionCheckpoint).toHaveBeenLastCalledWith({ missionId: 'mission-a', ref: REF_TURN, fingerprint: FP_1 });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('mudou desde a prévia');
    expect(host.querySelector('.mission-checkpoints__outcome')).toBeNull();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Restaurar agora')).toBe(false);

    api.previewMissionCheckpoint.mockResolvedValueOnce({
      ok: true, fingerprint: FP_2, ...PLAN, overwrite: { files: ['src/app.ts', 'src/novo.ts'], total: 2 },
    });
    await act(async () => button(/^Ver a prévia de novo$/).click());
    await flush();
    expect(api.previewMissionCheckpoint).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.mission-checkpoints__plan')?.textContent).toContain('2 arquivos serão sobrescritos');
    await act(async () => button(/^Restaurar agora$/).click());
    await flush();
    expect(api.restoreMissionCheckpoint).toHaveBeenLastCalledWith({ missionId: 'mission-a', ref: REF_TURN, fingerprint: FP_2 });
    expect(host.querySelector('.mission-checkpoints__outcome')?.textContent).toContain('Restaurado');
  });

  it('confirmado: restaura, mostra o sucesso e recarrega a lista', async () => {
    await renderCheckpoints();
    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();

    await act(async () => button(/^Restaurar agora$/).click());
    await flush();

    expect(api.restoreMissionCheckpoint).toHaveBeenCalledWith({ missionId: 'mission-a', ref: REF_TURN, fingerprint: FP_1 });
    expect(host.querySelector('.mission-checkpoints__confirm')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Restaurado: 1 arquivo sobrescrito e 1 criado. O estado anterior foi guardado como checkpoint novo.',
    );
    expect(api.listMissionCheckpoints).toHaveBeenCalledTimes(2);
  });

  it('recusa do Main aparece como erro na própria confirmação, sem fingir sucesso', async () => {
    api.restoreMissionCheckpoint.mockResolvedValueOnce({
      ok: false,
      error: 'checkpoint: writer ocupado na árvore /x (Ada); restaurar agora perderia o que ele está escrevendo.',
    });
    await renderCheckpoints();
    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();
    await act(async () => button(/^Restaurar agora$/).click());
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível restaurar: checkpoint: writer ocupado');
    expect(host.querySelector('.mission-checkpoints__outcome')).toBeNull();
    expect(button(/^Restaurar agora$/).disabled).toBe(true);
    expect(button(/^Fechar$/)).toBeTruthy();
  });

  it('missão em curso: linha recolhível com a contagem, mesma confirmação e recusa de writer ocupado', async () => {
    api.restoreMissionCheckpoint.mockResolvedValueOnce({
      ok: false,
      error: 'checkpoint: writer ocupado na árvore /x (Ada); restaurar agora perderia o que ele está escrevendo.',
    });
    act(() => root.render(<MissionCheckpoints missionId="mission-a" collapsible />));
    await flush();

    const details = host.querySelector<HTMLDetailsElement>('details.mission-checkpoints--collapsible');
    expect(details?.getAttribute('aria-label')).toBe('Pontos de restauração dos writers');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Pontos de restauração (2)');

    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();
    expect(host.querySelector('.mission-checkpoints__confirm')?.textContent).toContain('guarda o estado atual desta worktree');
    await act(async () => button(/^Restaurar agora$/).click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('writer ocupado');
    expect(host.querySelector('.mission-checkpoints__outcome')).toBeNull();
  });

  it('entrega nova relê em silêncio, sem "Carregando…" e sem fechar a confirmação aberta', async () => {
    act(() => root.render(<MissionCheckpoints missionId="mission-a" collapsible refreshKey={1} />));
    await flush();
    await act(async () => button(/^Restaurar: Fim do turno de Ada/).click());
    await flush();
    expect(api.listMissionCheckpoints).toHaveBeenCalledTimes(1);

    let release: (value: MissionCheckpointListResult) => void = () => undefined;
    api.listMissionCheckpoints.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    act(() => root.render(<MissionCheckpoints missionId="mission-a" collapsible refreshKey={2} />));
    expect(api.listMissionCheckpoints).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Carregando checkpoints');
    expect(host.querySelector('.mission-checkpoints__confirm')).not.toBeNull();

    const newer = {
      ref: `refs/nexus-checkpoint/${'a'.repeat(32)}/ordinal/3`, ordinal: 3, createdAt: Date.UTC(2026, 9, 11, 14, 0),
      kind: 'turn' as const, writer: 'Grace', changed: { files: ['src/b.ts'], total: 1 },
    };
    const scope = (LIST as Extract<MissionCheckpointListResult, { ok: true }>).scopes[0]!;
    await act(async () => release({ ok: true, missionId: 'mission-a', scopes: [{ ...scope, checkpoints: [newer, ...scope.checkpoints] }] }));
    await flush();
    expect(host.querySelector('summary')?.textContent).toBe('Pontos de restauração (3)');
    expect(host.textContent).toContain('Fim do turno de Grace');
    expect(host.querySelector('.mission-checkpoints__confirm')).not.toBeNull();
  });

  it('lista vazia explica quando o checkpoint é gravado; erro de leitura oferece tentar de novo', async () => {
    api.listMissionCheckpoints.mockResolvedValueOnce({ ok: true, missionId: 'mission-a', scopes: [] });
    await renderCheckpoints();
    expect(host.textContent).toContain('Nenhum checkpoint gravado');

    act(() => root.unmount());
    root = createRoot(host);
    api.listMissionCheckpoints.mockResolvedValueOnce({ ok: false, error: 'missão não encontrada neste projeto' });
    await renderCheckpoints();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('missão não encontrada neste projeto');
    await act(async () => button(/^Tentar de novo$/).click());
    await flush();
    expect(host.textContent).toContain('Fim do turno de Ada');
  });
});
