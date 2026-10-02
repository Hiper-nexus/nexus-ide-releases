/**
 * Canais IPC do recibo da escolha de conta. Sem dependências (nem zod, nem
 * node): o preload sandboxed e o Main importam este arquivo.
 */

export const ACCOUNT_CHOICE_CHANNELS = {
  /**
   * invoke: renderer → main. Devolve o recibo (já mascarado e saneado) da
   * sessão PTY pedida, ou `null` quando não há recibo. Somente leitura.
   */
  get: 'accountChoice:get',
} as const;
