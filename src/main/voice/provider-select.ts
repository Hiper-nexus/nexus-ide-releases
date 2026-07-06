import type { VoicePlugin } from '../../shared/voice-config';
import type {
  ProviderKind,
  ResolvedChain,
  ResolvedProvider,
} from '../../shared/voice-ipc';

/**
 * Pure resolution of a voice provider fallback chain. Walks `head` → `fallback`
 * head-first and marks each link available/unavailable using injected probes,
 * so the whole thing is testable without touching the filesystem or env.
 *
 * The selected provider is the FIRST available link. `macos-say` is treated as a
 * system provider (always available on darwin) so a chain that ends in it always
 * resolves to *something* — the pipeline can always speak.
 */

export interface ProviderProbes {
  /** Non-empty env var present. */
  hasEnv: (name: string) => boolean;
  /** Binary resolvable (absolute path exists+exec, or found on PATH). */
  hasBin: (binOrPath: string) => boolean;
  platform: NodeJS.Platform;
}

/** System providers that need no key and no separate install. */
const SYSTEM_PROVIDERS = new Set(['macos-say']);

export function classifyKind(plugin: VoicePlugin): ProviderKind {
  if (SYSTEM_PROVIDERS.has(plugin.provider)) return 'system';
  if (plugin.localBin) return 'local';
  return 'cloud';
}

function resolveLink(plugin: VoicePlugin, probes: ProviderProbes): ResolvedProvider {
  const kind = classifyKind(plugin);

  if (kind === 'system') {
    const available = probes.platform === 'darwin';
    return {
      provider: plugin.provider,
      kind,
      available,
      model: plugin.model,
      reason: available ? 'ready (system voice)' : 'macOS only',
    };
  }

  if (kind === 'local') {
    const bin = plugin.localBin ?? plugin.provider;
    const available = probes.hasBin(bin);
    return {
      provider: plugin.provider,
      kind,
      available,
      model: plugin.model,
      reason: available ? `ready (${bin})` : `binary not found: ${bin}`,
    };
  }

  // cloud
  const authType = plugin.auth?.type ?? 'api_key';
  if (authType === 'none') {
    return {
      provider: plugin.provider,
      kind,
      available: true,
      model: plugin.model,
      reason: 'ready (no auth)',
    };
  }
  const envVar = plugin.auth?.envVar;
  if (!envVar) {
    return {
      provider: plugin.provider,
      kind,
      available: false,
      model: plugin.model,
      reason: 'no auth.envVar configured',
    };
  }
  const available = probes.hasEnv(envVar);
  return {
    provider: plugin.provider,
    kind,
    available,
    model: plugin.model,
    reason: available ? `ready (${envVar})` : `${envVar} not set`,
  };
}

/** Flatten a plugin chain (head → fallback → …) into an ordered array. */
export function flattenChain(head: VoicePlugin): VoicePlugin[] {
  const out: VoicePlugin[] = [];
  let node: VoicePlugin | undefined = head;
  // Guard against a pathological self-referential config.
  let guard = 0;
  while (node && guard < 32) {
    out.push(node);
    node = node.fallback;
    guard += 1;
  }
  return out;
}

/** Resolve which provider in a chain is active given current availability. */
export function resolveChain(head: VoicePlugin, probes: ProviderProbes): ResolvedChain {
  const links = flattenChain(head).map((p) => resolveLink(p, probes));
  const active = links.find((l) => l.available) ?? null;
  return { active, chain: links };
}

/**
 * Return the concrete plugin (with its endpoint/model/localBin) for the active
 * provider, so the STT/TTS service can act on it. Returns null when nothing in
 * the chain is available.
 */
export function selectPlugin(
  head: VoicePlugin,
  probes: ProviderProbes,
): VoicePlugin | null {
  const plugins = flattenChain(head);
  for (const p of plugins) {
    if (resolveLink(p, probes).available) return p;
  }
  return null;
}

/**
 * Move the plugin whose provider === `providerId` to the head of the chain,
 * preserving the relative order of the rest as fallbacks. Used when the user
 * pins a provider in settings. Pure — returns a new chain, never mutates.
 */
export function promoteProvider(head: VoicePlugin, providerId: string): VoicePlugin {
  const plugins = flattenChain(head);
  const idx = plugins.findIndex((p) => p.provider === providerId);
  if (idx <= 0) return head; // not found or already head
  const reordered = [plugins[idx], ...plugins.filter((_, i) => i !== idx)];
  return relink(reordered);
}

/** Rebuild a `fallback`-linked chain from an ordered array (immutably). */
export function relink(plugins: VoicePlugin[]): VoicePlugin {
  return plugins.reduceRight<VoicePlugin | undefined>((fallback, plugin) => {
    const { fallback: _drop, ...rest } = plugin;
    return { ...rest, ...(fallback ? { fallback } : {}) };
  }, undefined) as VoicePlugin;
}
