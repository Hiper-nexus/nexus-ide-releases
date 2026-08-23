/**
 * Cola da Via Rápida no Iniciar: um clique sela as N stories, abre a
 * first-wave no mesmo turno do Maestro e deixa o caminho Pronto alcançável
 * quando o disco tem arquivos e os writers já pararam.
 */
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import type { SeatAuthReadiness } from '../adapters/seat-auth-readiness';
import {
  compileListedStoriesToPlanRows,
  extractListedMissionItems,
  fastLaneObjectiveText,
  sealFastLaneListedStoryPlan,
} from './mission-story-plan';
import {
  FIRST_WAVE_WRITER_SEATS,
  planFirstWaveSeats,
  type FirstWaveSeat,
} from './via-rapida-first-wave';

export type ViaRapidaIniciarWalkPlan = {
  readonly stories: readonly string[];
  readonly sealedRows: readonly { readonly plannerId: string; readonly title: string }[];
  readonly firstWaveSeats: readonly FirstWaveSeat[];
  readonly skippedAdapters: readonly string[];
};

export function planViaRapidaIniciarWalk(input: {
  readonly objective: string;
  readonly agents: readonly SquadAgent[];
  readonly classifySeat?: (agent: SquadAgent) => SeatAuthReadiness;
}): ViaRapidaIniciarWalkPlan {
  const stories = extractListedMissionItems(input.objective);
  const sealedRows = compileListedStoriesToPlanRows(input.objective, input.agents);
  const wave = planFirstWaveSeats({
    storyCount: stories.length,
    storyTitles: stories,
    agents: input.agents,
    classifySeat: input.classifySeat,
  });
  return {
    stories,
    sealedRows,
    firstWaveSeats: wave.seats,
    skippedAdapters: wave.skippedNoCredential,
  };
}

export function sealViaRapidaStoriesOnIniciar(
  stores: Parameters<typeof sealFastLaneListedStoryPlan>[0],
  mission: Mission,
  squad: Squad,
): readonly { readonly id: string; readonly title: string }[] {
  try {
    return sealFastLaneListedStoryPlan(stores, mission, squad);
  } catch (error) {
    console.warn(
      '[via-rapida] selo das stories falhou:',
      error instanceof Error ? error.message : error,
    );
    return Object.freeze([]);
  }
}

export function firstWaveWorkerPrompt(input: {
  readonly mission: Pick<Mission, 'title' | 'description'>;
  readonly agentName: string;
  readonly storyTitle?: string | null;
  readonly storyIndex?: number;
  readonly storyTotal?: number;
}): string {
  const objective = input.mission.description ?? '';
  const index =
    input.storyIndex !== undefined && input.storyTotal
      ? ` (${input.storyIndex + 1}/${input.storyTotal})`
      : '';
  const browserNote =
    /\b(abr[aeiou]|navegador|browser|preview|mostr(?:ar|e)|ver\s+no\s+navegador)\b/iu.test(
      objective,
    )
      ? 'Se o objetivo pede para ABRIR no navegador: após gerar os arquivos, abra o HTML no navegador do SO (macOS: `open <arquivo>`; Linux: `xdg-open <arquivo>`) ANTES do handoff e cite o arquivo/comando no summary.'
      : '';
  return [
    `## Missão: ${input.mission.title}`,
    `Objetivo: ${objective}`,
    browserNote,
    `Você é ${input.agentName} (writer). Execute agora — não espere o Maestro.`,
    input.storyTitle
      ? `Tarefa selada${index}: ${input.storyTitle}`
      : 'Pegue a próxima story pendente do plano selado e implemente.',
    'Ao terminar, chame nexus_handoff_submit com evidência (arquivos, comandos).',
  ]
    .filter(Boolean)
    .join('\n');
}

export { FIRST_WAVE_WRITER_SEATS, fastLaneObjectiveText };
