import { describe, expect, it } from 'vitest';
import { shouldAllowVoiceCapture } from './voice-capture-policy';

describe('voice capture policy', () => {
  it.each([
    { isSmokeTest: true, isRealMissionE2E: false },
    { isSmokeTest: false, isRealMissionE2E: true },
    { isSmokeTest: true, isRealMissionE2E: true },
  ])('fails closed for automation: %o', (automation) => {
    expect(
      shouldAllowVoiceCapture({
        isPackaged: false,
        ...automation,
      }),
    ).toBe(false);
  });

  it('accepts the explicit kill-switch in development', () => {
    expect(
      shouldAllowVoiceCapture({
        isPackaged: false,
        isSmokeTest: false,
        isRealMissionE2E: false,
        disableVoiceCaptureEnv: '1',
      }),
    ).toBe(false);
  });

  it('ignores the environment kill-switch in a normal packaged launch', () => {
    expect(
      shouldAllowVoiceCapture({
        isPackaged: true,
        isSmokeTest: false,
        isRealMissionE2E: false,
        disableVoiceCaptureEnv: '1',
      }),
    ).toBe(true);
  });
});
