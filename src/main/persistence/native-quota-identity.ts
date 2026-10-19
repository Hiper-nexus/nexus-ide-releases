/**
 * Para QUAL conta a leitura da linha nativa do snapshot pode ser atribuída.
 *
 * Só o AGY tem esse problema: `quota-service` emite uma linha nativa separada
 * para ele porque "o endpoint direto pode recusar contas de consumidor
 * salvas" — e para conta pessoal ele SEMPRE recusa (403, `agy-bridge.ts`).
 * Então a linha nativa é a única leitura que existe, e sem atribuí-la nenhuma
 * conta AGY tem folga medida.
 *
 * Nas outras CLIs a sonda por conta funciona e atribuir seria enxertar a
 * medição de uma identidade noutra — as invariantes de `quota-service.ts` e
 * `provider-live-usage.ts` proíbem isso, e com razão: a leitura emprestada
 * alimentaria os caminhos de prova do F-249/F-1489.
 *
 * A identidade é a que o SPAWN selou, não a coluna "ativa" do store (que só a
 * UI move). No Windows a vaga do keyring é a verdade física e vence.
 */
import { agyKeyringSlotAccount } from './account-store';
import { liveIdentityAccountId } from './provider-live-identity';

/** Adapters cuja única leitura possível é a da identidade logada. */
const NATIVE_ONLY_QUOTA_ADAPTERS = new Set(['agy']);

export function nativeQuotaIdentity(
  adapterId: string,
): { attributeNativeTo?: string } {
  if (!NATIVE_ONLY_QUOTA_ADAPTERS.has(adapterId)) return {};
  // A identidade selada pelo spawn vem PRIMEIRO, e não é só preferência de
  // estilo: `agyKeyringSlotAccount` lê a vaga por PowerShell SÍNCRONO (cache
  // de 15 s), e este caminho roda a cada spawn e em pontos do failover —
  // consultá-lo primeiro travaria a thread principal do Windows de 15 em 15
  // segundos. O spawn grava a vaga a partir da conta que escolheu, então o
  // selado e a vaga concordam; o keyring é só o arranque, antes do 1º spawn.
  const sealed = liveIdentityAccountId(adapterId);
  if (sealed) return { attributeNativeTo: sealed };
  if (adapterId === 'agy' && process.platform === 'win32') {
    const slot = agyKeyringSlotAccount();
    if (slot) return { attributeNativeTo: slot.id };
  }
  return {};
}
