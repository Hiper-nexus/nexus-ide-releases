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
  /** Overrides explícitos (setOverride/reload) — persistidos em disco. */
  readonly #overrides = new Map<string, boolean>();
  /** Force blanket (NEXUS_FORCE_ALL_FLAGS / smoke) — efêmero, NUNCA persistido. */
  readonly #forced = new Set<string>();
  /**
   * Overrides de ids não reconhecidos por este build (ex.: flag nova salva por
   * uma versão futura). Preservados na reescrita para um downgrade→upgrade não
   * perder a preferência silenciosamente.
   */
  #unknownOverrides: Array<{ id: string; enabled: boolean }> = [];
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
    // Precedência de override: explícito (usuário) > force blanket > nenhum.
    const override = this.#overrides.has(id)
      ? this.#overrides.get(id)
      : this.#forced.has(id)
        ? true
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

  /** Remove o override do id — a resolução volta ao default embutido. */
  clearOverride(id: string): void {
    if (!this.#byId.has(id)) {
      throw new Error(`unknown feature flag: ${id}`);
    }
    this.#overrides.delete(id);
  }

  /** Override explícito corrente (undefined = sem override) — para rollback. */
  peekOverride(id: string): boolean | undefined {
    return this.#overrides.has(id) ? this.#overrides.get(id) : undefined;
  }

  /**
   * Pre-production / dogfood: force every known product flag ON. Efêmero por
   * construção — vive em `#forced`, fora do conjunto persistido, então um
   * `persistOverrides()` disparado enquanto o force está ativo NÃO grava as
   * flags forçadas em disco (senão o próximo launch sem o env var continuaria
   * tudo ON). Kill switch continua sendo a autoridade final.
   */
  forceEnableAll(): void {
    for (const [id, def] of this.#byId) {
      if (def.killSwitch) continue;
      this.#forced.add(id);
    }
  }

  reloadOverrides(): void {
    if (!this.#overridesPath) return;
    this.#overrides.clear();
    this.#unknownOverrides = [];
    if (!fs.existsSync(this.#overridesPath)) return;
    try {
      const raw = fs.readFileSync(this.#overridesPath, 'utf8');
      const parsed = featureFlagOverridesFileSchema.parse(JSON.parse(raw));
      for (const item of parsed.overrides) {
        if (this.#byId.has(item.id)) {
          this.#overrides.set(item.id, item.enabled);
        } else {
          // Flag que este build não conhece (salva por versão futura) —
          // preserva para não sumir num downgrade→upgrade.
          this.#unknownOverrides.push({ id: item.id, enabled: item.enabled });
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
      overrides: [
        ...[...this.#overrides.entries()].map(([id, enabled]) => ({
          id,
          enabled,
        })),
        // Reemite entradas de ids desconhecidos ao build atual.
        ...this.#unknownOverrides.filter(
          (u) => !this.#overrides.has(u.id) && !this.#byId.has(u.id),
        ),
      ],
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
 * Enable every built-in product flag for an explicit test run.
 * Normal dev and packaged launches retain fail-closed defaults.
 */
export function enableAllProductFlagsForTesting(): void {
  getFeatureFlagRegistry().forceEnableAll();
}

/** Test-only reset. */
export function resetFeatureFlagRegistryForTests(): void {
  singleton = null;
  singletonOptions = null;
}
