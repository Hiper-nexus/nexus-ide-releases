import { create } from 'zustand';
import type { ScreenCaptureMetadata } from '../../shared/vision-ipc';

interface VisionConsentState {
  allowCloudImage: boolean;
  consentToken: string | null;
  pending: boolean;
  error: string | null;
  lastCapture: ScreenCaptureMetadata | null;
  enableCloudImage(): Promise<void>;
  disableCloudImage(): Promise<void>;
  markCaptured(capture: ScreenCaptureMetadata): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useVisionConsentStore = create<VisionConsentState>((set) => ({
  allowCloudImage: false,
  consentToken: null,
  pending: false,
  error: null,
  lastCapture: null,

  enableCloudImage: async () => {
    set({ pending: true, error: null });
    try {
      const result = await window.nexus.vision.setImageConsent(true);
      set({
        allowCloudImage: result.allowCloudImage,
        consentToken: result.consentToken,
        pending: false,
      });
    } catch (err) {
      set({ pending: false, error: errorText(err) });
    }
  },

  disableCloudImage: async () => {
    set({ pending: true, error: null });
    try {
      await window.nexus.vision.setImageConsent(false);
      set({
        allowCloudImage: false,
        consentToken: null,
        pending: false,
      });
    } catch (err) {
      set({ pending: false, error: errorText(err) });
    }
  },

  markCaptured: (lastCapture) => set({ lastCapture }),
}));
