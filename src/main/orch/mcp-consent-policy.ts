import {
  isDestructive,
  paneInputTexts,
  requiresConfirmation,
} from '../jarvis/guardrails';
import { canonicalToolName } from './gate';
import type { McpDispatchSource } from './mcp-dispatch-contract';

export const RENDERER_EXACT_CONSENT_TOOLS: ReadonlySet<string> = new Set([
  'catalog_install',
  'agent_spec_write',
  'squad_save',
]);

/**
 * Vazio: os três antigos ocupantes são negados antes de chegar aqui, e o `cron`
 * ganhou caminho de volta. Ver `requiresPerActionConsent`.
 */
const PER_ACTION_CONSENT_TOOLS: ReadonlySet<string> = new Set<string>([]);

/**
 * Ferramentas cujo STORE exige um recibo exato de uma mutação só.
 *
 * Distinto de `requiresPerActionConsent` de propósito — o predicado antigo
 * fazia as duas coisas, e por isso "tirar o modal" apagava junto o recibo e
 * quebrava toda gravação de agenda com `cron_exact_consent_required`.
 *
 * Modal e recibo respondem perguntas diferentes: o modal pergunta QUEM
 * autorizou; o recibo prova que ESTA mutação foi autorizada uma vez só. Sob a
 * doutrina de zero fricção quem autoriza é a aprovação da missão somada ao
 * caminho de volta registrado — a prova de unicidade continua necessária.
 */
const EXACT_RECEIPT_TOOLS: ReadonlySet<string> = new Set(['cron']);

export function requiresExactConsentReceipt(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (canonical === 'cron') return args.action !== 'list';
  return EXACT_RECEIPT_TOOLS.has(canonical);
}

/**
 * Origens que são a Jarvis por voz: o renderer do operador (`ipc-renderer`) e o
 * executor de voz. Só elas ganham a política mãos-livres; agentes CLI
 * (http-mcp, acp, pty-stream, mission-shim) seguem na política por efeito.
 */
export function isJarvisVoiceDispatch(source: McpDispatchSource | undefined): boolean {
  return source === 'ipc-renderer' || source === 'jarvis-voice';
}

export function requiresToolConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  source?: McpDispatchSource,
): boolean {
  return requiresConfirmation(toolName, args, {
    handsFree: isJarvisVoiceDispatch(source),
  });
}

/** Destructive local shell effects always keep their per-action consent floor. */
export function isDestructiveEffect(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const canonical = canonicalToolName(toolName);
  if (canonical !== 'terminal_run' && canonical !== 'bg_run') return false;
  const command = typeof args.command === 'string' ? args.command : '';
  return command.length > 0 && isDestructive(command);
}

/**
 * Texto que a mão do operador mandaria para um PTY e que carrega comando
 * destrutivo.
 *
 * O modal do pane sem missão cai por padrão (a sessão `user` já abre e fala
 * com panes pela UI), mas um `rm -rf` injetado por prompt não ganha passe
 * livre: pane_write/ask/many com texto destrutivo continua pedindo
 * confirmação — é o "destrutivo sem caminho de volta" da decisão de 09/09.
 * A âncora de `isDestructive` (início ou após `;`/`&`/`|`) evita o falso
 * positivo de uma pergunta que só cita o comando.
 */
export function isDestructivePaneInput(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return paneInputTexts(toolName, args).some((text) => isDestructive(text));
}

/**
 * Consentimento por ação — hoje, VAZIO no caminho da missão, de propósito.
 *
 * Ele existia para duas famílias, e nenhuma delas ainda precisa dele:
 *
 *  - `catalog_install`, `agent_spec_write`, `squad_save`: nunca chegaram aqui.
 *    São NEGADOS antes, em `mcp-dispatch.ts` (RENDERER_EXACT_CONSENT_TOOLS), e
 *    exigem a superfície nativa. Listá-los aqui sugeria uma pergunta que o
 *    código não faz.
 *  - `cron`: a mudança de agenda sobrevive à missão que a criou — risco real.
 *    A resposta passou a ser desfazer + registro visível
 *    (`cron-reversibility.ts`), não interromper uma missão já aprovada.
 *
 * A lista permanece como ponto de extensão: uma mutação nova que sobreviva à
 * missão e AINDA não tenha caminho de volta entra aqui até ganhar um.
 */
export function requiresPerActionConsent(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  void args;
  return PER_ACTION_CONSENT_TOOLS.has(canonicalToolName(toolName));
}
