import type { RichModelMetadataView } from '../../shared/model-metadata-types';
import type { MissionLane } from '../../shared/mission-intent';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/types';
import { classifyStandardMissionTopology } from '../../shared/mission-topology';

export interface MissionWavePreview {
  title: string;
  detail: string;
}

export interface RosterCostLine {
  agentId: string;
  agentName: string;
  roleLabel: string;
  adapterId: string;
  modelId: string | null;
  rateLabel: string;
  estimateLabel: string;
}

export interface RosterCostPreview {
  lines: RosterCostLine[];
  complete: boolean;
  totalLabel: string;
  caveat: string;
}

export interface MissionReviewP0P3Status {
  kind: 'dedicated' | 'not-controlled';
  label: string;
  detail: string;
}

type MetadataByKey = Readonly<
  Record<string, RichModelMetadataView | null | undefined>
>;

interface CostRange {
  minPerMillion: number;
  maxPerMillion: number;
}

interface ResolvedRosterModel {
  agent: SquadAgent;
  modelId: string | null;
  metadata: RichModelMetadataView | null | undefined;
  costRange: CostRange | null;
}

export function modelMetadataKey(adapterId: string, modelId: string): string {
  return `${adapterId}\u0000${modelId}`;
}

function normalizePrice(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function metadataCostRange(
  metadata: RichModelMetadataView | null | undefined,
): CostRange | null {
  const input = normalizePrice(metadata?.cost?.input);
  const output = normalizePrice(metadata?.cost?.output);
  const known = [input, output].filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return {
    minPerMillion: Math.min(...known),
    maxPerMillion: Math.max(...known),
  };
}

function formatUsd(value: number): string {
  if (value === 0) return '$0';
  const decimals = value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return `$${Number(value.toFixed(decimals)).toString()}`;
}

function formatRate(
  metadata: RichModelMetadataView | null | undefined,
): string {
  const input = normalizePrice(metadata?.cost?.input);
  const output = normalizePrice(metadata?.cost?.output);
  if (input !== null && output !== null) {
    return `${formatUsd(input)} entrada / ${formatUsd(output)} saída por 1M tokens`;
  }
  if (input !== null) {
    return `${formatUsd(input)} entrada por 1M tokens`;
  }
  if (output !== null) {
    return `${formatUsd(output)} saída por 1M tokens`;
  }
  return 'Preço indisponível no catálogo';
}

function resolveRosterModels(
  roster: readonly SquadAgent[],
  adapters: readonly AdapterInfo[],
  metadataByKey: MetadataByKey,
): ResolvedRosterModel[] {
  return roster.map((agent) => {
    const adapter = adapters.find((entry) => entry.id === agent.cli);
    const modelId = agent.model?.trim() || adapter?.models.default || null;
    const metadata = modelId
      ? metadataByKey[modelMetadataKey(agent.cli, modelId)]
      : null;
    return {
      agent,
      modelId,
      metadata,
      costRange: metadataCostRange(metadata),
    };
  });
}

/**
 * Preview conservador, não billing. O contrato chama seus contadores de
 * planningTokens/executionTokens, mas eles são um ledger sintético de efeitos,
 * não telemetria nem teto de cobrança. Por isso:
 * - mostramos o preço real por MTok de cada modelo;
 * - calculamos só o envelope UNITÁRIO do roster;
 * - deixamos o total da missão indisponível até existir previsão real de
 *   entrada/saída por agente;
 * - qualquer preço ausente invalida até o envelope, em vez de completar com
 *   zero ou um chute.
 */
export function buildRosterCostPreview(input: {
  roster: readonly SquadAgent[];
  adapters: readonly AdapterInfo[];
  metadataByKey: MetadataByKey;
}): RosterCostPreview {
  const resolved = resolveRosterModels(
    input.roster,
    input.adapters,
    input.metadataByKey,
  );
  const lines = resolved.map(({ agent, modelId, metadata, costRange }) => ({
    agentId: agent.id,
    agentName: agent.agentName,
    roleLabel:
      agent.category === 'orchestrator' ? 'orquestrador' : agent.category,
    adapterId: agent.cli,
    modelId,
    rateLabel: modelId
      ? metadata === undefined
        ? 'Consultando preço no catálogo…'
        : formatRate(metadata)
      : 'Preço indisponível: modelo não definido',
    estimateLabel: modelId
      ? metadata === undefined
        ? 'Estimativa aguardando catálogo'
        : costRange
          ? 'Uso da missão indisponível antes do plano por agente'
          : 'Estimativa indisponível'
      : 'Estimativa indisponível',
  }));

  const loading = resolved.some(
    (entry) => entry.modelId && entry.metadata === undefined,
  );
  if (loading) {
    return {
      lines,
      complete: false,
      totalLabel: 'Consultando preços do time…',
      caveat:
        'A faixa só aparece depois que todos os modelos forem conferidos no catálogo.',
    };
  }

  const complete =
    resolved.length > 0 &&
    resolved.every((entry) => entry.modelId && entry.costRange);
  if (!complete) {
    return {
      lines,
      complete: false,
      totalLabel:
        'Faixa de referência indisponível: algum modelo do time não tem preço no catálogo.',
      caveat:
        'Isto não impede iniciar a missão — é só o preview de custo. O Nexus ' +
        'apenas não inventa preço ausente nem trata modelo sem catálogo como gratuito.',
    };
  }

  const rosterRanges = resolved.map(
    (entry) => entry.costRange as CostRange,
  );
  const rateMin = Math.min(...rosterRanges.map((range) => range.minPerMillion));
  const rateMax = Math.max(...rosterRanges.map((range) => range.maxPerMillion));

  return {
    lines,
    complete: true,
    totalLabel:
      `Faixa de referência do time: ${formatUsd(rateMin)}–` +
      `${formatUsd(rateMax)} por 1M tokens. Estimativa total indisponível ` +
      'antes do plano por agente.',
    caveat:
      'Os limites de tokens do plano são controles operacionais; eles não ' +
      'representam a cobrança do provedor nem permitem prever o custo total.',
  };
}

export function forecastMissionWaves(input: {
  lane: MissionLane | undefined;
  maxWorkers: number;
  goal?: string;
}): MissionWavePreview[] {
  const standardExecutionDetail =
    input.maxWorkers <= 0
      ? 'Nenhum especialista adicional pode ser iniciado nesta missão.'
      : input.maxWorkers === 1
        ? '1 especialista pode executar a tarefa sem paralelismo.'
        : `Até ${input.maxWorkers} especialistas podem trabalhar em paralelo onde não houver conflito.`;
  const opsExecutionDetail =
    input.maxWorkers <= 0
      ? 'Nenhum especialista adicional pode ser iniciado nesta operação.'
      : input.maxWorkers === 1
        ? '1 especialista atua dentro das autorizações concedidas.'
        : `Até ${input.maxWorkers} especialistas atuam dentro das autorizações concedidas.`;
  switch (input.lane ?? 'standard') {
    case 'consult':
      return [
        {
          title: 'Investigar',
          detail: 'Ler o sistema e reunir evidências sem alterar o projeto.',
        },
        {
          title: 'Sintetizar',
          detail: 'Consolidar resposta, limites e próximos passos verificáveis.',
        },
      ];
    case 'plan':
      return [
        {
          title: 'Mapear o sistema',
          detail: 'Levantar restrições, dependências e riscos no código real.',
        },
        {
          title: 'Desenhar o plano',
          detail: 'Organizar solução, sequência e critérios de aceite.',
        },
        {
          title: 'Criticar e fechar',
          detail: 'Testar premissas e entregar um plano pronto para execução.',
        },
      ];
    case 'ops':
      return [
        {
          title: 'Pré-checar',
          detail: 'Confirmar alvo, acesso, estado atual e caminho de reversão.',
        },
        {
          title: 'Executar com controle',
          detail: opsExecutionDetail,
        },
        {
          title: 'Validar ou reverter',
          detail: 'Provar o resultado e aplicar recuperação se necessário.',
        },
      ];
    case 'standard':
      if (
        classifyStandardMissionTopology(input.goal ?? '') ===
        'team-read-only-fanout'
      ) {
        return [
          {
            title: 'Responder em paralelo',
            detail:
              'Cada especialista responde ao objetivo em somente leitura, sem depender do participante anterior.',
          },
          {
            title: 'Consolidar handoffs',
            detail:
              'O Nexus comprova todas as respostas físicas e encerra a rodada.',
          },
        ];
      }
      return [
        {
          title: 'Entender e planejar',
          detail: 'Transformar o objetivo em tarefas, dependências e provas.',
        },
        {
          title: 'Implementar',
          detail: standardExecutionDetail,
        },
        {
          title: 'Consolidar',
          detail: 'Integrar handoffs aceitos e resolver conflitos com rastreabilidade.',
        },
        {
          title: 'Validar e integrar',
          detail: 'Rodar as provas do resultado e fechar apenas com evidência.',
        },
      ];
  }
}

/**
 * O wizard ainda não recebe o plano durável de tarefas: roster e prompt não
 * provam que um review final será executado. Só o squad dedicado pode dizer
 * que o próprio resultado é Review P0–P3.
 */
export function missionReviewP0P3Status(
  squad: Pick<Squad, 'id'>,
): MissionReviewP0P3Status {
  if (squad.id === 'review-p0p3') {
    return {
      kind: 'dedicated',
      label: 'Review P0–P3 é o resultado principal desta missão.',
      detail:
        'Esta missão inteira é dedicada à revisão; não existe uma fase final adicional.',
    };
  }
  return {
    kind: 'not-controlled',
    label: 'Ainda não confirmado.',
    detail:
      'O time pode incluir revisores, mas o Nexus só confirma a revisão ' +
      'automática quando ela existir como etapa controlada no plano de execução.',
  };
}
