import type { GateRole } from './gate';

/**
 * F-781: a regra "páginas → nexus_browser_*". Na auditoria de 03/10
 * (06-uso-real.md, lacuna L2) foram 43 WebFetch e 96 curl contra 64
 * nexus_browser_*. F-1157 (doutrina do dono): nada é negado — o navegador do
 * Nexus vai no brief do worker como a recomendação para página web, e o
 * WebFetch, o fetch nativo e o curl seguem liberados.
 */

/** Abrir, navegar e ler: o mínimo para ler uma página pelo navegador do Nexus. */
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
 * O pane alcança o navegador do Nexus? Desde o F-1157 só o vínculo de missão
 * decide (abrir e navegar são efeitos de missão no dispatch).
 */
export function hasNexusBrowserAlternative(subject: NexusBrowserSubject): boolean {
  // A mão do operador (pane "+" sem pai) é o modo vibe: o Nexus não tira
  // ferramenta nativa dela; ali vale a doutrina (regra 11) e a dica do Jev.
  if (subject.role === 'user' && subject.operatorChild !== true) return false;
  // Abrir e navegar são efeitos de missão: sem missão o dispatch recusa
  // ("mission effect blocked"); o filho do operador passa pelo modo vibe.
  if (subject.role !== 'user' && !subject.missionId) return false;
  // F-1157: toda tool do Nexus está ao alcance de todo agente.
  return true;
}

/** Linha do brief do worker: a mesma regra para toda CLI com o MCP do Nexus. */
export const NEXUS_BROWSER_BRIEF_RULE =
  'Página web (documentação, artigo, site): use o navegador do Nexus — ' +
  'nexus_browser_open({url}) e nexus_browser_read({paneId, format: ' +
  '"compact", focus, judge: true}); outra URL na mesma aba: nexus_browser_navigate({paneId, ' +
  'url, read: true}). Para objetivos de múltiplos passos na página (clicar, preencher, ' +
  'rolar em velocidade de máquina), delegue ao autopilot Jev com ' +
  'nexus_browser_do({paneId, goal, values}); para extrair campos tipados em uma chamada, ' +
  'use nexus_browser_extract({paneId, fields}); para conferência visual da tela renderizada ' +
  '(erro visível, bloqueio, layout quebrado, objetivo cumprido), use ' +
  'nexus_browser_judge_visual({paneId, goal}). Ele renderiza JavaScript e mantém a sessão da aba. ' +
  'Para ver o app do PROJETO, gere o build e sirva com nexus_preview_start({dir}); abra a URL ' +
  'que ele devolve e confira com nexus_browser_responsive — localhost de servidor de dev e ' +
  'file:// são recusados por segurança. ' +
  'WebFetch, o fetch nativo da sua CLI e curl também estão liberados (curl ' +
  'serve bem para JSON de API, arquivo cru ou o fim de uma página longa demais ' +
  'para o read, truncated: true). A busca na web nativa continua valendo.';
