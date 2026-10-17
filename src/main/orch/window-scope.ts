/**
 * Escopo de uma janela de cota pelo rótulo. Puro (sem electron): o cooldown
 * confirmado (F-1484) e o ritmo de cota leem a mesma regra, e o ritmo é
 * importado pelo roteador, que não pode puxar o quota-service nem o store.
 */
import { anthropicTierScope } from './limit-detector';

/**
 * Janela por modelo ("Semanal (Opus)") vira bloco escopado do tier; janela
 * geral da conta (sessão, 5 h, semanal) devolve undefined; modelo sem tier
 * conhecido devolve null (não autoriza bloco nenhum).
 */
export function windowScope(label: string): string | null | undefined {
  const model = /\(([^)]+)\)\s*$/u.exec(label)?.[1];
  if (!model) return undefined;
  return anthropicTierScope(model) ?? null;
}
