/**
 * F-984: motivo LEGÍVEL de um pane que não começou, tirado da cauda já
 * sanitizada do PTY (pane-boot-output). O aviso ao orquestrador só leva
 * frases fixas, o id do modelo e o código de saída — nunca a saída crua.
 *
 * - AGY 1.3: `error: invalid model selection (--model "gemini-4-argon" --effort ""):
 *   model gemini-4-argon is not recognized as a known model or custom model in settings`
 *   (07/10 18:22, pane-muym5dik-a, saiu com 1 em 3,8 s).
 * - Recusas canônicas de modelo das outras CLIs: as mesmas do failover
 *   (`limit-detector`, kind `model`).
 * - Fila de pesados do Nexus: `nexus-heavy: local admission request failed`
 *   (exit 74 do supervisor nativo) ou o `[Nexus] Heavy command not started`
 *   do gancho Node (exit 78).
 */
import { detectLimit } from './limit-detector';

const MODEL_ID = '([A-Za-z0-9][A-Za-z0-9._:/\\[\\]-]{0,79})';
const UNKNOWN_MODEL = new RegExp(
  `\\bmodel "?${MODEL_ID}"? is not recognized as a known model\\b`,
  'i',
);
const HEAVY_ADMISSION =
  /nexus-heavy: local admission request failed|\[Nexus\] Heavy command not started/i;
const MAX_REASON_CHARS = 160;

export interface PaneBootDiagnosis {
  /** Modelo que a CLI recusou ao nascer (quando a saída o nomeia). */
  readonly rejectedModel: string | null;
  /** A saída mostra recusa de modelo (com ou sem id). */
  readonly modelRejected: boolean;
  /** Motivo curto em pt-BR para o aviso; null = nada reconhecido. */
  readonly detail: string | null;
}

function shortReason(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line;
}

export function diagnosePaneBoot(
  output: string | null | undefined,
  exitCode?: number | null,
): PaneBootDiagnosis {
  const text = output ?? '';
  const exitNote =
    typeof exitCode === 'number' && exitCode !== 0 ? `saiu com código ${exitCode}` : null;
  const join = (reason: string | null): string | null =>
    [reason, exitNote].filter((part): part is string => Boolean(part)).join('; ') || null;

  // Só "não reconhecido" é recusa do MODELO: o `--effort is not supported for
  // model` do F-773 é parâmetro e não pode tirar o modelo das rotas.
  const named = UNKNOWN_MODEL.exec(text);
  if (named) {
    const model = named[1]!;
    return {
      rejectedModel: model,
      modelRejected: true,
      detail: join(`a CLI instalada não reconhece o modelo "${model}"`),
    };
  }
  const hit = text ? detectLimit(text) : null;
  if (hit?.kind === 'model') {
    return { rejectedModel: null, modelRejected: true, detail: join(shortReason(hit.reason)) };
  }
  if (HEAVY_ADMISSION.test(text)) {
    return {
      rejectedModel: null,
      modelRejected: false,
      detail: join('a fila de comandos pesados do Nexus (nexus-heavy) não liberou a vaga'),
    };
  }
  return { rejectedModel: null, modelRejected: false, detail: join(null) };
}
