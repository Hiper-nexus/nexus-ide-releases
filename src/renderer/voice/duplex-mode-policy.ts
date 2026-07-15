/**
 * Política de duplex: full-duplex com AEC do Chromium é o default de produto
 * para Gemini Live (barge-in real). Half-duplex permanece disponível como
 * fallback seguro se o AEC não ativar no track.
 */

export const DUPLEX_MODES = ['half-duplex', 'chromium-aec-probe', 'full-duplex'] as const;

export type DuplexMode = (typeof DUPLEX_MODES)[number];

export type DuplexStatus =
  | 'half-duplex'
  | 'chromium-aec-pending'
  | 'chromium-aec-active'
  | 'chromium-aec-unavailable'
  | 'full-duplex';

export interface DuplexInputConstraints {
  readonly echoCancellation: boolean;
  readonly noiseSuppression: boolean;
  readonly autoGainControl: boolean;
}

export interface DuplexModePolicy {
  readonly mode: DuplexMode;
  readonly status: DuplexStatus;
  readonly inputConstraints: DuplexInputConstraints;
  /**
   * Quando false, o gate de mic no transporte realtime NÃO retém frames
   * enquanto ela fala — o provider recebe áudio e pode interromper (barge-in).
   */
  readonly keepHalfDuplexMicGate: boolean;
}

export interface ChromiumAecProbeSettings {
  readonly echoCancellation?: boolean;
}

/** Produto: full-duplex com AEC + Gemini START_OF_ACTIVITY_INTERRUPTS. */
export const DEFAULT_DUPLEX_MODE: DuplexMode = 'full-duplex';

export const HALF_DUPLEX_INPUT_CONSTRAINTS: DuplexInputConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * Isola o experimento de AEC: não muda o SoftAgc nem introduz supressão de
 * ruído do Chromium junto com a variável que estamos medindo.
 */
export const CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS: DuplexInputConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

export const FULL_DUPLEX_INPUT_CONSTRAINTS: DuplexInputConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

export function duplexModePolicy(
  mode: DuplexMode = DEFAULT_DUPLEX_MODE,
): DuplexModePolicy {
  if (mode === 'full-duplex') {
    return {
      mode,
      status: 'full-duplex',
      inputConstraints: FULL_DUPLEX_INPUT_CONSTRAINTS,
      keepHalfDuplexMicGate: false,
    };
  }
  if (mode === 'chromium-aec-probe') {
    return {
      mode,
      status: 'chromium-aec-pending',
      inputConstraints: CHROMIUM_AEC_PROBE_INPUT_CONSTRAINTS,
      keepHalfDuplexMicGate: true,
    };
  }

  return {
    mode,
    status: 'half-duplex',
    inputConstraints: HALF_DUPLEX_INPUT_CONSTRAINTS,
    keepHalfDuplexMicGate: true,
  };
}

/**
 * Whether the Live mic should keep flowing to the provider while she speaks
 * (full-duplex barge-in), given the mode AND the real resolved AEC status.
 *
 * The mode default alone is not enough: when Chromium reports the requested
 * echo cancellation was NOT applied (`chromium-aec-unavailable`), a full-duplex
 * mic feeds the echo of her own TTS back into Gemini's high-sensitivity VAD,
 * which trips `START_OF_ACTIVITY_INTERRUPTS` and cuts the generation before it
 * vocalizes — a silent turn. In that case fall back to the gated (half-duplex)
 * mic. `pending`/active keep the mode's barge-in behaviour untouched.
 */
export function liveMicFullDuplex(opts: {
  mode: DuplexMode;
  aecStatus: DuplexStatus;
}): boolean {
  if (opts.aecStatus === 'chromium-aec-unavailable') return false;
  return !duplexModePolicy(opts.mode).keepHalfDuplexMicGate;
}

/**
 * Traduz `MediaTrackSettings.echoCancellation` para um estado exibível. A
 * ausência de settings significa que o getUserMedia ainda não concluiu; um
 * objeto sem o campo indica que o Chromium não confirmou o AEC solicitado.
 */
export function resolveDuplexStatus(
  mode: DuplexMode,
  settings?: ChromiumAecProbeSettings,
): DuplexStatus {
  if (mode === 'half-duplex') return 'half-duplex';
  if (mode === 'full-duplex') {
    if (!settings) return 'chromium-aec-pending';
    return settings.echoCancellation === true
      ? 'full-duplex'
      : 'chromium-aec-unavailable';
  }
  if (!settings) return 'chromium-aec-pending';
  return settings.echoCancellation === true
    ? 'chromium-aec-active'
    : 'chromium-aec-unavailable';
}
