/**
 * Canais IPC do reporte de problema. Sem dependências (nem zod, nem node):
 * o preload sandboxed e o Main importam este arquivo.
 */

export const BUG_REPORT_CHANNELS = {
  /** invoke: renderer → main. Monta e devolve o corpo exato (já redigido), sem enviar. */
  preview: 'bugReport:preview',
  /** invoke: renderer → main. Monta, redige e envia ao servidor com a sessão do Main. */
  submit: 'bugReport:submit',
  /** event: main → renderer. Menu "Ajuda → Reportar um problema…" pediu o diálogo. */
  open: 'bugReport:open',
} as const;
