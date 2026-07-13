/**
 * Best-effort pure probes: build windows from local signals (cooldown, tokens,
 * limit hits). No network — safe unit tests. Live network probes stay optional
 * and only upgrade confidence when explicitly added later.
 */

import type { QuotaWindow } from '../../shared/quota-types';
import type { LimitHit } from '../orch/limit-detector';
import {
  defaultUnknownWindows,
  knownWindow,
  mergeWindows,
} from './quota-normalize';
import {
  applyLimitHitToWindows,
  windowsFromCooldown,
} from './quota-from-limit';

export interface ProbeInput {
  adapterId: string;
  accountId?: string;
  onCooldown?: boolean;
  cooldownUntil?: number;
  /** Project-local token spend for this adapter (optional). */
  localTokens?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  lastLimitHit?: LimitHit | null;
  /** Epoch ms when lastLimitHit was observed (for stable resetsAt). */
  lastLimitHitAt?: number;
  now?: number;
}

/**
 * Probe a single provider account. Always returns at least honest unknown
 * windows. Never fabricates a usedRatio without a local signal.
 */
export function probeProviderWindows(input: ProbeInput): QuotaWindow[] {
  const now = input.now ?? Date.now();
  let windows = defaultUnknownWindows(input.adapterId);

  if (input.onCooldown && input.cooldownUntil && input.cooldownUntil > now) {
    windows = mergeWindows(
      windows,
      windowsFromCooldown(input.cooldownUntil, input.adapterId, now),
    );
  }

  if (input.lastLimitHit) {
    const hitAt = input.lastLimitHitAt ?? now;
    windows = applyLimitHitToWindows(
      windows,
      input.lastLimitHit,
      input.adapterId,
      now,
      hitAt,
    );
  }

  // Project-local token activity for ANY CLI (transcript/cost store).
  // Labeled "Projeto" / local-tokens — never claimed as cloud provider %.
  if (input.localTokens) {
    const tok =
      input.localTokens.inputTokens + input.localTokens.outputTokens;
    if (tok > 0) {
      const ratio = Math.min(1, Math.log10(tok + 1) / 6.3); // ~2e6 → ~1
      const label =
        input.adapterId === 'ollama' ? 'Local' : 'Projeto';
      windows = mergeWindows(windows, [
        knownWindow({
          kind: 'local',
          label,
          usedRatio: ratio,
          source: 'local-tokens',
          confidence: 'low',
          now,
        }),
      ]);
    }
  }

  return windows;
}

/** Claude-specific: prefer session + weekly labels after a rate limit. */
export function probeClaude(input: Omit<ProbeInput, 'adapterId'>): QuotaWindow[] {
  return probeProviderWindows({ ...input, adapterId: 'claude' });
}

/** Codex-specific: prefer 5h + weekly labels. */
export function probeCodex(input: Omit<ProbeInput, 'adapterId'>): QuotaWindow[] {
  return probeProviderWindows({ ...input, adapterId: 'codex' });
}
