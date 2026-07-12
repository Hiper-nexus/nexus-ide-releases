import { beforeEach, describe, expect, it, vi } from 'vitest';

const { secrets } = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
}));

vi.mock('../persistence/secrets-store', () => ({
  getSecret: (key: string) => secrets.get(key) ?? null,
  hasSecret: (key: string) => secrets.has(key),
  setSecret: (key: string, value: string) => {
    if (value) secrets.set(key, value);
    else secrets.delete(key);
    return { ok: true };
  },
}));

import {
  hasMediaKey,
  maskedMediaKey,
  resolveMediaKey,
} from './media-keys';
import { findMediaProvider } from './media-providers';

describe('shared media provider credentials', () => {
  beforeEach(() => secrets.clear());

  it('reuses an existing Gemini voice credential for Google image generation', () => {
    const provider = findMediaProvider('google-image')!;
    secrets.set('voice-env:GEMINI_API_KEY', 'gemini-shared-secret-1234');

    expect(resolveMediaKey(provider)).toBe('gemini-shared-secret-1234');
    expect(hasMediaKey(provider)).toBe(true);
    expect(maskedMediaKey('google-image')).toBe('gem…1234');
  });

  it('lets a media-specific credential override the shared provider key', () => {
    const provider = findMediaProvider('openai-image')!;
    secrets.set('voice-env:OPENAI_API_KEY', 'shared-openai-secret-1234');
    secrets.set('mediakey:openai-image', 'media-openai-secret-5678');

    expect(resolveMediaKey(provider)).toBe('media-openai-secret-5678');
    expect(maskedMediaKey('openai-image')).toBe('med…5678');
  });

  it('shares Gemini key between google-image and google-video', () => {
    secrets.set('mediakey:google-image', 'gemini-image-only-9999');
    const video = findMediaProvider('google-video')!;
    expect(resolveMediaKey(video)).toBe('gemini-image-only-9999');
    expect(hasMediaKey(video)).toBe(true);
  });

  it('shares Replicate token between replicate-image and replicate-video', () => {
    secrets.set('mediakey:replicate-video', 'r8-video-token-abcd');
    const image = findMediaProvider('replicate-image')!;
    expect(resolveMediaKey(image)).toBe('r8-video-token-abcd');
    expect(hasMediaKey(image)).toBe(true);
    // Masked preview must reflect the shared key so Settings shows usable state.
    expect(maskedMediaKey('replicate-image')).toBe('r8-…abcd');
  });
});
