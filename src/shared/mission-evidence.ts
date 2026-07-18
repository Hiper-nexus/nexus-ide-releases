const EVIDENCE_TERMS =
  /\b(?:print(?:s)?|screenshot(?:s)?|captura(?:s)?(?: de tela)?|imagens?|audio(?:s)?|gravacao(?:es)?|evidencia(?:s)?)\b/i;

const FUTURE_TERMS =
  /\b(?:vou|vai|iremos|irei|quando|depois|mais tarde|na próxima etapa|na proxima etapa|em seguida|assim que|logo que|antes de)\b/i;

/**
 * Transfer / point-at actions that mean evidence is still incoming.
 * Do NOT include plain present-tense verbs like "mostra" (UI description).
 */
const EVIDENCE_ACTIONS =
  /\b(?:mandar|mandarei|enviar|enviarei|anexar|anexarei|passar|mostrar|apontar|fornecer|te apontar|te mando|te envio)\b/i;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects a promise that diagnostic evidence will arrive later.
 *
 * This is deliberately conservative: ordinary goals that mention an already
 * available print (e.g. "do print", "veja o print") or a future product step
 * ("em seguida melhore X") must still dispatch normally. The gate only trips
 * when the text contains evidence + a future marker + a transfer/point action.
 */
export function missionGoalNeedsFutureEvidence(
  goal: string,
  hasAttachedEvidence = false,
): boolean {
  if (hasAttachedEvidence) return false;
  const normalized = normalize(goal);
  if (!normalized || !EVIDENCE_TERMS.test(normalized)) return false;
  if (!FUTURE_TERMS.test(normalized)) return false;

  // "em seguida melhore isto. do print" describes an existing screenshot —
  // it must NOT hold. Require an explicit transfer/point action OR the
  // idiomatic "com prints/capturas" packaging of future evidence.
  const hasTransferAction = EVIDENCE_ACTIONS.test(normalized);
  const hasWithEvidencePack =
    /\bcom (?:os |as )?(?:prints?|screenshots?|capturas?|imagens?|audios?|gravacoes?|evidencias?)\b/i.test(
      normalized,
    );
  if (!hasTransferAction && !hasWithEvidencePack) return false;

  // Keep a proximity bound so distant clauses do not false-positive.
  return (
    /\b(?:vou|irei|quando|depois|na proxima etapa|em seguida|assim que|logo que)\b.{0,120}\b(?:mandar|mandarei|enviar|enviarei|anexar|anexarei|passar|mostrar|apontar|fornecer).{0,80}\b(?:print|screenshot|captura|imagem|audio|gravacao|evidencia)/i.test(
      normalized,
    ) ||
    /\b(?:mandar|mandarei|enviar|enviarei|anexar|anexarei|passar|mostrar|apontar|fornecer).{0,80}\b(?:print|screenshot|captura|imagem|audio|gravacao|evidencia).{0,80}\b(?:depois|quando|na proxima etapa|em seguida|assim que|logo que)/i.test(
      normalized,
    ) ||
    /\b(?:vou|irei|quando|depois|na proxima etapa|em seguida|assim que|logo que).{0,100}\b(?:print|screenshot|captura|imagem|audio|gravacao|evidencia).{0,40}\b(?:mandar|enviar|anexar|passar|mostrar|apontar|fornecer)/i.test(
      normalized,
    ) ||
    /\b(?:print|screenshot|captura|imagem|audio|gravacao|evidencia)\b.{0,100}\b(?:depois|quando|na proxima etapa|em seguida|assim que|logo que).{0,40}\b(?:mandar|enviar|anexar|passar|mostrar|apontar|fornecer)/i.test(
      normalized,
    ) ||
    // "na próxima etapa com prints" / "com prints depois"
    /\b(?:na proxima etapa|depois|em seguida|mais tarde|quando).{0,60}\bcom (?:os |as )?(?:prints?|screenshots?|capturas?|imagens?|audios?|gravacoes?|evidencias?)\b/i.test(
      normalized,
    ) ||
    /\bcom (?:os |as )?(?:prints?|screenshots?|capturas?|imagens?|audios?|gravacoes?|evidencias?)\b.{0,60}\b(?:na proxima etapa|depois|em seguida|mais tarde|quando)\b/i.test(
      normalized,
    )
  );
}

export const MISSION_EVIDENCE_WAIT_MESSAGE =
  'Este objetivo diz que você ainda vai enviar evidências. Anexe os prints ou áudios antes de iniciar a missão.';
