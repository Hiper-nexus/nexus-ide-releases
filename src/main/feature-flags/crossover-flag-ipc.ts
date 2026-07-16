import { ipcMain } from 'electron';
import {
  CROSSOVER_FLAG_SET_CHANNEL,
  crossoverFlagSetRequestSchema,
  type CrossoverFlagSetResult,
} from '../../shared/crossover-flags';
import { getFeatureFlagRegistry } from './feature-flag-registry';

/**
 * Persisted feature-flag override IPC (oh-my-pi crossover).
 *
 * There was no runtime path to flip a flag override — overrides only loaded
 * from `feature-flags.json` at boot. This handler exposes exactly one
 * conscious action: set (or clear-to-value) a persisted override, reusing the
 * registry's existing `setOverride` + `persistOverrides` mechanism.
 *
 * Fail-closed is preserved end to end:
 * - Unknown flags throw (`setOverride`), so the renderer cannot invent one.
 * - Kill-switch and channel-blocked flags still resolve to `false` regardless
 *   of the override, so an override can never force such a flag on.
 * The response echoes the RESOLVED state (not the raw override) so the UI shows
 * the truth after policy is applied.
 */
export function registerCrossoverFlagIpc(): void {
  ipcMain.handle(CROSSOVER_FLAG_SET_CHANNEL, (_event, raw): CrossoverFlagSetResult => {
    const input = crossoverFlagSetRequestSchema.parse(raw);
    const registry = getFeatureFlagRegistry();
    // Throws on an unknown flag id — the renderer only ever toggles known ones.
    registry.setOverride(input.id, input.enabled);
    let persisted = true;
    try {
      registry.persistOverrides();
    } catch {
      // The in-memory override still applies this session; report the miss so
      // the UI can warn it will not survive a restart.
      persisted = false;
    }
    const resolution = registry.resolve(input.id);
    return {
      id: resolution.id,
      enabled: resolution.enabled,
      reason: resolution.reason,
      persisted,
    };
  });
}
