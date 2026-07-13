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

  // Effort: drop unknown levels. Assignment-style flags (`-c key=`) MUST get a
  // concrete value — empty `model_reasoning_effort=` makes Codex refuse to boot
  // ("reasoning_effort must not be empty"). Space-style flags (`--effort`) may
  // stay omitted so the CLI keeps its own default.
  if (control.effort) {
    const levels = control.effort.levels;
    const effortArg = control.effort.arg.trim();
    const assignmentStyle = effortArg.endsWith('=');
    let effort = choice.effort?.trim() ?? '';
    if (effort && levels.length > 0 && !levels.includes(effort)) {
      effort = '';
    }
    if (!effort && assignmentStyle && levels.length > 0) {
      effort = levels.includes('medium') ? 'medium' : levels[0]!;
    }
    if (effort && (levels.length === 0 || levels.includes(effort))) {
      const effortArgs = effortArg.split(/\s+/).filter(Boolean);
      const valueSlot = effortArgs.at(-1);
      if (valueSlot?.endsWith('=')) {
        effortArgs[effortArgs.length - 1] = `${valueSlot}${effort}`;
        out.push(...effortArgs);
      } else {
        out.push(...effortArgs, effort);
      }
    }
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

/** Product default: strongest native automatic mode advertised by this CLI. */
export function defaultPermissionMode(adapter: CliPtyAdapter): string {
  const permission = adapter.control?.permission;
  if (!permission) return '';
  // The standalone yolo entry is each adapter's verified full-bypass flag.
  // Claude 2.1.x maps it to --dangerously-skip-permissions, which activates
  // the same bypassPermissions mode immediately (the --allow-* flag does not).
  if (permission.yolo.length > 0) return 'yolo';
  if (permission.modes.bypass) return 'bypass';
  if (permission.modes.auto) return 'auto';
  return '';
}

export function availableEfforts(adapter: CliPtyAdapter): string[] {
  return adapter.control?.effort?.levels ?? [];
}

export function supportsVerbose(adapter: CliPtyAdapter): boolean {
  return Boolean(adapter.control?.verbose);
}
