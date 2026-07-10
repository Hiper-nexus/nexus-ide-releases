/**
 * Política pura para experimentar AEC do Chromium sem alterar o contrato de
 * segurança atual: até existir uma referência acústica comprovada, a Jarvis
 * continua half-duplex enquanto está falando.
 */

export const DUPLEX_MODES = ['half-duplex', 'chromium-aec-probe'] as const;

export type DuplexMode = (typeof DUPLEX_MODES)[number];

export type DuplexStatus =
  | 'half-duplex'
  | 'chromium-aec-pending'
  | 'chromium-aec-active'
  | 'chromium-aec-unavailable';

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
   * Um probe do Chromium não é evidência suficiente para liberar fala
   * simultânea. O gate atual só poderá ser aberto por uma futura implementação
   * AEC que forneça referência e métricas de qualidade em runtime.
   */
  readonly keepHalfDuplexMicGate: true;
}

export interface ChromiumAecProbeSettings {
  readonly echoCancellation?: boolean;
}

export const DEFAULT_DUPLEX_MODE: DuplexMode = 'half-duplex';

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

export function duplexModePolicy(
  mode: DuplexMode = DEFAULT_DUPLEX_MODE,
): DuplexModePolicy {
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
  if (!settings) return 'chromium-aec-pending';
  return settings.echoCancellation === true
    ? 'chromium-aec-active'
    : 'chromium-aec-unavailable';
}
