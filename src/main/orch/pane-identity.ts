/**
 * Identidade de pane na sessão MCP (paridade Overclock OVKA-529/543).
 *
 * Dois defeitos medidos no Overclock em 2026-09-18, no mesmo caminho:
 *  1. o descritor `--dev`/conector herdado desviava o pane para OUTRA
 *     instância (o app de dev que reinicia) — a "casa" do pane deve vencer;
 *  2. o wrapper abria sessão anônima (`/mcp/orchestrator` sem `callerPaneId`)
 *     e o gate lia "bootstrap do humano", liberando orçamento ilimitado a um
 *     worker proibido de abrir filhos.
 *
 * Regras (especificação executável em pane-identity.test.ts):
 *  - `NEXUS_PANE_ARMS_DESCRIPTOR` é a MEMÓRIA da casa (publicada no spawn);
 *  - `isPaneHome` exige id do pane + casa + destino não desviado;
 *  - só em casa a sessão carrega `callerPaneId` (mesmo orçamento/papel/recusa);
 *  - `--descriptor` para OUTRA instância apaga a identidade (orquestrador
 *    externo operando o app vizinho — escolha explícita);
 *  - `--dev` não desvia dentro de um pane.
 *
 * Privacidade: o callerPaneId é o id opaco do pane; nunca token, nunca email.
 */

export interface PaneIdentityEnv {
  readonly NEXUS_PANE_ID?: string | undefined;
  readonly NEXUS_ARMS_DESCRIPTOR?: string | undefined;
  readonly NEXUS_PANE_ARMS_DESCRIPTOR?: string | undefined;
  readonly [key: string]: string | undefined;
}

/** A casa deste pane, quando o processo nasceu dentro de um. */
export function paneHomeDescriptor(
  env: PaneIdentityEnv = process.env as PaneIdentityEnv,
): string | null {
  const raw = env.NEXUS_PANE_ARMS_DESCRIPTOR?.trim();
  return raw ? raw : null;
}

/**
 * Esta sessão é um pane do Nexus agindo no PRÓPRIO app?
 * Exige as três: id do pane, memória da casa, e destino que não foi desviado.
 */
export function isPaneHome(
  env: PaneIdentityEnv = process.env as PaneIdentityEnv,
): boolean {
  if (!env.NEXUS_PANE_ID?.trim()) return false;
  const home = paneHomeDescriptor(env);
  if (!home) return false;
  const target = env.NEXUS_ARMS_DESCRIPTOR?.trim();
  return !target || target === home;
}

/**
 * Id do pane que esta sessão representa — só quando o wrapper nasceu dentro de
 * um pane E fala com a CASA dele. Destino desviado não carrega identidade.
 */
export function callerPaneIdOf(
  env: PaneIdentityEnv = process.env as PaneIdentityEnv,
): string | null {
  if (!isPaneHome(env)) return null;
  const id = env.NEXUS_PANE_ID?.trim();
  return id ? id : null;
}

/**
 * Resolve o descritor alvo respeitando a casa do pane (OVKA-529):
 * `--descriptor` explícito vence; depois a casa do pane; depois env/default.
 */
export function resolveDescriptorTarget(
  argv: readonly string[],
  env: PaneIdentityEnv,
  defaultPath: string,
): string {
  const at = argv.indexOf('--descriptor');
  const pinned =
    at >= 0 && typeof argv[at + 1] === 'string' && !argv[at + 1].startsWith('--')
      ? argv[at + 1].trim()
      : '';
  if (pinned) return pinned;
  const home = paneHomeDescriptor(env);
  if (home && isPaneHome(env)) return home;
  const envTarget = env.NEXUS_ARMS_DESCRIPTOR?.trim();
  return envTarget || defaultPath;
}

/**
 * URL da sessão MCP: com `callerPaneId` quando o pane está em casa; anônima
 * (conector externo) quando não está. Preserva query já existente.
 */
export function sessionUrl(
  baseUrl: string,
  env: PaneIdentityEnv = process.env as PaneIdentityEnv,
): string {
  const paneId = callerPaneIdOf(env);
  if (!paneId) return baseUrl;
  const url = new URL(baseUrl);
  if (!url.searchParams.has('callerPaneId')) {
    url.searchParams.set('callerPaneId', paneId);
  }
  return url.toString();
}

/**
 * Mensagem de recusa de transporte do pane (OVKA-543): explica o handshake
 * sem ecoar corpo não-confiável e sem culpar o chamador por restrição que não
 * é dele. `untrustedBody` NUNCA entra na mensagem.
 */
export function paneTransportRefusalMessage(
  status: number,
  method: string,
  opts: { isPane: boolean; untrustedBody?: string | undefined },
): string {
  void opts.untrustedBody; // deliberadamente ignorado — ver doc do módulo
  if (opts.isPane && status === 406 && method === 'initialize') {
    return (
      'Nexus recusou o initialize deste pane com HTTP 406: o transporte JSON ' +
      'deste wrapper não casa com a conexão nexus esperada pelo app. ' +
      'Não altere a identidade do pane nem repita o initialize — fale pela ' +
      'conexão nexus do app (mesmo orçamento e mesmas recusas desta sessão).'
    );
  }
  return `Nexus respondeu HTTP ${status} para ${method}.`;
}
