import type { Squad, SquadAgent } from '../../shared/orch-types';
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
  'archify',
  'bmad-templates',
  'nexus-visual-media',
] as const;

const NEXUS_GUIDED_SKILLS = new Set<string>(NEXUS_GUIDED_SKILL_ORDER);
const VISUAL_GENERATION_TOOLS = [
  'nexus_media_providers',
  'nexus_image_generate',
] as const;

/**
 * These skills ship with Nexus and can be materialized by skill-mirror even
 * before a provider-specific copy exists in the user's home.
 */
const BUNDLED_GUIDED_SKILLS = [
  'ponytail',
  'bridgesecurity',
  'bridgeward',
  'impeccable',
  'archify',
  'bmad-templates',
  'nexus-visual-media',
] as const;

const UI_MISSION_RE =
  /\b(ui|ux|frontend|front-end|interface|design system|dashboard|landing|website|site|web app|aplicativo|mobile|desktop|electron|react|vue|svelte|acessibilidade|accessibility)\b/i;
const UI_ROLE_RE =
  /\b(ui|ux|frontend|front-end|interface|design|visual|a11y|accessibility|acessibilidade)\b/i;
const SECURITY_RE =
  /\b(security|seguranca|secure|auth|authentication|autenticacao|authorization|autorizacao|login|oauth|payment|pagamento|credential|credencial|secret|segredo|token|privacy|privacidade|user data|dados (?:de|do) usuario|api exposta|exposed api)\b/i;
const VISUAL_ASSET_RE =
  /\b(image|imagem|photo|foto|artwork|arte|illustration|ilustracao|sprite|spritesheet|avatar|logo|icon|icone|asset visual|visual asset|mascot|mascote|desktop pet)\b/i;
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
}

function normalizeSignal(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function isGuidedUiMissionObjective(value: string): boolean {
  return UI_MISSION_RE.test(normalizeSignal(value));
}

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
  available: ReadonlySet<string>;
}): Pick<SquadAgent, 'allowedSkills' | 'allowedTools'> {
  const { agent, missionSignal, executorCount, available } = input;
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
      requested.add('bmad-templates');
      break;
    case 'scout':
      requested.add('bridgeward');
      break;
  }

  if (
    agent.category === 'reviewer' &&
    (uiMission || uiRole)
  ) {
    requested.add('impeccable');
  }
  if (
    agent.category === 'executor' &&
    (uiRole || (uiMission && executorCount === 1))
  ) {
    requested.add('impeccable');
  }

  if (securityWork) requested.add('bridgesecurity');

  const visualMission = VISUAL_ASSET_RE.test(missionSignal);
  const visualRole = VISUAL_ROLE_RE.test(roleSignal);
  const visualGenerationOwner =
    agent.category === 'executor' &&
    agent.cli === 'codex' &&
    visualMission &&
    (visualRole || executorCount === 1);
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
  const available = availableGuidedSkills(options.availableSkillNames);
  const executorCount = squad.agents.filter(
    (agent) => agent.category === 'executor',
  ).length;

  return {
    ...squad,
    agents: squad.agents.map((agent) => {
      const policy = policyForAgent({
        agent,
        missionSignal,
        executorCount,
        available,
      });
      return {
        ...agent,
        ...policy,
      };
    }),
  };
}
