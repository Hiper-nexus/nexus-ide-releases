/** Bounded ACP v1 select options used to honor explicit session selections. */
export const ACP_ACCOUNT_SELECTION_UNSUPPORTED = 'ACP harness account selection is not supported: this harness uses its own authentication/profile and cannot bind the selected Nexus account (including a selected default); use the native CLI transport for this account';

export interface AcpSessionConfigOption {
  readonly id: string;
  readonly category?: string;
  readonly currentValue: string;
  readonly values: readonly string[];
}

type ConfigParseResult =
  | { ok: true; value: readonly AcpSessionConfigOption[] }
  | { ok: false; detail: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024;
}

/** Unknown option types are retained by the peer but not selected by Nexus. */
export function parseAcpConfigOptions(raw: unknown): ConfigParseResult {
  if (!Array.isArray(raw) || raw.length > 64) {
    return { ok: false, detail: 'ACP configOptions must be an array of at most 64 options' };
  }
  const options: AcpSessionConfigOption[] = [];
  const ids = new Set<string>();
  for (const option of raw) {
    if (!record(option) || !configString(option.id) || ids.has(option.id)) {
      return { ok: false, detail: 'ACP configOptions contain an invalid or duplicate id' };
    }
    ids.add(option.id);
    if (option.type !== 'select') continue;
    if (!configString(option.currentValue) || !Array.isArray(option.options) ||
        option.options.length > 1_024 ||
        (option.category !== undefined && !configString(option.category))) {
      return { ok: false, detail: 'ACP select option has an invalid current value or options' };
    }
    const values: string[] = [];
    for (const entry of option.options) {
      if (!record(entry)) return { ok: false, detail: 'ACP select value is not an object' };
      const group = Array.isArray(entry.options) ? entry.options : [entry];
      if (group.length > 1_024 || values.length + group.length > 1_024) {
        return { ok: false, detail: 'ACP select option exceeds 1024 values' };
      }
      for (const value of group) {
        if (!record(value) || !configString(value.value) || values.includes(value.value)) {
          return { ok: false, detail: 'ACP select option contains an invalid or duplicate value' };
        }
        values.push(value.value);
      }
    }
    options.push(Object.freeze({
      id: option.id,
      ...(option.category !== undefined ? { category: option.category } : {}),
      currentValue: option.currentValue,
      values: Object.freeze(values),
    }));
  }
  return { ok: true, value: Object.freeze(options) };
}

/** Never guess aliases, names, or unavailable IDs when honoring a request. */
export function requestedAcpConfigOption(
  options: readonly AcpSessionConfigOption[],
  selection: 'model' | 'effort',
  value: string,
): AcpSessionConfigOption {
  if (!configString(value)) throw new Error(`ACP ${selection} selection is invalid`);
  const category = selection === 'model' ? 'model' : 'thought_level';
  const candidates = options.filter((option) =>
    option.category === category ||
    (option.category === undefined && option.id === selection),
  );
  if (candidates.length !== 1) {
    throw new Error(`ACP harness does not advertise one unambiguous ${selection} selector`);
  }
  const option = candidates[0]!;
  if (option.currentValue !== value && !option.values.includes(value)) {
    throw new Error(`ACP harness does not advertise the exact requested ${selection} value`);
  }
  return option;
}
