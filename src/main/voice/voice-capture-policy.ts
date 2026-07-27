export interface VoiceCapturePolicyInput {
  readonly isPackaged: boolean;
  readonly isSmokeTest: boolean;
  readonly isRealMissionE2E: boolean;
  readonly disableVoiceCaptureEnv?: string;
}

/**
 * Main-owned capture policy.
 *
 * Automation never needs ambient microphone input. The explicit environment
 * kill-switch is intentionally dev-only; a normal packaged launch must not
 * accept an inherited environment variable as a hidden product setting.
 */
export function shouldAllowVoiceCapture(
  input: VoiceCapturePolicyInput,
): boolean {
  if (input.isSmokeTest || input.isRealMissionE2E) return false;
  if (
    !input.isPackaged &&
    input.disableVoiceCaptureEnv?.trim() === '1'
  ) {
    return false;
  }
  return true;
}
