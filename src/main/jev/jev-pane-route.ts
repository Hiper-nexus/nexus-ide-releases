import {
  classifyTaskWithSkillForRouting,
  routingOverridesFrom,
  type RouteTaskJevBatchDeps,
} from '../orch/jev-task-routing';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';
import { cliSupportsSkillSurface, SKILL_SUGGESTION_MIN_CONFIDENCE } from '../orch/jev-skill-suggestion';
import { classifyTask } from '../orch/task-router';
import {
  isPaneRouteEffort,
  type PaneRouteProposal,
  type PaneRouteRequest,
  type PaneRouteResult,
  type PaneRouteSource,
} from '../../shared/pane-route';

/**
 * Proposta de esforço e skill para um pane aberto na MÃO do operador.
 *
 * Por que só esforço e skill: no "+ Pane" quem escolhe a CLI é o operador, na
 * lista. Escolher a CLI aqui exigiria o pool de disponibilidade do
 * `routeTaskForCaller` (cota medida, recusa de credencial no spawn, assento de
 * primeira onda) e criaria RESERVA de rota — efeito, a partir do renderer.
 * O que o pane aberto na mão nunca teve foi o resto: ele nascia no padrão do
 * provider, com `--effort` fixo e sem skill. É isso que esta proposta preenche.
 *
 * Nada aqui concede autoridade: o spawn continua pelo caminho de sempre e o
 * Main reavalia tudo lá. Uma proposta recusada não é erro — o "+ Pane" segue
 * exatamente como sempre foi.
 */

export interface ProposePaneRouteDeps {
  readonly classify?: typeof classifyTaskWithSkillForRouting;
  /** Raiz do projeto para o catálogo de skills instaladas (F-753). */
  readonly projectRoot?: () => string | undefined;
  readonly routingDeps?: RouteTaskJevBatchDeps;
}

function round2(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : undefined;
}

/** `undefined` quando nenhuma dimensão teve número — chave vazia polui o recibo. */
function confidenceOf(
  tier: number | undefined,
  specialty: number | undefined,
  effort: number | undefined,
  skill: number | undefined,
): PaneRouteProposal['confidence'] {
  const out = {
    ...(tier === undefined ? {} : { tier }),
    ...(specialty === undefined ? {} : { specialty }),
    ...(effort === undefined ? {} : { effort }),
    ...(skill === undefined ? {} : { skill }),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function proposePaneRoute(
  request: PaneRouteRequest,
  deps: ProposePaneRouteDeps = {},
): Promise<PaneRouteResult> {
  const task = request.request.trim();
  if (!task) return { ok: false, reason: 'empty' };

  const classify = deps.classify ?? classifyTaskWithSkillForRouting;
  const projectRoot = (deps.projectRoot ?? (() => activeWorkspaceOrNull() ?? undefined))();

  let batch: Awaited<ReturnType<typeof classifyTaskWithSkillForRouting>>;
  try {
    batch = await classify(task, {
      // Mão do operador: o catálogo inteiro de skills está liberado para ele.
      allowedSkills: null,
      ...(projectRoot ? { projectRoot } : {}),
      ...(deps.routingDeps ? { deps: deps.routingDeps } : {}),
    });
  } catch {
    // Fail-open: o Jev fora do ar nunca pode impedir o operador de abrir pane.
    return { ok: false, reason: 'error' };
  }

  if (batch.kind === 'skipped') return { ok: false, reason: 'empty' };
  const pick = batch.skillSuggestion ?? null;
  const skill = pick && pick.confidence >= SKILL_SUGGESTION_MIN_CONFIDENCE &&
    (pick.path || !request.adapterId || cliSupportsSkillSurface(request.adapterId))
    ? pick.name : undefined;
  if (batch.kind === 'unavailable' && !skill) {
    return { ok: false, reason: batch.reason === 'disabled' ? 'disabled' : 'no-route' };
  }

  const classification = batch.kind === 'classified' ? batch.classification : null;
  const overrides = routingOverridesFrom(classification, undefined, task);
  const tier = overrides.tierOverride ?? classification?.tier ?? classifyTask(task).tier;
  const effort = isPaneRouteEffort(overrides.effortOverride)
    ? overrides.effortOverride
    : undefined;

  const source: PaneRouteSource =
    overrides.classifierSource === 'jev'
      ? 'jev'
      : overrides.classifierSource === 'mixed'
        ? 'mixed'
        : 'heuristic';

  const proposal: PaneRouteProposal = {
    ...(effort ? { effort } : {}),
    ...(skill ? { skill } : {}),
    tier,
    ...(overrides.specialtyOverride ? { specialty: overrides.specialtyOverride } : {}),
    // Nunca ecoa o pedido do operador: só os rótulos que o motor decidiu.
    reason: `tier ${tier}`,
    source,
    ...(() => {
      const confidence = confidenceOf(
        round2(overrides.confidence?.tier),
        round2(overrides.confidence?.specialty),
        round2(overrides.confidence?.effort),
        skill && classification ? round2(pick?.confidence) : undefined,
      );
      return confidence ? { confidence } : {};
    })(),
  };

  return { ok: true, proposal };
}
