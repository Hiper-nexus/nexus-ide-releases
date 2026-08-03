/**
 * POR QUE a missão parou — transporte e apresentação, nunca autoridade nova.
 *
 * A razão já existe e é durável: o bloqueio técnico é anexado à descrição da
 * missão com marcadores (`[NEXUS_*]`, `<!-- nexus:* -->`) espelhando o
 * `task_dispatch_queue.last_error`. O que faltava era ela VIAJAR até onde o
 * operador decide: balão do pet, toast, card do rail e painel da missão. Todas
 * essas superfícies diziam "a missão parou esperando uma decisão" — texto que
 * não deixa ninguém entender, resolver ou ajustar nada.
 *
 * Este módulo é puro (sem zod/node/electron) e não muda o que bloqueia: só
 * nomeia a causa que já está gravada, em português, com o próximo passo. Se a
 * causa não estiver registrada, ele DIZ isso em vez de inventar.
 */

import {
  ORPHAN_SEALED_PLAN_CODE,
  ORPHAN_SEALED_PLAN_MARKER,
} from './mission-plan-orphan';

export type MissionBlockCauseCode =
  /** O despacho abortou antes de o worker existir. */
  | 'dispatch-failed'
  /** O Maestro nasceu, mas o kickoff não foi aceito (boot/idle/timeout). */
  | 'kickoff-failed'
  /** O Maestro encerrou antes do primeiro dispatch — nenhum worker começou. */
  | 'maestro-pre-dispatch-exit'
  /** O worker rodou e encerrou sem entregar handoff. */
  | 'worker-no-handoff'
  /** A CLI/modelo do roster não está utilizável agora. */
  | 'provider-unavailable'
  /** Outra tarefa já reservou os mesmos arquivos/worktree. */
  | 'ownership-conflict'
  /** O worker entregou, mas a entrega não chegou ao orquestrador. */
  | 'handoff-not-delivered'
  /** O plano selado ficou numa versão anterior da intenção. */
  | 'orphan-plan'
  /** Falha marcada como terminal, sem causa mais específica registrada. */
  | 'terminal-failure'
  /** Existe pergunta pendente esperando o operador — decisão de verdade. */
  | 'human-decision'
  /** Nenhuma razão foi registrada; admitir é melhor que inventar. */
  | 'unknown';

export interface MissionBlockCause {
  readonly code: MissionBlockCauseCode;
  /** O que aconteceu, em uma frase. */
  readonly headline: string;
  /** O que o operador faz agora. */
  readonly action: string;
  /** Trecho saneado da nota durável, quando existe. */
  readonly detail: string | null;
}

export interface MissionBlockCauseInput {
  readonly status?: string;
  readonly intentState?: string | null;
  readonly description?: string | null;
  /** True quando há pergunta durável aguardando resposta do operador. */
  readonly pendingQuestion?: boolean;
}

export const MISSION_BLOCK_CAUSE_DETAIL_LIMIT = 160;
export const MISSION_BLOCK_CAUSE_TEXT_LIMIT = 180;

const COPY: Readonly<
  Record<MissionBlockCauseCode, { headline: string; action: string }>
> = Object.freeze({
  'dispatch-failed': {
    headline: 'O despacho da tarefa abortou antes de o worker começar.',
    action: 'Abra o diagnóstico da missão e clique em Retomar missão.',
  },
  'kickoff-failed': {
    headline: 'O Maestro abriu, mas o kickoff não foi aceito a tempo.',
    action:
      'Abra o pane do Maestro, confira se a CLI ficou ociosa, e retome a missão.',
  },
  'maestro-pre-dispatch-exit': {
    headline: 'O Maestro encerrou antes de delegar a primeira tarefa.',
    action:
      'Abra o diagnóstico, confira a saída do Maestro e clique em Retomar missão.',
  },
  'worker-no-handoff': {
    headline: 'O worker encerrou sem entregar o resultado da tarefa.',
    action: 'Confira login e cota do provider em Providers e retome a missão.',
  },
  'provider-unavailable': {
    headline: 'A CLI selada no roster não está disponível para esta tarefa.',
    action: 'Abra Providers, corrija instalação ou login, e retome a missão.',
  },
  'ownership-conflict': {
    headline: 'Outra tarefa já reservou os mesmos arquivos desta missão.',
    action: 'Abra o diagnóstico, libere a reserva presa e retome a missão.',
  },
  'handoff-not-delivered': {
    headline: 'O worker terminou, mas a entrega não chegou ao orquestrador.',
    action: 'Abra o diagnóstico da missão e reenvie a entrega pendente.',
  },
  'orphan-plan': {
    headline: 'O plano selado ficou numa versão anterior da intenção.',
    action: 'Retome a missão para re-selar o plano na versão atual.',
  },
  'terminal-failure': {
    headline: 'A recuperação automática se esgotou nesta falha.',
    action: 'Abra o diagnóstico da missão, corrija a causa e retome a missão.',
  },
  'human-decision': {
    headline: 'A missão está esperando uma resposta sua.',
    action: 'Abra a missão e responda a pergunta pendente.',
  },
  unknown: {
    headline: 'Motivo não registrado.',
    action: 'Abra o diagnóstico da missão para ver o que aconteceu.',
  },
});

/**
 * Ordem = especificidade. O bloco real de campo carrega vários marcadores ao
 * mesmo tempo (dispatch bloqueado + kickoff não aceito + worker sem handoff);
 * a causa útil para o operador é a mais específica, não a primeira gravada.
 */
const RULES: readonly {
  readonly code: MissionBlockCauseCode;
  readonly test: RegExp;
}[] = Object.freeze([
  {
    code: 'orphan-plan',
    test: new RegExp(
      `${ORPHAN_SEALED_PLAN_MARKER.replace(/[[\]]/gu, '\\$&')}|${ORPHAN_SEALED_PLAN_CODE}`,
      'u',
    ),
  },
  {
    code: 'handoff-not-delivered',
    test: /<!--\s*nexus:handoff-delivery-failed:|\[NEXUS_HANDOFF_REBIND_BLOCKED\]/u,
  },
  {
    code: 'provider-unavailable',
    test: /\[NEXUS_RETIRED_ROSTER_ROUTE\]|roster_route_unavailable|roster_model_unavailable|roster_route_forbidden|mission_worker_route_unavailable/u,
  },
  {
    code: 'ownership-conflict',
    test: /\[NEXUS_INTERRUPTED_WORKTREE_RESERVATION\]|\[NEXUS_DEAD_OWNER_WORKTREE_RELEASE\]|ownership da task conflita|worktree .*(?:ocupad|reservad)/u,
  },
  {
    code: 'worker-no-handoff',
    test: /\[NEXUS_WORKER_RUNTIME_LOST\]|não entregou um handoff|sem entregar um handoff/u,
  },
  {
    code: 'maestro-pre-dispatch-exit',
    test: /<!--\s*nexus:orchestrator-pre-dispatch-exit|orchestrator_session_exited_before_first_dispatch/u,
  },
  {
    code: 'kickoff-failed',
    test: /<!--\s*nexus:kickoff-not-accepted|<!--\s*nexus:kickoff-failure:/u,
  },
  {
    code: 'dispatch-failed',
    test: /\[NEXUS_TASK_DISPATCH_BLOCKED\]|\[NEXUS_DEAD_ORCHESTRATOR_RECOVERY_BLOCKED\]|<!--\s*nexus:orchestrator-bootstrap-blocked|<!--\s*nexus:guided-plan-block|<!--\s*nexus:plan-promotion-[a-z]+-blocked/u,
  },
  // Último: `[NEXUS_FAILURE:terminal]` é marcador de SEVERIDADE, não de causa.
  // Sozinho ele só garante que a recuperação automática acabou.
  { code: 'terminal-failure', test: /\[NEXUS_FAILURE:terminal\]/u },
]);

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const SECRET =
  /\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[abpsr]|AIza|ya29)[-_][A-Za-z0-9_-]{8,}/gu;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"'),;]*/gu;
const POSIX_PATH =
  /(?<![\w~.])\/(?:Users|home|private|var|tmp|opt|Applications|Library|etc|mnt)\/[^\s"'),;]*/gu;
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/gu;

/** Remove caminho absoluto, e-mail e segredo/hash opaco do texto durável. */
export function redactMissionBlockDetail(value: string): string {
  return value
    .replace(EMAIL, '<e-mail>')
    .replace(SECRET, '<token>')
    .replace(WINDOWS_PATH, '<caminho>')
    .replace(POSIX_PATH, '<caminho>')
    .replace(OPAQUE, '<token>')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, Math.max(1, limit - 1));
  const space = cut.lastIndexOf(' ');
  const head = space > limit * 0.6 ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const NEXUS_TOKEN = /\[NEXUS_[A-Za-z0-9_:.-]+\]/gu;
const HEADING_LINE = /^##[ \t]+.*$/u;

/** Primeira linha REAL da nota técnica: sem marcador, sem heading, sem CTA. */
function detailFrom(description: string): string | null {
  const lines = description
    .replace(HTML_COMMENT, '\n')
    .replace(NEXUS_TOKEN, ' ')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !HEADING_LINE.test(line) &&
        !line.startsWith('Clique em'),
    );
  for (const line of lines.slice(1)) {
    const redacted = redactMissionBlockDetail(line);
    if (redacted.length > 0) return clip(redacted, MISSION_BLOCK_CAUSE_DETAIL_LIMIT);
  }
  return null;
}

/**
 * Nomeia a causa do bloqueio a partir do que JÁ está gravado. Nunca inventa:
 * sem marcador e sem pergunta pendente, o código é `unknown`.
 */
export function missionBlockCause(
  input: MissionBlockCauseInput,
): MissionBlockCause {
  const description = input.description ?? '';
  // A pergunta pendente vence a nota técnica: é o que o operador FAZ agora.
  if (input.pendingQuestion === true) {
    return Object.freeze({ ...COPY['human-decision'], code: 'human-decision', detail: null });
  }
  const matched = RULES.find((rule) => rule.test.test(description));
  if (!matched) {
    return Object.freeze({ ...COPY.unknown, code: 'unknown', detail: null });
  }
  return Object.freeze({
    ...COPY[matched.code],
    code: matched.code,
    detail: detailFrom(description),
  });
}

/**
 * Frase única para superfícies estreitas (balão, toast, rail). O ACIONÁVEL é
 * inegociável: quando não cabe tudo, quem é truncado é o porquê, nunca o que
 * fazer — uma mensagem cortada que perde a ação volta a não operar nada.
 */
export function missionBlockCauseText(
  cause: MissionBlockCause,
  limit: number = MISSION_BLOCK_CAUSE_TEXT_LIMIT,
): string {
  const action = clip(cause.action, limit);
  const room = limit - action.length - 1;
  if (room < 12) return action;
  return `${clip(cause.headline, room)} ${action}`;
}

/** True quando a razão é conhecida — usado para escolher a CTA da superfície. */
export function hasNamedMissionBlockCause(cause: MissionBlockCause): boolean {
  return cause.code !== 'unknown';
}
