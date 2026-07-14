import { useEffect, useState } from 'react';
import { BUILTIN_FEATURE_FLAGS } from '../../shared/feature-flags';

/**
 * Renderer-side view of the main-process feature flag registry.
 * Components must consume these resolutions instead of hardcoding
 * `flagEnabled` so kill switches / persisted overrides reach the UI.
 */

export type ProductFlagMap = Readonly<Record<string, boolean>>;

/** Built-in defaults used until (or if never) the IPC resolution arrives. */
export function builtinFlagDefaults(): Record<string, boolean> {
  return Object.fromEntries(
    BUILTIN_FEATURE_FLAGS.map((def) => [
      def.id,
      def.killSwitch ? false : def.defaultEnabled,
    ]),
  );
}

/** Parse the flagsList IPC payload fail-closed; null when shape is invalid. */
export function parseFlagList(raw: unknown): Record<string, boolean> | null {
  if (!Array.isArray(raw)) return null;
  const flags: Record<string, boolean> = {};
  for (const item of raw) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { id?: unknown }).id !== 'string' ||
      typeof (item as { enabled?: unknown }).enabled !== 'boolean'
    ) {
      return null;
    }
    flags[(item as { id: string }).id] = (item as { enabled: boolean }).enabled;
  }
  return flags;
}

/**
 * Live product flags. Starts from built-in defaults and replaces them with
 * the main-process resolution (kill switch > override > channel > default).
 */
export function useProductFlags(): ProductFlagMap {
  const [flags, setFlags] = useState<ProductFlagMap>(builtinFlagDefaults);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.nexus?.product?.flagsList();
        const parsed = parseFlagList(list);
        if (!cancelled && parsed) {
          setFlags((prev) => ({ ...prev, ...parsed }));
        }
      } catch {
        // IPC unavailable (tests, degraded preload) — keep built-in defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return flags;
}
