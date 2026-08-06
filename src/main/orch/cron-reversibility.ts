/**
 * Reversibilidade das mudanças de agenda (segunda metade da N1).
 *
 * O piso de consentimento por mutação existia porque uma agenda sobrevive à
 * missão que a criou: o cron continua disparando semanas depois, e o dono não
 * ligou aquilo. Isso é um risco real — mas a resposta certa não é interromper
 * quem já aprovou a missão, e sim garantir que a mudança seja DESFAZÍVEL e
 * VISÍVEL. A pergunta protegia por acidente; o registro protege de propósito.
 *
 * Módulo puro: monta a frase de desfazer a partir do estado ANTERIOR. Não lê
 * store, não escreve nada. Quem captura o anterior é o handler, antes de mutar.
 */

export interface CronJobSnapshot {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly status?: string;
}

export type CronChange =
  | { readonly action: 'create'; readonly created: CronJobSnapshot }
  | {
      readonly action: 'update';
      readonly before: CronJobSnapshot;
      readonly after: CronJobSnapshot;
    }
  | { readonly action: 'delete'; readonly before: CronJobSnapshot };

/**
 * A frase que o operador lê no card da missão. Sempre carrega o id: sem ele a
 * mensagem seria simpática e inútil — "uma agenda mudou" não é desfazível.
 */
export function describeCronReversal(change: CronChange): string {
  switch (change.action) {
    case 'create':
      return (
        `Agenda criada: "${change.created.name}" (${change.created.schedule}). ` +
        `Ela dispara depois desta missão. Desfazer: nexus_cron delete id=${change.created.id}`
      );
    case 'update': {
      // O que mudou importa mais que o que ficou igual: o operador está
      // varrendo o card, não lendo um diff.
      const parts: string[] = [];
      if (change.before.name !== change.after.name) {
        parts.push(`nome "${change.before.name}"`);
      }
      if (change.before.schedule !== change.after.schedule) {
        parts.push(`horário "${change.before.schedule}"`);
      }
      if (change.before.status !== change.after.status) {
        parts.push(`status "${change.before.status ?? 'active'}"`);
      }
      const restore = parts.length > 0 ? parts.join(', ') : 'os campos anteriores';
      return (
        `Agenda alterada: "${change.after.name}" (${change.after.schedule}). ` +
        `Desfazer: nexus_cron update id=${change.before.id} restaurando ${restore}`
      );
    }
    case 'delete':
      return (
        `Agenda removida: "${change.before.name}" (${change.before.schedule}). ` +
        `Desfazer: nexus_cron create name="${change.before.name}" schedule="${change.before.schedule}"`
      );
  }
}
