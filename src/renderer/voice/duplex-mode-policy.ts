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
