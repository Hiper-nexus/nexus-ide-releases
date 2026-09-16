/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reflectAdoptedOrchestrator } from './adopted-orchestrator-reflect';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';

function deps(
  listMissionPanes: (
    missionId: string,
  ) => Promise<ReadonlyArray<{ paneId: string; role?: string }>>,
) {
  let clock = 0;
  return {
    listMissionPanes,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

let promote: ReturnType<typeof vi.spyOn>;
let bind: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  promote = vi
    .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
    .mockImplementation(() => {});
  bind = vi
    .spyOn(useOrchStore.getState(), 'bindPaneMission')
    .mockImplementation(() => {});
});

describe('reflectAdoptedOrchestrator — o main é autoridade, o layout é espelho', () => {
  it('marca o painel quando o main já o registra como orquestrador', async () => {
    const adopted = await reflectAdoptedOrchestrator('m1', 'pane-1', {
      deps: deps(async () => [{ paneId: 'pane-1', role: 'orchestrator' }]),
    });

    expect(adopted).toBe(true);
    expect(promote).toHaveBeenCalledWith('m1', 'pane-1');
    expect(bind).toHaveBeenCalledWith('pane-1', 'm1');
  });

  it('espera: a adoção acontece DEPOIS do start responder', async () => {
    let call = 0;
    const adopted = await reflectAdoptedOrchestrator('m1', 'pane-1', {
      deps: deps(async () => {
        call += 1;
        return call < 3 ? [] : [{ paneId: 'pane-1', role: 'orchestrator' }];
      }),
    });

    expect(adopted).toBe(true);
    expect(call).toBe(3);
    expect(promote).toHaveBeenCalledWith('m1', 'pane-1');
  });

  it('adoção recusada (o motor subiu o Maestro dele) NÃO marca estrela mentirosa', async () => {
    const adopted = await reflectAdoptedOrchestrator('m1', 'pane-1', {
      deadlineMs: 3_000,
      deps: deps(async () => [
        { paneId: 'pane-do-motor', role: 'orchestrator' },
      ]),
    });

    expect(adopted).toBe(false);
    expect(promote).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('o painel registrado como WORKER não vira coordenador', async () => {
    const adopted = await reflectAdoptedOrchestrator('m1', 'pane-1', {
      deadlineMs: 2_000,
      deps: deps(async () => [{ paneId: 'pane-1', role: 'worker' }]),
    });

    expect(adopted).toBe(false);
    expect(promote).not.toHaveBeenCalled();
  });

  it('erro de leitura é transitório — continua tentando até o prazo', async () => {
    let call = 0;
    const adopted = await reflectAdoptedOrchestrator('m1', 'pane-1', {
      deps: deps(async () => {
        call += 1;
        if (call < 3) throw new Error('IPC indisponível');
        return [{ paneId: 'pane-1', role: 'orchestrator' }];
      }),
    });

    expect(adopted).toBe(true);
    expect(call).toBe(3);
  });

  it('o prazo termina a espera em vez de deixar um laço vivo para sempre', async () => {
    let call = 0;
    const adopted = await reflectAdoptedOrchestrator('m1', 'pane-1', {
      deadlineMs: 5_000,
      deps: deps(async () => {
        call += 1;
        return [];
      }),
    });

    expect(adopted).toBe(false);
    // 1s por tentativa: consulta em 0,1,2,3,4,5 e desiste ao bater o prazo.
    expect(call).toBe(6);
  });
});
