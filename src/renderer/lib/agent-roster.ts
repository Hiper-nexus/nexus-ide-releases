import type { PaneModel, PaneSessionState } from '../../shared/types';
import { familyFromAdapterId, resolveModelChipLabel } from './pane-model-label';
import { normalizePaneTitle } from './pane-title';

/**
 * Quem está trabalhando AGORA — a leitura viva dos agentes de um workspace.
 *
 * O rail mostrava "3 agentes" recolhido, cada um com o título OSC da CLI
 * cortado ("GPT · t-7bcf00cf…"): com mais de um agente rodando em paralelo
 * ninguém via QUEM trabalhava, em quê, nem quantos. Esta camada é pura (sem
 * React, sem store) e é a única que decide o que é "trabalhando" para o rail,
 * as abas e o cabeçalho da missão — contagens e rótulos nunca divergem.
 *
 * Fonte do estado: o mesmo `displayStates` do chip da toolbar (o busy fica um
 * instante depois de ociosar, então um respiro curto do stream não faz a linha
 * piscar). `kind` é a chave de estilo; a PALAVRA vai sempre junto — estado
 * nunca viaja só em cor (DESIGN.md §2).
 */

export type RosterAgentKind =
  | 'working'
  | 'starting'
  | 'waiting'
  | 'sleeping'
  | 'stopped'
  | 'unknown';

export interface RosterAgent {
  readonly paneId: string;
  readonly kind: RosterAgentKind;
  /** `kind === 'working'`, para o consumidor não repetir a comparação. */
  readonly working: boolean;
  /** Palavra do estado: Trabalhando · Iniciando · Aguardando · Dormindo · Encerrado. */
  readonly stateLabel: string;
  /** Quem é: nome do agente do squad, "Orquestrador" ou "Pane 7". */
  readonly name: string;
  /** CLI + modelo em linguagem de gente: "Claude Sonnet 4.5", "GPT 5.6 Luna". */
  readonly cli: string;
  /** Mesma identidade com o esforço, para tooltip: "Claude Sonnet 4.5 · High". */
  readonly cliDetail: string;
  /** Tarefa curta e legível; `null` quando o título é só id técnico/genérico. */
  readonly task: string | null;
  readonly orchestrator: boolean;
  readonly paneNumber: number | null;
  readonly adapterId: string | undefined;
}

export interface RosterFleet {
  /** Orquestrador primeiro, depois a ordem do layout — estável entre estados. */
  readonly agents: readonly RosterAgent[];
  readonly workingCount: number;
  /** Dois ou mais trabalhando ao mesmo tempo. */
  readonly parallel: boolean;
}

export interface RosterContext {
  /** `displayStates`: estado de apresentação por pane. */
  readonly states: ReadonlyMap<string, PaneSessionState>;
  /** Panes estacionados pelo guardian: sessão encerrada de propósito. */
  readonly parked?: { has(paneId: string): boolean };
  /** Rótulo do adapter quando a CLI não tem família conhecida. */
  readonly adapterLabel?: (adapterId: string) => string | undefined;
}

const KIND_LABEL: Record<RosterAgentKind, string> = {
  working: 'Trabalhando',
  starting: 'Iniciando',
  waiting: 'Aguardando',
  sleeping: 'Dormindo',
  stopped: 'Encerrado',
  unknown: 'Estado desconhecido',
};

/** Pane de agente que o renderer ainda não viu subir (ou já esqueceu). */
export const ROSTER_NO_SESSION_LABEL = 'Sem sessão';

export function resolveRosterState(
  state: PaneSessionState | undefined,
  parked: boolean,
  /** Pane ACP: a sessão não passa pelo PTY, então não tem estado de sessão. */
  acp = false,
): { readonly kind: RosterAgentKind; readonly label: string } {
  // Estacionado é veredito do Main sobre um pane sem sessão: vale mais que o
  // 'exited' local, como no chip da toolbar.
  if (parked) return { kind: 'sleeping', label: KIND_LABEL.sleeping };
  switch (state) {
    case 'busy':
      return { kind: 'working', label: KIND_LABEL.working };
    case 'spawning':
      return { kind: 'starting', label: KIND_LABEL.starting };
    case 'idle':
      return { kind: 'waiting', label: KIND_LABEL.waiting };
    case 'hibernated':
      return { kind: 'sleeping', label: KIND_LABEL.sleeping };
    case 'exited':
      return { kind: 'stopped', label: KIND_LABEL.stopped };
    default:
      // Sem leitura de estado não se afirma que o agente morreu: o pane acabou
      // de nascer (o host ainda não publicou "spawning") ou é ACP, cujo feed
      // não escreve em `session-state-store`. Fica neutro — nem "parado", nem
      // contado como trabalho.
      return {
        kind: 'unknown',
        label: acp ? KIND_LABEL.unknown : ROSTER_NO_SESSION_LABEL,
      };
  }
}

/** Controle, zero-width e sobreposição bidi: o título vem do terminal. */
const UNSAFE_TITLE_CHARS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff]',
  'g',
);

/** Títulos que nomeiam a ferramenta ou o shell, nunca a tarefa. */
const GENERIC_TITLES: ReadonlySet<string> = new Set([
  'shell',
  'browser',
  'terminal',
  'agent',
  'agente',
  'claude',
  'claude code',
  'codex',
  'openai codex',
  'gpt',
  'grok',
  'kimi',
  'qwen',
  'glm',
  'gemini',
  'aider',
  'muse',
  'agy',
  'antigravity',
  'cursor',
  'opencode',
  'deepseek',
  'minimax',
  'longcat',
  'devin',
  'mimo',
  'zsh',
  'bash',
  'sh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'node',
]);

const MAX_TASK_CHARS = 140;

function cwdBasename(cwd: string | undefined): string | null {
  const parts = (cwd ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/**
 * O título OSC de uma CLI costuma ser a PASTA onde ela roda (o Codex escreve o
 * nome da worktree: `t-7bcf00cf9aa6faa9c4b738fc`), um caminho ou um id — nada
 * disso diz o que o agente faz. Palavra solta com separador (`nexus-ide`,
 * `pane-mv8pulmq-v`), hash e caminho são rejeitados; frase, não.
 */
function looksTechnical(text: string, cwd: string | undefined): boolean {
  if (/^(?:[a-z]:[\\/]|[\\/]|~)/i.test(text)) return true;
  if (/^(?:pane|agente?|agent)\s*#?\d*$/i.test(text)) return true;
  if (text.toLowerCase() === cwdBasename(cwd)?.toLowerCase()) return true;
  if (/\s/.test(text)) return false;
  return /[-_.:/\\]/.test(text) || /^[0-9a-f]{6,}$/i.test(text);
}

/**
 * Tarefa curta e legível de um pane de agente, ou `null`.
 *
 * `pane.title` chega como "Família · texto" (`cliPaneDisplayTitle`): a família
 * já aparece na linha da CLI, então sai daqui. Sem texto legível o rail mostra
 * só quem é e qual CLI — vazio honesto vence um id técnico no lugar da tarefa.
 */
export function readableAgentTask(pane: PaneModel): string | null {
  const normalized = normalizePaneTitle(pane.title).title;
  let text = normalized.replace(UNSAFE_TITLE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const family = pane.adapterId ? familyFromAdapterId(pane.adapterId) : null;
  if (family && text.toLowerCase().startsWith(family.toLowerCase())) {
    // "Família · texto" é o que a toolbar compõe; só sai o prefixo seguido do
    // separador — "GPT-5.6 review" continua inteiro.
    const rest = text.slice(family.length);
    if (/^\s*·/.test(rest)) text = rest.replace(/^\s*·\s*/, '');
  }
  if (!text) return null;
  const lower = text.toLowerCase();
  if (GENERIC_TITLES.has(lower)) return null;
  if (lower === pane.adapterId?.toLowerCase()) return null;
  if (lower === family?.toLowerCase()) return null;
  if (lower === pane.agentName?.trim().toLowerCase()) return null;
  // Nome que o operador deu ao pane (duplo clique) é escolha humana, não eco do
  // terminal: "api-server" é o que ele quer ver, mesmo parecendo um id.
  if (!pane.titlePinned && looksTechnical(text, pane.cwd)) return null;
  return text.length > MAX_TASK_CHARS
    ? `${text.slice(0, MAX_TASK_CHARS - 1).trimEnd()}…`
    : text;
}

function agentName(pane: PaneModel): string {
  const squadName = pane.agentName?.trim();
  if (squadName) return squadName;
  if (pane.role === 'orchestrator') return 'Orquestrador';
  if (pane.paneNumber !== undefined) return `Pane ${pane.paneNumber}`;
  return 'Agente';
}

function cliIdentity(
  pane: PaneModel,
  adapterLabel: RosterContext['adapterLabel'],
): { readonly cli: string; readonly detail: string } {
  const chip = resolveModelChipLabel(pane.adapterId, pane.model, pane.effort);
  if (chip) {
    // O modelo pode vir como apelido da CLI ("sonnet"): inicial maiúscula, como
    // o parser faz com o id completo.
    const version = chip.version.replace(/^[a-z]/, (letter) => letter.toUpperCase());
    return {
      cli: version ? `${chip.family} ${version}` : chip.family,
      detail: chip.full,
    };
  }
  // Família desconhecida: o rótulo do adapter (ou o id) e, se houver, o modelo
  // cru — melhor um id feio do que esconder qual CLI está trabalhando.
  const base =
    (pane.adapterId ? adapterLabel?.(pane.adapterId) : undefined) ??
    pane.adapterId ??
    'Agente';
  const label = pane.model ? `${base} · ${pane.model}` : base;
  return { cli: label, detail: label };
}

export function describeRosterAgent(
  pane: PaneModel,
  context: RosterContext,
): RosterAgent {
  const { kind, label } = resolveRosterState(
    context.states.get(pane.id),
    context.parked?.has(pane.id) ?? false,
    pane.agentTransport === 'acp',
  );
  const identity = cliIdentity(pane, context.adapterLabel);
  return {
    paneId: pane.id,
    kind,
    working: kind === 'working',
    stateLabel: label,
    name: agentName(pane),
    cli: identity.cli,
    cliDetail: identity.detail,
    task: readableAgentTask(pane),
    orchestrator: pane.role === 'orchestrator',
    paneNumber: pane.paneNumber ?? null,
    adapterId: pane.adapterId,
  };
}

const EMPTY_FLEET: RosterFleet = {
  agents: [],
  workingCount: 0,
  parallel: false,
};

export function emptyRosterFleet(): RosterFleet {
  return EMPTY_FLEET;
}

function toFleet(agents: readonly RosterAgent[]): RosterFleet {
  if (agents.length === 0) return EMPTY_FLEET;
  // Orquestrador no topo; o resto na ordem do layout. A ordem não depende do
  // estado: linha que muda de lugar a cada busy↔idle é clique no alvo errado.
  const ordered = [
    ...agents.filter((agent) => agent.orchestrator),
    ...agents.filter((agent) => !agent.orchestrator),
  ];
  const workingCount = ordered.filter((agent) => agent.working).length;
  return { agents: ordered, workingCount, parallel: workingCount >= 2 };
}

export interface RosterFleets {
  /** Todos os agentes do layout: a contagem do workspace aberto. */
  readonly all: RosterFleet;
  /** Agentes fora de missão (terminais do operador). */
  readonly loose: RosterFleet;
  readonly byMission: ReadonlyMap<string, RosterFleet>;
}

/**
 * Agrupa os agentes (`cli-agent`) do layout por missão, na mesma regra que o
 * rail sempre usou para atribuir pane a missão. Shell e browser não são
 * agentes: não entram na contagem nem na lista.
 */
export function groupRosterFleets(
  panes: readonly PaneModel[],
  paneMissions: Readonly<Record<string, string>>,
  context: RosterContext,
): RosterFleets {
  const all: RosterAgent[] = [];
  const loose: RosterAgent[] = [];
  const missions = new Map<string, RosterAgent[]>();
  for (const pane of panes) {
    if (pane.kind !== 'cli-agent') continue;
    const agent = describeRosterAgent(pane, context);
    all.push(agent);
    const missionId = pane.missionId ?? paneMissions[pane.id];
    if (!missionId) {
      loose.push(agent);
      continue;
    }
    const bucket = missions.get(missionId);
    if (bucket) bucket.push(agent);
    else missions.set(missionId, [agent]);
  }
  return {
    all: toFleet(all),
    loose: toFleet(loose),
    byMission: new Map(
      [...missions].map(([missionId, agents]) => [missionId, toFleet(agents)]),
    ),
  };
}

/**
 * Ids dos agentes trabalhando agora, pela MESMA regra do rail (`resolveRosterState`).
 * As abas e o cabeçalho da missão usam isto no lugar de refazer a conta: a
 * contagem do rail e a da aba nunca divergem.
 */
export function workingPaneIdsOf(
  panes: readonly PaneModel[],
  context: Pick<RosterContext, 'states' | 'parked'>,
): ReadonlySet<string> {
  const working = new Set<string>();
  for (const pane of panes) {
    if (pane.kind !== 'cli-agent') continue;
    const { kind } = resolveRosterState(
      context.states.get(pane.id),
      context.parked?.has(pane.id) ?? false,
      pane.agentTransport === 'acp',
    );
    if (kind === 'working') working.add(pane.id);
  }
  return working;
}

/**
 * Assinatura textual de `workingPaneIdsOf`: igual enquanto o CONJUNTO de quem
 * trabalha não muda. Serve de seletor de store — o componente só re-renderiza
 * quando a assinatura muda, não a cada busy↔idle de qualquer pane.
 */
export function workingSignature(
  panes: readonly PaneModel[],
  context: Pick<RosterContext, 'states' | 'parked'>,
): string {
  return [...workingPaneIdsOf(panes, context)].join('\n');
}

/** "3 trabalhando agora" — a mesma frase no rail, nas abas e no cabeçalho. */
export function workingNowLabel(count: number): string {
  return `${count} trabalhando agora`;
}

export function agentCountLabel(total: number): string {
  return `${total} ${total === 1 ? 'agente' : 'agentes'}`;
}

/**
 * Resumo de uma frota sem ninguém trabalhando: diz POR QUE está quieta, em vez
 * de um "0 trabalhando" que não distingue prompt à espera de processo morto.
 */
export function idleFleetLabel(fleet: RosterFleet): string {
  if (fleet.agents.length === 0) return '';
  if (fleet.agents.every((agent) => agent.kind === 'waiting')) return 'aguardando';
  if (
    fleet.agents.every(
      (agent) => agent.kind === 'sleeping' || agent.kind === 'stopped',
    )
  ) {
    return 'parados';
  }
  return 'nenhum trabalhando';
}
