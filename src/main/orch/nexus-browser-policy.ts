import { isToolAllowedForRole, type GateRole } from './gate';
import { isToolAllowedForReadOnlyContext } from './mcp-effect-policy';

/**
 * F-781: a regra "páginas → nexus_browser_*" não tinha trava. Na auditoria de
 * 03/10 (06-uso-real.md, lacuna L2) foram 43 WebFetch e 96 curl contra 64
 * nexus_browser_*. Nos panes Claude-family que o Nexus monta, o WebFetch é
 * negado por um hook PreToolUse com a mensagem abaixo (hooks-gen.ts); nas
 * outras CLIs a regra vai no brief do worker (worker-handoff-contract.ts).
 *
 * Fallback seguro: só onde o navegador do Nexus está de fato ao alcance do
 * pane. Sem ele, negar o WebFetch deixaria o agente sem ler página nenhuma.
 */

/** Abrir, navegar e ler: o mínimo para substituir o WebFetch numa página. */
export const NEXUS_BROWSER_PAGE_TOOLS = [
  'nexus_browser_open',
  'nexus_browser_navigate',
  'nexus_browser_read',
] as const;

/**
 * F-797: tools de página que o worker de missão aberto pelo orquestrador
 * recebe por padrão (antes nascia com `[]` e o navegador do Nexus nunca o
 * alcançava — os 30 workers da missão Terminais). Só leitura e extração:
 * nada de clicar, preencher, digitar ou executar. Expor não abre aba: a aba
 * só nasce quando o worker chama nexus_browser_open (pane-registry).
 */
export const NEXUS_BROWSER_WORKER_TOOLS = [
  ...NEXUS_BROWSER_PAGE_TOOLS,
  'nexus_browser_find',
  'nexus_browser_extract',
  'nexus_browser_inspect',
  'nexus_browser_wait',
  'nexus_browser_screenshot',
] as const;

/**
 * Allowlist padrão de um spawn sem roster e sem `allowedTools` explícita.
 * Só o worker de missão gravável ganha as tools de página: o pane somente
 * leitura (analista) não pode abrir aba (efeito de missão) e o filho do
 * operador em modo governado não é worker de missão — os dois seguem com `[]`.
 */
export function defaultMissionWorkerTools(subject: {
  readonly missionWorker: boolean;
  readonly readOnly: boolean;
}): string[] {
  return subject.missionWorker && !subject.readOnly
    ? [...NEXUS_BROWSER_WORKER_TOOLS]
    : [];
}

/**
 * Anexado ao erro de nexus_browser_open quando a aba não pôde nascer (sem
 * janela do Nexus, projeto fora da tela, pane sem renderer, tempo esgotado):
 * o agente segue com curl e declara a falha, em vez de parar.
 */
export const NEXUS_BROWSER_UNAVAILABLE_HINT =
  'O navegador do Nexus não está disponível para este pane agora (sem janela ' +
  'do Nexus para esta aba, projeto fora da tela ou pane sem renderer). Siga ' +
  'sem ele: leia a página com curl -sL <url> (ou wget -qO- <url>) e registre ' +
  'no handoff que o navegador do Nexus não abriu.';

export function browserUnavailableError(reason: string): string {
  return `${reason} — ${NEXUS_BROWSER_UNAVAILABLE_HINT}`;
}

export interface NexusBrowserSubject {
  /** Papel do token do pane (spawn sem papel nasce `user`). */
  readonly role: GateRole;
  readonly missionId?: string;
  readonly readOnly?: boolean;
  readonly allowedTools: string[] | null;
  /** Helper aberto por um pane do operador: token `user` com pane pai. */
  readonly operatorChild?: boolean;
}

/**
 * O pane alcança o navegador do Nexus? Mesmos portões do `tools/list` e do
 * dispatch (mcp-protocol.ts, mcp-dispatch.ts): allowlist por papel, fronteira
 * de somente leitura e efeito que exige missão.
 */
export function hasNexusBrowserAlternative(subject: NexusBrowserSubject): boolean {
  // A mão do operador (pane "+" sem pai) é o modo vibe: o Nexus não tira
  // ferramenta nativa dela; ali vale a doutrina (regra 11) e a dica do Jev.
  if (subject.role === 'user' && subject.operatorChild !== true) return false;
  // Abrir e navegar são efeitos de missão: sem missão o dispatch recusa
  // ("mission effect blocked"); o filho do operador passa pelo modo vibe.
  if (subject.role !== 'user' && !subject.missionId) return false;
  return NEXUS_BROWSER_PAGE_TOOLS.every(
    (tool) =>
      isToolAllowedForRole(subject.role, subject.allowedTools, tool) &&
      (subject.readOnly !== true || isToolAllowedForReadOnlyContext(tool)),
  );
}

/**
 * O que o agente lê quando o WebFetch é negado (stderr do hook, exit 2).
 * Sem aspas simples: vai dentro de uma string de shell entre aspas simples.
 */
export const WEB_FETCH_DENY_MESSAGE =
  '[Nexus] WebFetch está desligado neste pane: página web passa pelo ' +
  'navegador do Nexus (renderiza JavaScript e mantém a sessão da aba). Faça ' +
  'nexus_browser_open({url}) e depois nexus_browser_read({paneId, format: ' +
  '"compact", focus: "<o que você procura>"}); para outra URL na mesma aba, ' +
  'nexus_browser_navigate({paneId, url, read: true}). Use curl -sL só para ' +
  'JSON de API, arquivo cru (.md, .txt, .json, .pdf) ou o fim de uma página ' +
  'longa (o read lê até 20.000 caracteres e marca truncated: true). ' +
  'WebSearch continua liberado. Se o navegador do Nexus falhar (sem janela ' +
  'ou com outro projeto na tela), use curl e registre a falha no handoff.';

/** Linha do brief do worker: a mesma regra para toda CLI com o MCP do Nexus. */
export const NEXUS_BROWSER_BRIEF_RULE =
  'Página web (documentação, artigo, site): use o navegador do Nexus — ' +
  'nexus_browser_open({url}) e nexus_browser_read({paneId, format: ' +
  '"compact", focus}); outra URL na mesma aba: nexus_browser_navigate({paneId, ' +
  'url, read: true}). Não use WebFetch nem o fetch de página nativo da sua ' +
  'CLI. curl só para JSON de API, arquivo cru ou o fim de uma página longa ' +
  'demais para o read (truncated: true). A busca na web nativa continua valendo.';
