import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';

/**
 * Espelha no LAYOUT a adoção que o main já consumou (F-561).
 *
 * O main adota o painel dentro do arranque da Via Rápida — depois que
 * `mission.start` já respondeu (o bootstrap roda com `waitForFirstPane: false`
 * para a tela não travar em "Iniciando…"). O renderer só aprende vínculo de
 * missão em spawn/apresentação/recuperação, e adoção não é nenhum dos três:
 * sem isto o painel continuaria na aba do espaço em que nasceu, sem a estrela
 * de coordenador, enquanto o motor já o trata como Maestro.
 *
 * A ordem é deliberada: o main é a AUTORIDADE, o layout é o espelho. Só
 * marcamos quando `listMissionPanes` prova que aquele pane é o orquestrador
 * daquela missão — se a adoção foi recusada e o motor subiu o Maestro dele, o
 * pane do operador continua sendo o terminal dele, sem estrela mentirosa.
 */
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_DEADLINE_MS = 45_000;

export interface ReflectAdoptedOrchestratorDeps {
  readonly listMissionPanes: (
    missionId: string,
  ) => Promise<ReadonlyArray<{ paneId: string; role?: string }>>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const defaultDeps: ReflectAdoptedOrchestratorDeps = {
  listMissionPanes: (missionId) =>
    window.nexus.orch.listMissionPanes(missionId) as Promise<
      ReadonlyArray<{ paneId: string; role?: string }>
    >,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Devolve `true` quando o main confirmou a adoção e o layout foi atualizado.
 * `false` = a adoção não aconteceu dentro do prazo (o motor subiu o próprio
 * Maestro, ou o arranque falhou); nesse caso nada é marcado.
 */
export async function reflectAdoptedOrchestrator(
  missionId: string,
  paneId: string,
  options: {
    readonly deadlineMs?: number;
    readonly deps?: Partial<ReflectAdoptedOrchestratorDeps>;
  } = {},
): Promise<boolean> {
  const deps = { ...defaultDeps, ...options.deps };
  const deadline = deps.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  for (;;) {
    let confirmed = false;
    try {
      const panes = await deps.listMissionPanes(missionId);
      confirmed = panes.some(
        (pane) => pane.paneId === paneId && pane.role === 'orchestrator',
      );
    } catch {
      // Falha de leitura é transitória — o prazo abaixo é quem desiste.
      confirmed = false;
    }
    if (confirmed) {
      useLayoutStore.getState().promoteMissionPaneRole(missionId, paneId);
      useOrchStore.getState().bindPaneMission(paneId, missionId);
      return true;
    }
    if (deps.now() >= deadline) return false;
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/** Versão com aviso, usada pelo fluxo de criação de missão. */
export function reflectAdoptedOrchestratorWithToast(
  missionId: string,
  paneId: string,
  missionTitle?: string,
): void {
  void reflectAdoptedOrchestrator(missionId, paneId).then((adopted) => {
    if (!adopted) {
      // Silêncio aqui seria o pior desfecho: o operador pediu que AQUELE painel
      // liderasse e vai ver um coordenador novo na tela.
      useToastStore.getState().push(
        'info',
        'A missão abriu com coordenador próprio',
        'O painel que você marcou não assumiu a liderança. Ele continua seu ' +
          'terminal, e a missão está rodando normalmente.',
      );
      return;
    }
    useToastStore.getState().push(
      'success',
      'Seu painel assumiu a missão',
      missionTitle
        ? `Este painel agora coordena “${missionTitle}”.`
        : 'Este painel agora é o coordenador da missão.',
    );
  });
}
