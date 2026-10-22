import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  suggestMissionLaneFromGoal,
  type MissionLane,
} from '../../shared/mission-intent';
import { isVisualAssetText } from '../../shared/ui-work-signal';
import { isUiMissionText } from '../../shared/mission-work-kind';
import { isReverseEngineeringTask } from '../../shared/reverse-engineering-intent';
import { listInstalledCatalogItems } from './catalog-installed';

/**
 * Skills that Nexus is allowed to assign automatically. This is deliberately
 * a small, reviewed vocabulary: neither a model response nor renderer bytes
 * can introduce a new executable skill name.
 */
export const NEXUS_GUIDED_SKILL_ORDER = [
  'ponytail',
  'check-work',
  'bridgesecurity',
  'bridgeward',
  'impeccable',
  'dembrandt',
  'ui-kit',
  'archify',
  'superpowers',
  'nexus-visual-media',
  'rea',
  'oc-pilot',
  'oc-builder',
  'oc-scout',
  'oc-conveyor',
] as const;

const NEXUS_GUIDED_SKILLS = new Set<string>(NEXUS_GUIDED_SKILL_ORDER);
const VISUAL_GENERATION_TOOLS = [
  'nexus_media_providers',
  'nexus_image_generate',
] as const;

/**
 * These skills ship with Nexus and can be materialized by skill-mirror even
 * before a provider-specific copy exists in the user's home. Exported so the
 * recipe lint does not report the app's own vocabulary as "missing from the
 * local catalog" before the first mirror runs.
 */
export const BUNDLED_GUIDED_SKILLS = [
  'ponytail',
  'bridgesecurity',
  'bridgeward',
  'impeccable',
  'dembrandt',
  'ui-kit',
  'archify',
  'superpowers',
  'nexus-visual-media',
  'rea',
  'oc-pilot',
  'oc-builder',
  'oc-scout',
  'oc-conveyor',
] as const;

/*
 * O vocabulário visual NÃO mora mais aqui.
 *
 * As duas camadas continuam existindo — FORTE (uma ocorrência já caracteriza a
 * missão) e FRACA (dois sinais distintos formam quórum) — mas agora são
 * `selfEvident: true|false` em `src/shared/ui-work-signal.ts`, a fonte única
 * que o contract-compiler, o bootstrap do contrato de design e o
 * `classifyWorkKind` também leem. Quatro gramáticas respondiam "isto é UI?" e
 * discordavam em produção; o cabeçalho daquele módulo conta o incidente.
 *
 * O quórum foi calibrado contra falso positivo real e continua intacto: é ele
 * que separa "trocar as cores do tema" (visual) de "documentar o esquema de
 * cores do log" (não visual), e "corrigir o alinhamento dos botões" (visual)
 * de "corrigir o bug da tela de erro que trava o backend" (não visual).
 *
 * Custo do falso positivo aqui: além de impeccable/dembrandt, a missão passa a
 * exigir contrato de revisão visual (build estático + screenshot).
 */
const UI_ROLE_RE =
  /\b(ui|ux|frontend|front-end|interface|design|visual|a11y|accessibility|acessibilidade)\b/i;
const SECURITY_RE =
  /\b(security|seguranca|secure|auth|authentication|autenticacao|authorization|autorizacao|login|oauth|payment|pagamento|credential|credencial|secret|segredo|token|privacy|privacidade|user data|dados (?:de|do) usuario|api exposta|exposed api)\b/i;
const VISUAL_ROLE_RE =
  /\b(image|imagem|visual|asset|sprite|avatar|illustration|ilustracao|designer|mascot|mascote|pet)\b/i;
export interface GuidedSquadSkillPolicyOptions {
  /**
   * Main-owned goal/project signal. Callers should never pass a model-provided
   * allowedSkills array here; the policy derives grants from role + objective.
   */
  readonly objective?: string;
  /**
   * Pure-test/embedded inventory override. Values are still intersected with
   * NEXUS_GUIDED_SKILL_ORDER, so this cannot widen the vocabulary.
   */
  readonly availableSkillNames?: Iterable<string>;
  /**
   * Delivery lane the roster will run under. Main-owned: callers pass the
   * lane of the frozen intent contract; when it is absent the policy infers
   * it from the goal with the same pure rule the wizard uses. Only used to
   * refine grants (never to widen them).
   */
  readonly lane?: MissionLane;
}

function normalizeSignal(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Missão de INTERFACE (não de asset visual). Delegação pura para a fonte
 * única: um termo auto-evidente, quórum de dois termos ambíguos, OU qualquer
 * objetivo que receba autoridade de design.
 *
 * Este é o predicado GENEROSO — ele concede skill (impeccable/dembrandt) e
 * liga o contrato de revisão visual. Quem decide ESCREVER um DESIGN.md é
 * `decideDesignAuthority`, estritamente mais restrito; a invariante
 * "autoridade ⟹ missão de UI" é provada em mission-work-kind.test.ts.
 */
export const isGuidedUiMissionObjective = isUiMissionText;

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

function availableGuidedSkills(
  override: Iterable<string> | undefined,
): Set<string> {
  const discovered =
    override ??
    [
      ...BUNDLED_GUIDED_SKILLS,
      ...listInstalledCatalogItems()
        .filter((item) => item.kind === 'skill')
        .map((item) => item.name),
    ];
  return new Set(
    [...discovered]
      .map(normalizeSkillName)
      .filter((name) => NEXUS_GUIDED_SKILLS.has(name)),
  );
}

function orderedAvailableGrants(
  requested: ReadonlySet<string>,
  available: ReadonlySet<string>,
): string[] {
  return NEXUS_GUIDED_SKILL_ORDER.filter(
    (name) => requested.has(name) && available.has(name),
  );
}

function policyForAgent(input: {
  agent: SquadAgent;
  missionSignal: string;
  executorCount: number;
  visualOwnerId: string | null;
  planLane: boolean;
  available: ReadonlySet<string>;
}): Pick<SquadAgent, 'allowedSkills' | 'allowedTools'> {
  const {
    agent,
    missionSignal,
    executorCount,
    visualOwnerId,
    planLane,
    available,
  } = input;
  const roleSignal = normalizeSignal(`${agent.id} ${agent.agentName}`);
  const requested = new Set<string>();
  const uiMission = isGuidedUiMissionObjective(missionSignal);
  const uiRole = UI_ROLE_RE.test(roleSignal);
  const securityWork =
    SECURITY_RE.test(missionSignal) || SECURITY_RE.test(roleSignal);

  switch (agent.category) {
    case 'orchestrator':
      requested.add('ponytail');
      requested.add('check-work');
      break;
    case 'executor':
      requested.add('ponytail');
      break;
    case 'reviewer':
      // Includes execution QA: verification is always an explicit capability.
      requested.add('check-work');
      break;
    case 'architect':
      requested.add('ponytail');
      requested.add('check-work');
      requested.add('archify');
      requested.add('superpowers');
      break;
    case 'scout':
      requested.add('bridgeward');
      break;
  }

  // Documento de plano (design, plano de implementação, tasks). Dois
  // caminhos main-owned, nenhum por id de squad: o papel que o roster declara
  // como dono do documento, e o orquestrador de uma missão de lane plan —
  // cuja ÚNICA saída gravável é justamente o plano. O ciclo é Superpowers
  // (brainstorm → writing-plans → executing-plans); BMAD saiu do padrão.
  const ownsPlanDocs = agent.ownsPlanDocs === true;
  if (ownsPlanDocs || (agent.category === 'orchestrator' && planLane)) {
    requested.add('superpowers');
  }
  // archify materializa um HTML de diagrama no repositório. Vai só para o
  // dono de documento que também conduz a arquitetura (orquestrador; o ramo
  // architect já concede), e nunca na lane plan, cuja escrita é cercada a
  // plan.md — ali o diagrama é ESPECIFICADO e só é renderizado depois da
  // promoção para standard.
  if (ownsPlanDocs && !planLane && agent.category === 'orchestrator') {
    requested.add('archify');
  }

  if (agent.category === 'orchestrator' && uiMission) {
    // Only the orchestrator may call nexus_design_system_extract (workers are
    // fenced). Grant dembrandt solely here so executors/reviewers do not try
    // and fail the extract tool.
    requested.add('dembrandt');
    // The kit INSTALLS code, so it follows the archify precedent and stays out
    // of the plan lane, whose writes are fenced to plan.md: there the surface
    // is SPECIFIED, and a grant would only buy a refusal nobody can explain.
    // Outside that lane the orchestrator picks the recipe for the whole
    // surface, so it needs the kit as much as the executor does.
    if (!planLane) requested.add('ui-kit');
  }
  if (
    agent.category === 'reviewer' &&
    (uiMission || uiRole)
  ) {
    requested.add('impeccable');
    // A reviewer that does not know the kit flags a hand-written primitive as
    // "fine" instead of "this already exists installed".
    requested.add('ui-kit');
  }
  if (
    agent.category === 'executor' &&
    (uiRole || (uiMission && executorCount === 1))
  ) {
    requested.add('impeccable');
    requested.add('ui-kit');
  }

  if (securityWork) requested.add('bridgesecurity');

  // REA also guides planning/review; the skill does not confer execution
  // authority or imply that a reverse-engineering runtime is installed.
  if (isReverseEngineeringTask(missionSignal)) requested.add('rea');

  const visualMission = isVisualAssetText(missionSignal);
  const visualGenerationOwner =
    agent.category === 'executor' &&
    visualMission &&
    agent.id === visualOwnerId;
  if (visualGenerationOwner) {
    requested.add('nexus-visual-media');
  }

  return {
    allowedSkills: orderedAvailableGrants(requested, available),
    allowedTools:
      agent.category === 'orchestrator'
        ? null
        : visualGenerationOwner
          ? [...VISUAL_GENERATION_TOOLS]
          : [],
  };
}

/**
 * Replace every guided agent's skill authority with the deterministic Nexus
 * policy. Existing allowedSkills bytes are intentionally ignored.
 */
export function applyGuidedSquadSkillPolicy(
  squad: Squad,
  options: GuidedSquadSkillPolicyOptions = {},
): Squad {
  const missionSignal = normalizeSignal(
    options.objective?.trim() ||
      `${squad.name}\n${squad.orchestratorInstructions}\n${squad.nativeInstructions ?? ''}`,
  );
  const planLane =
    (options.lane ?? suggestMissionLaneFromGoal(missionSignal)) === 'plan';
  const available = availableGuidedSkills(options.availableSkillNames);
  const executorCount = squad.agents.filter(
    (agent) => agent.category === 'executor',
  ).length;
  const executors = squad.agents.filter(
    (agent) => agent.category === 'executor',
  );
  const visualOwnerId = isVisualAssetText(missionSignal)
    ? (
        executors.find((agent) =>
          VISUAL_ROLE_RE.test(
            normalizeSignal(`${agent.id} ${agent.agentName}`),
          ),
        ) ?? (executors.length === 1 ? executors[0] : undefined)
      )?.id ?? null
    : null;

  return {
    ...squad,
    agents: squad.agents.map((agent) => {
      const policy = policyForAgent({
        agent,
        missionSignal,
        executorCount,
        visualOwnerId,
        planLane,
        available,
      });
      return {
        ...agent,
        ...policy,
      };
    }),
  };
}

/**
 * Deterministic role floor for a roster that has no mission attached yet
 * (built-in catalog entries, saved squads). Pure by construction: it reads
 * neither a goal nor the installed catalog, so the same roster yields the
 * same grants on every machine — including at module load, where a
 * filesystem scan would be a side effect and would bake one machine's
 * inventory into the app-managed table. The inventory intersection is a
 * precision filter, not an authority boundary: skill-mirror simply skips a
 * grant it cannot find on disk.
 */
export function defaultGuidedSkillsForAgent(agent: SquadAgent): string[] {
  return (
    policyForAgent({
      agent,
      missionSignal: '',
      executorCount: 0,
      visualOwnerId: null,
      planLane: false,
      available: NEXUS_GUIDED_SKILLS,
    }).allowedSkills ?? []
  );
}

/**
 * Fill ONLY the agents that declare no skill authority at all. An explicit
 * list (including `[]`) and an explicit `null` are reviewed authority and are
 * never rewritten — this closes the "undefined means zero skills under
 * governance" hole without touching any policy someone actually decided.
 *
 * `authorityRoster` is the main-owned roster that decides the floor. Pass the
 * catalog source when the agents being normalized came from outside main, so
 * renderer bytes cannot claim a role/flag they were not reviewed with.
 */
export function withGuidedSkillDefaults(
  agents: readonly SquadAgent[],
  authorityRoster: readonly SquadAgent[] = agents,
): SquadAgent[] {
  const authority = new Map(
    authorityRoster.map((agent) => [agent.id, agent] as const),
  );
  return agents.map((agent) =>
    agent.allowedSkills !== undefined
      ? agent
      : {
          ...agent,
          allowedSkills: defaultGuidedSkillsForAgent(
            authority.get(agent.id) ?? agent,
          ),
        },
  );
}
