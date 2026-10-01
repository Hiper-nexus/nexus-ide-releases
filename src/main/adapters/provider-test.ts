import type { Adapter } from '../../shared/adapter-types';
import type { TestConnectionResult } from '../../shared/provider-settings-types';
import { isBinResolvable } from './adapter-registry';
import { probeQwenCredential } from './qwen-readiness';

/**
 * Test-connection for a provider's configured key. For api-provider adapters
 * we make a cheap authenticated probe against the endpoint; for cli-pty
 * adapters (which authenticate via their own CLI/keychain) we validate that
 * the binary resolves and a key is present — a real network round-trip is the
 * CLI's own job. Never throws into the IPC layer.
 */

const PROBE_TIMEOUT_MS = 10_000;

async function probeEndpoint(
  endpoint: string,
  headers: Record<string, string>,
): Promise<TestConnectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    // 200/400/404 all mean "reached an authenticated endpoint"; 401/403 mean
    // the key was rejected.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `key rejected (HTTP ${res.status})` };
    }
    return { ok: true, detail: `reachable (HTTP ${res.status})` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `unreachable: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function testProviderKey(
  adapter: Adapter,
  key: string | null,
): Promise<TestConnectionResult> {
  if (adapter.kind === 'api-provider') {
    if (!key) return { ok: false, detail: 'no key stored' };
    const headers: Record<string, string> = {
      [adapter.auth.header]: `${adapter.auth.scheme} ${key}`.trim(),
    };
    return probeEndpoint(adapter.endpoint, headers);
  }

  // cli-pty: verify the binary resolves; report whether a key is stored.
  if (!isBinResolvable(adapter.bin)) {
    return { ok: false, detail: `binary "${adapter.bin}" not found on PATH` };
  }
  // F-238: sonda viva só no painel de Providers — nunca no spawn. A chave do
  // Qwen pode viver só em ~/.qwen/settings.json; a sonda a usa em memória.
  if (adapter.id === 'qwen') {
    const probe = await probeQwenCredential({ key });
    switch (probe.state) {
      case 'present':
        return { ok: true, detail: 'reachable; credential accepted' };
      case 'invalid-credential':
        return { ok: false, detail: probe.detail ?? 'key rejected' };
      case 'no-credential':
        return { ok: false, detail: 'binary found but no key stored' };
      default:
        return { ok: true, detail: 'binary found; credential check unreachable (CLI validates on use)' };
    }
  }
  if (adapter.auth.method === 'oauth' || adapter.auth.method === 'subscription') {
    return {
      ok: true,
      detail: 'CLI uses browser/subscription auth — no key needed',
    };
  }
  return key
    ? { ok: true, detail: 'binary found; key stored (CLI validates on use)' }
    : { ok: false, detail: 'binary found but no key stored' };
}
