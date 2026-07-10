import type {
  BrowserDesignFramework,
  BrowserDesignFrameworkHints,
  BrowserDesignSourceHint,
} from '../shared/browser-design';

/**
 * L1 framework introspection (VISUAL-EDIT-001, Fase 1). Framework expandos
 * (`__reactFiber$*`, `__vueParentComponent`, `__svelte_meta`) only exist in the
 * page's MAIN world — invisible from this isolated preload (spike Fase 0.4).
 * The bridge: mark the picked element with a transient nonce ATTRIBUTE (DOM is
 * shared across worlds), evaluate a read-only probe via
 * `webFrame.executeJavaScript`, then remove the marker. The probe result is
 * page-controlled data: sanitize here AND validate with zod in the main
 * process. Best-effort by contract — any failure degrades to L0.
 */

type BrowserDomWindow = Window & typeof globalThis;

export const FRAMEWORK_PROBE_ATTR = 'data-nexus-design-probe';

/** Injection guard: the nonce is interpolated into main-world source. */
const NONCE_PATTERN = /^[A-Za-z0-9]{4,64}$/;

const MAX_OWNER_CHAIN = 10;
const MAX_NAME_CHARS = 128;
const MAX_PROP_KEYS = 32;
const MAX_PROP_KEY_CHARS = 64;
const MAX_FILE_CHARS = 1_024;
const MAX_LINE = 10_000_000;
const DEFAULT_TIMEOUT_MS = 250;

const FRAMEWORKS = new Set<BrowserDesignFramework>([
  'react',
  'vue',
  'svelte',
  'angular',
  'unknown',
]);

export type MainWorldEvaluator = (source: string) => Promise<unknown>;

export function buildFrameworkProbeSource(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('invalid framework probe nonce');
  }
  // Plain ES2017, fully try/caught: this string runs inside an arbitrary
  // user page. It only READS dev metadata and returns JSON-serializable data.
  return `(() => {
  try {
    const el = document.querySelector('[${FRAMEWORK_PROBE_ATTR}="${nonce}"]');
    if (!el) return null;

    let fiberKey = null;
    const keys = Object.keys(el);
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].indexOf('__reactFiber$') === 0) { fiberKey = keys[i]; break; }
    }
    if (fiberKey) {
      const owners = [];
      let propKeys = null;
      let fiber = el[fiberKey];
      for (let depth = 0; fiber && depth < 32 && owners.length < ${MAX_OWNER_CHAIN}; depth += 1) {
        const type = fiber.type;
        let name = null;
        if (typeof type === 'function') {
          name = type.displayName || type.name || null;
        } else if (type && typeof type === 'object') {
          name = type.displayName ||
            (type.render && type.render.name) ||
            (type.type && (type.type.displayName || type.type.name)) || null;
        }
        if (name) {
          owners.push(String(name));
          if (!propKeys && fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
            propKeys = [];
            const propNames = Object.keys(fiber.memoizedProps);
            for (let i = 0; i < propNames.length; i += 1) {
              if (propNames[i] === 'children') continue;
              propKeys.push(propNames[i]);
              if (propKeys.length >= ${MAX_PROP_KEYS}) break;
            }
          }
        }
        fiber = fiber.return;
      }
      const hints = { framework: 'react', ownerChain: owners };
      if (owners.length) hints.componentName = owners[0];
      if (propKeys && propKeys.length) hints.propKeys = propKeys;
      return hints;
    }

    const vueComponent = el.__vueParentComponent;
    if (vueComponent && vueComponent.type) {
      const name = vueComponent.type.__name || vueComponent.type.name || null;
      const file = vueComponent.type.__file || null;
      const hints = { framework: 'vue', ownerChain: name ? [String(name)] : [] };
      if (name) hints.componentName = String(name);
      if (file) hints.source = { file: String(file) };
      return hints;
    }

    const svelteMeta = el.__svelte_meta;
    if (svelteMeta && svelteMeta.loc && svelteMeta.loc.file) {
      const loc = svelteMeta.loc;
      const source = { file: String(loc.file) };
      if (typeof loc.line === 'number') source.line = loc.line;
      if (typeof loc.column === 'number') source.column = loc.column;
      return { framework: 'svelte', ownerChain: [], source };
    }

    const ng = globalThis.ng;
    if (ng && typeof ng.getComponent === 'function') {
      const component = ng.getComponent(el);
      const name = component && component.constructor && component.constructor.name;
      if (name) {
        return {
          framework: 'angular',
          componentName: String(name),
          ownerChain: [String(name)],
        };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
})()`;
}

/**
 * Clamp/validate the raw probe result. The page owns the main world, so this
 * payload is untrusted: wrong shapes are dropped, oversized values clamped to
 * the same caps enforced by browser-design-schema in the main process.
 */
export function sanitizeFrameworkHints(
  raw: unknown,
): BrowserDesignFrameworkHints | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  if (
    typeof input.framework !== 'string' ||
    !FRAMEWORKS.has(input.framework as BrowserDesignFramework)
  ) {
    return undefined;
  }
  const hints: BrowserDesignFrameworkHints = {
    framework: input.framework as BrowserDesignFramework,
    ownerChain: Array.isArray(input.ownerChain)
      ? input.ownerChain
          .filter((name): name is string => typeof name === 'string' && name.length > 0)
          .slice(0, MAX_OWNER_CHAIN)
          .map((name) => name.slice(0, MAX_NAME_CHARS))
      : [],
  };
  if (typeof input.componentName === 'string' && input.componentName) {
    hints.componentName = input.componentName.slice(0, MAX_NAME_CHARS);
  }
  if (Array.isArray(input.propKeys)) {
    const propKeys = input.propKeys
      .filter((key): key is string => typeof key === 'string' && key.length > 0)
      .slice(0, MAX_PROP_KEYS)
      .map((key) => key.slice(0, MAX_PROP_KEY_CHARS));
    if (propKeys.length) hints.propKeys = propKeys;
  }
  if (input.source && typeof input.source === 'object' && !Array.isArray(input.source)) {
    const source = input.source as Record<string, unknown>;
    if (typeof source.file === 'string' && source.file) {
      const sourceHint: BrowserDesignSourceHint = {
        file: source.file.slice(0, MAX_FILE_CHARS),
      };
      if (isBoundedInt(source.line)) sourceHint.line = source.line;
      if (isBoundedInt(source.column)) sourceHint.column = source.column;
      hints.source = sourceHint;
    }
  }
  return hints;
}

function isBoundedInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_LINE
  );
}

function makeNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const raw = uuid ?? `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return raw.replace(/-/g, '');
}

export async function introspectElementFrameworks(
  win: BrowserDomWindow,
  element: Element,
  evalInMainWorld: MainWorldEvaluator,
  options: { timeoutMs?: number } = {},
): Promise<BrowserDesignFrameworkHints | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nonce = makeNonce();
  element.setAttribute(FRAMEWORK_PROBE_ATTR, nonce);
  try {
    const raw = await Promise.race([
      evalInMainWorld(buildFrameworkProbeSource(nonce)),
      // A hung/blocked main world must never freeze the picker.
      new Promise<undefined>((resolve) => {
        win.setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    return raw == null ? undefined : sanitizeFrameworkHints(raw);
  } catch {
    return undefined;
  } finally {
    // Rule: never leave attributes behind in the user's DOM.
    element.removeAttribute(FRAMEWORK_PROBE_ATTR);
  }
}
