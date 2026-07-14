import fs from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_FEATURE_FLAGS,
  featureFlagDefinitionSchema,
  featureFlagOverridesFileSchema,
  resolveFeatureFlag,
  type FeatureFlagChannel,
  type FeatureFlagDefinition,
  type FeatureFlagResolution,
} from '../../shared/feature-flags';

export interface FeatureFlagRegistryOptions {
  readonly runtimeChannel?: FeatureFlagChannel;
  readonly overridesPath?: string;
  readonly definitions?: readonly FeatureFlagDefinition[];
  readonly now?: () => Date;
  readonly onEval?: (resolution: FeatureFlagResolution) => void;
}

/**
 * In-process feature flag registry. Unknown flags fail closed.
 * Kill switch always wins. Channel policy is fail-closed for lower channels.
 */
export class FeatureFlagRegistry {
  readonly #byId = new Map<string, FeatureFlagDefinition>();
  readonly #overrides = new Map<string, boolean>();
  readonly #runtimeChannel: FeatureFlagChannel;
  readonly #overridesPath: string | null;
  readonly #onEval?: (resolution: FeatureFlagResolution) => void;

  constructor(options: FeatureFlagRegistryOptions = {}) {
    this.#runtimeChannel = options.runtimeChannel ?? detectRuntimeChannel();
    this.#overridesPath = options.overridesPath ?? null;
    this.#onEval = options.onEval;
    for (const def of options.definitions ?? BUILTIN_FEATURE_FLAGS) {
      const parsed = featureFlagDefinitionSchema.parse(def);
      this.#byId.set(parsed.id, parsed);
    }
    if (this.#overridesPath) {
      this.reloadOverrides();
    }
  }

  get runtimeChannel(): FeatureFlagChannel {
    return this.#runtimeChannel;
  }

  list(): readonly FeatureFlagDefinition[] {
    return [...this.#byId.values()];
  }

  isEnabled(id: string): boolean {
    return this.resolve(id).enabled;
  }

  resolve(id: string): FeatureFlagResolution {
    const definition = this.#byId.get(id);
    const override = this.#overrides.has(id)
      ? this.#overrides.get(id)
      : undefined;
    const resolution = resolveFeatureFlag(definition, {
      runtimeChannel: this.#runtimeChannel,
      override,
    });
    const result =
      resolution.id === 'unknown'
        ? { ...resolution, id }
        : resolution;
    if (definition?.telemetry !== false) {
      this.#onEval?.(result);
    }
    return result;
  }

  /** Force kill switch in memory (does not rewrite definition file). */
  engageKillSwitch(id: string): void {
    const current = this.#byId.get(id);
    if (!current) return;
    this.#byId.set(id, { ...current, killSwitch: true });
  }

  setOverride(id: string, enabled: boolean): void {
    if (!this.#byId.has(id)) {
      throw new Error(`unknown feature flag: ${id}`);
    }
    this.#overrides.set(id, enabled);
  }

  /**
   * Pre-production / dogfood: force every known product flag ON via in-memory
   * overrides. Kill switch remains the final authority — the force never
   * clears one, so the emergency-off path keeps working after boot.
   */
  forceEnableAll(): void {
    for (const [id, def] of this.#byId) {
      if (def.killSwitch) continue;
      this.#overrides.set(id, true);
    }
  }

  reloadOverrides(): void {
    if (!this.#overridesPath) return;
    this.#overrides.clear();
    if (!fs.existsSync(this.#overridesPath)) return;
    try {
      const raw = fs.readFileSync(this.#overridesPath, 'utf8');
      const parsed = featureFlagOverridesFileSchema.parse(JSON.parse(raw));
      for (const item of parsed.overrides) {
        if (this.#byId.has(item.id)) {
          this.#overrides.set(item.id, item.enabled);
        }
      }
    } catch {
      // Fail closed: ignore corrupt override files.
    }
  }

  persistOverrides(): void {
    if (!this.#overridesPath) return;
    const payload = featureFlagOverridesFileSchema.parse({
      schemaVersion: 1,
      overrides: [...this.#overrides.entries()].map(([id, enabled]) => ({
        id,
        enabled,
      })),
    });
    const dir = path.dirname(this.#overridesPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.#overridesPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tmp, this.#overridesPath);
  }
}

function detectRuntimeChannel(): FeatureFlagChannel {
  const raw = (process.env.NEXUS_CHANNEL ?? process.env.NODE_ENV ?? 'stable')
    .toLowerCase()
    .trim();
  if (raw === 'dev' || raw === 'development') return 'dev';
  if (raw === 'dogfood') return 'dogfood';
  if (raw === 'preview' || raw === 'beta') return 'preview';
  return 'stable';
}

let singleton: FeatureFlagRegistry | null = null;
let singletonOptions: FeatureFlagRegistryOptions | null = null;

/**
 * Options for the production singleton (e.g. persistent overridesPath under
 * userData). Must run in bootstrap before the first getFeatureFlagRegistry()
 * call; once the singleton exists the call is a no-op — flag authority is
 * never swapped mid-run.
 */
export function configureFeatureFlagRegistry(
  options: FeatureFlagRegistryOptions,
): void {
  if (singleton) return;
  singletonOptions = options;
}

export function getFeatureFlagRegistry(): FeatureFlagRegistry {
  if (!singleton) {
    singleton = new FeatureFlagRegistry({
      runtimeChannel: detectRuntimeChannel(),
      ...singletonOptions,
    });
  }
  return singleton;
}

/**
 * Enable every built-in product flag for local/unpackaged testing.
 * Called from main bootstrap when `!app.isPackaged` or NEXUS_FORCE_ALL_FLAGS=1.
 */
export function enableAllProductFlagsForTesting(): void {
  getFeatureFlagRegistry().forceEnableAll();
}

/** Test-only reset. */
export function resetFeatureFlagRegistryForTests(): void {
  singleton = null;
  singletonOptions = null;
}
