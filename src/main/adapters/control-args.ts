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
  const mode = choice.permissionMode ?? perm?.default ?? '';
  if (perm && mode) {
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

/** Product default: run providers hands-free unless the user opts back out. */
export function defaultPermissionMode(adapter: CliPtyAdapter): string {
  const modes = availablePermissionModes(adapter);
  if (modes.includes('yolo')) return 'yolo';
  if (modes.includes('bypass')) return 'bypass';
  return '';
}

export function availableEfforts(adapter: CliPtyAdapter): string[] {
  return adapter.control?.effort?.levels ?? [];
}

export function supportsVerbose(adapter: CliPtyAdapter): boolean {
  return Boolean(adapter.control?.verbose);
}
