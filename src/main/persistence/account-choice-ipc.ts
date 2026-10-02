import { z } from 'zod';
import {
  parseAccountChoiceReceipt,
  type AccountChoiceReceipt,
} from '../../shared/account-choice';
import { ACCOUNT_CHOICE_CHANNELS } from '../../shared/account-choice-channels';
import { handleTrusted } from '../security/trusted-ipc';
import { getAccountChoiceReceipt } from './account-choice-receipts';

/**
 * IPC somente-leitura do recibo da escolha de conta: o cabeçalho do pane
 * pergunta "qual conta este pane usa e por quê" e recebe o recibo JÁ saneado
 * (`parseAccountChoiceReceipt`: lista de permissão, rótulo mascarado, texto
 * livre limpo) ou `null`. Só o frame principal da janela principal alcança
 * (`handleTrusted`). Nunca grava nem esquece recibo, nunca devolve id de
 * conta, fingerprint, e-mail cru nem token, e nunca lança: qualquer entrada
 * inválida, sessão desconhecida ou falha do store vira `null`.
 */

/** Mesmo teto dos demais IPCs que recebem id de sessão. */
export const ACCOUNT_CHOICE_SESSION_ID_MAX_CHARS = 128;

const GetRequestSchema = z
  .object({ sessionId: z.string().min(1).max(ACCOUNT_CHOICE_SESSION_ID_MAX_CHARS) })
  .strict();

export type AccountChoiceLookup = (sessionId: string) => AccountChoiceReceipt | undefined;

export function registerAccountChoiceIpc(
  lookup: AccountChoiceLookup = getAccountChoiceReceipt,
): void {
  handleTrusted(
    ACCOUNT_CHOICE_CHANNELS.get,
    (_event, raw): AccountChoiceReceipt | null => {
      try {
        const request = GetRequestSchema.safeParse(raw);
        if (!request.success) return null;
        return parseAccountChoiceReceipt(lookup(request.data.sessionId));
      } catch {
        return null;
      }
    },
  );
}
