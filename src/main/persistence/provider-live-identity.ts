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

export function forgetLiveIdentity(): void {
  liveIdentity.clear();
}
