// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/utils/shellEscape.ts
// See src/vendor/emdash/ssh/LICENSE.md. Nexus changes: attribution header only.

/**
 * Shared POSIX shell escaping utility.
 *
 * Uses single-quote wrapping, which prevents all variable expansion,
 * command substitution, and globbing. Embedded single quotes are handled
 * by ending the quoted region, inserting an escaped single quote, and
 * re-opening the quoted region.
 */
export function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function quoteCshArg(arg: string): string {
  return quoteShellArg(arg).replace(/!/g, '\\!');
}

/**
 * Validates that a string is a safe POSIX environment variable name.
 * Must start with a letter or underscore, followed by letters, digits, or underscores.
 */
export function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
