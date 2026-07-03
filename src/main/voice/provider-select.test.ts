import { describe, expect, it } from 'vitest';
import type { VoicePlugin } from '../../shared/voice-config';
import {
  classifyKind,
  flattenChain,
  resolveChain,
  selectPlugin,
  promoteProvider,
  relink,
  type ProviderProbes,
} from './provider-select';

const chain: VoicePlugin = {
  type: 'stt',
  provider: 'groq',
  auth: { type: 'api_key', envVar: 'GROQ_API_KEY' },
  fallback: {
    type: 'stt',
    provider: 'openai',
    auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' },
    fallback: { type: 'stt', provider: 'local-whisper', localBin: 'whisper-cli' },
  },
};

function probes(over: Partial<ProviderProbes> = {}): ProviderProbes {
  return {
    hasEnv: () => false,
    hasBin: () => false,
    platform: 'darwin',
    ...over,
  };
}

describe('classifyKind', () => {
  it('classifies cloud, local, and system providers', () => {
    expect(classifyKind({ type: 'stt', provider: 'groq' })).toBe('cloud');
    expect(classifyKind({ type: 'stt', provider: 'local-whisper', localBin: 'x' })).toBe('local');
    expect(classifyKind({ type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say' })).toBe('system');
  });
});

describe('flattenChain', () => {
  it('walks head → fallback into order', () => {
    expect(flattenChain(chain).map((p) => p.provider)).toEqual([
      'groq',
      'openai',
      'local-whisper',
    ]);
  });
});

describe('resolveChain', () => {
  it('selects the first provider whose key is present', () => {
    const resolved = resolveChain(chain, probes({ hasEnv: (n) => n === 'OPENAI_API_KEY' }));
    expect(resolved.active?.provider).toBe('openai');
    expect(resolved.chain[0].available).toBe(false);
    expect(resolved.chain[0].reason).toContain('GROQ_API_KEY not set');
  });

  it('falls back to a local binary when no keys are set', () => {
    const resolved = resolveChain(chain, probes({ hasBin: () => true }));
    expect(resolved.active?.provider).toBe('local-whisper');
  });

  it('returns null active when nothing is available', () => {
    const resolved = resolveChain(chain, probes());
    expect(resolved.active).toBeNull();
  });

  it('treats macos-say as available on darwin and unavailable elsewhere', () => {
    const say: VoicePlugin = { type: 'tts', provider: 'macos-say', localBin: '/usr/bin/say' };
    expect(resolveChain(say, probes({ platform: 'darwin' })).active?.provider).toBe('macos-say');
    expect(resolveChain(say, probes({ platform: 'linux' })).active).toBeNull();
  });
});

describe('selectPlugin', () => {
  it('returns the concrete plugin for the active provider', () => {
    const plugin = selectPlugin(chain, probes({ hasEnv: (n) => n === 'GROQ_API_KEY' }));
    expect(plugin?.provider).toBe('groq');
    expect(plugin?.auth?.envVar).toBe('GROQ_API_KEY');
  });
});

describe('promoteProvider', () => {
  it('moves a provider to the head, keeping the rest as fallbacks', () => {
    const promoted = promoteProvider(chain, 'local-whisper');
    expect(flattenChain(promoted).map((p) => p.provider)).toEqual([
      'local-whisper',
      'groq',
      'openai',
    ]);
  });

  it('is a no-op for the head or an unknown provider', () => {
    expect(promoteProvider(chain, 'groq')).toBe(chain);
    expect(promoteProvider(chain, 'nope')).toBe(chain);
  });

  it('does not mutate the original chain', () => {
    const before = flattenChain(chain).map((p) => p.provider);
    promoteProvider(chain, 'openai');
    expect(flattenChain(chain).map((p) => p.provider)).toEqual(before);
  });
});

describe('relink', () => {
  it('rebuilds a fallback chain from an ordered array', () => {
    const rebuilt = relink([
      { type: 'stt', provider: 'a' },
      { type: 'stt', provider: 'b' },
      { type: 'stt', provider: 'c' },
    ]);
    expect(flattenChain(rebuilt).map((p) => p.provider)).toEqual(['a', 'b', 'c']);
  });
});
