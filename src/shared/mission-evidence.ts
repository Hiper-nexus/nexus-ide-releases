const EVIDENCE_TERMS =
  /\b(?:print(?:s)?|screenshot(?:s)?|captura(?:s)?(?: de tela)?|imagem(?:ns)?|audio(?:s)?|gravacao(?:es)?|evidencia(?:s)?)\b/i;

const FUTURE_TERMS =
  /\b(?:vou|vai|iremos|irei|quando|depois|mais tarde|na próxima etapa|na proxima etapa|em seguida|assim que|logo que|antes de)\b/i;

const EVIDENCE_ACTIONS =
  /\b(?:mandar|mandarei|enviar|enviarei|anexar|anexarei|passar|mostrar|apontar|fornecer)\b/i;

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
 * available print must still dispatch normally. The gate only trips when the
 * text contains evidence plus a future/transfer action in the same objective.
 */
export function missionGoalNeedsFutureEvidence(
  goal: string,
  hasAttachedEvidence = false,
): boolean {
  if (hasAttachedEvidence) return false;
  const normalized = normalize(goal);
  if (!normalized || !EVIDENCE_TERMS.test(normalized)) return false;
  if (!FUTURE_TERMS.test(normalized)) return false;

  return (
    EVIDENCE_ACTIONS.test(normalized) ||
    /\b(?:vou|irei|quando|depois|na proxima etapa|em seguida|assim que|logo que)\b.{0,100}\b(?:print|screenshot|captura|imagem|audio|gravacao|evidencia)/i.test(
      normalized,
    ) ||
    /\b(?:print|screenshot|captura|imagem|audio|gravacao|evidencia)\b.{0,100}\b(?:depois|quando|na proxima etapa|em seguida|assim que|logo que|antes de enviar)/i.test(
      normalized,
    )
  );
}

export const MISSION_EVIDENCE_WAIT_MESSAGE =
  'Este objetivo diz que você ainda vai enviar evidências. Anexe os prints ou áudios antes de iniciar a missão.';
