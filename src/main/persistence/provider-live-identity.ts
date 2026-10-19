/**
 * Qual conta detém a sessão VIVA de cada CLI.
 *
 * Não é a coluna "ativa" do store: `activeByAdapter` só é escrita por
 * cadastro de conta e pela ação do operador na UI (`account-ipc.ts`), nunca
 * pela rotação. Usá-la como identidade viva fazia o carrossel andar um único
 * salto — a leitura nativa continuava sendo lançada na conta que já tinha
 * drenado, e a frota travava com o pane parado em silêncio.
 *
 * Quem sela a identidade é o SPAWN: ele escolhe a conta, grava a credencial
 * (no Windows, a vaga `gemini:antigravity`) e abre o processo. É esse momento
 * que é anotado aqui.
 *
 * Memória de processo: reiniciar o app a esquece, e o primeiro spawn a
 * reconstrói. Sem ela, a atribuição simplesmente não acontece — a frota volta
 * a parecer sem medição, que é o comportamento anterior, não um erro novo.
 */

const liveIdentity = new Map<string, string>();

/** O spawn selou `accountId` como a sessão viva de `adapterId`. */
export function noteLiveIdentity(adapterId: string, accountId: string): void {
  liveIdentity.set(adapterId, accountId);
}

export function liveIdentityAccountId(adapterId: string): string | null {
  return liveIdentity.get(adapterId) ?? null;
}

/**
 * CLIs em que UMA sessão do sistema serve todos os panes — logo, a conta do
 * último spawn É a conta em uso. Só o AGY: a vaga `gemini:antigravity` é
 * única por máquina (F-677).
 *
 * Claude, Codex e as demais isolam conta por perfil/HOME, então vários panes
 * rodam em contas diferentes ao mesmo tempo e "o último spawn" não diz qual
 * conta está em uso. Usar a identidade selada como âncora de seleção nelas
 * faria um pane FIXADO em B desviar os spawns seguintes, sem pin, para B.
 */
const SINGLE_SLOT_IDENTITY_ADAPTERS = new Set(['agy']);

/**
 * A âncora de "conta em uso" para a seleção, ou `null` quando a coluna do
 * store continua sendo a autoridade.
 */
export function liveIdentityAnchor(adapterId: string): string | null {
  if (!SINGLE_SLOT_IDENTITY_ADAPTERS.has(adapterId)) return null;
  return liveIdentityAccountId(adapterId);
}

export function forgetLiveIdentity(): void {
  liveIdentity.clear();
}
