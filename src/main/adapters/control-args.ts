import type { CliPtyAdapter } from '../../shared/adapter-types';

/**
 * Build the extra CLI args for a spawn from an adapter's declarative `control`
 * block and the user's chosen settings (permission mode, reasoning effort,
 * verbose). Pure — unit tested. Empty/absent choices fall back to the adapter's
 * default (or the CLI's own default = no flag), so a provider never gets a flag
 * it doesn't understand.
 */

export interface ControlChoice {
  /** Permission mode key ('' = CLI default; 'yolo'/'bypass'/'auto'/…). */
  permissionMode?: string;
  /** Reasoning effort level ('' = CLI default). */
  effort?: string;
  verbose?: boolean;
}

export function buildControlArgs(
  adapter: CliPtyAdapter,
  choice: ControlChoice,
): string[] {
  const out: string[] = [];
  const control = adapter.control ?? {};

  const perm = control.permission;
  const mode = choice.permissionMode ?? '';
  if (perm && !mode) {
    // An explicit safe baseline wins over user-level CLI configuration. This
    // keeps a globally configured danger-full-access/bypass from leaking into
    // Nexus panes when the Nexus setting says "Padrão seguro".
    out.push(...(perm.safe ?? []));
  } else if (perm && mode) {
    // "yolo" always maps to the standalone full-auto args when the adapter
    // declares them; otherwise fall back to the arg+value mode.
    if (mode === 'yolo' && perm.yolo.length > 0) {
      out.push(...perm.yolo);
    } else if (perm.arg && perm.modes[mode]) {
      out.push(perm.arg, perm.modes[mode]);
    } else if (mode === 'bypass' && perm.yolo.length > 0) {
      out.push(...perm.yolo);
    }
  }

  const effort = choice.effort ?? '';
  if (control.effort && effort && control.effort.levels.includes(effort)) {
    out.push(control.effort.arg, effort);
  }

  if (choice.verbose && control.verbose) {
    out.push(control.verbose);
  }

  return out;
}

/** The permission modes a provider offers in the UI (adapter-declared). */
export function availablePermissionModes(adapter: CliPtyAdapter): string[] {
  const perm = adapter.control?.permission;
  if (!perm) return [];
  const modes = Object.keys(perm.modes);
  if (perm.yolo.length > 0 && !modes.includes('yolo')) modes.push('yolo');
  return modes;
}

/** Product default: safe baseline; full-auto is an explicit confirmed opt-in. */
export function defaultPermissionMode(_adapter: CliPtyAdapter): string {
  return '';
}

export function availableEfforts(adapter: CliPtyAdapter): string[] {
  return adapter.control?.effort?.levels ?? [];
}

export function supportsVerbose(adapter: CliPtyAdapter): boolean {
  return Boolean(adapter.control?.verbose);
}
