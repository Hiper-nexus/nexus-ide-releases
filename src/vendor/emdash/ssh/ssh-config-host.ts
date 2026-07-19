// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/shared/core/ssh/ssh.ts (SshConfigHost interface only)
// See src/vendor/emdash/ssh/LICENSE.md. Nexus changes: only the SshConfigHost
// interface is vendored; the rest of upstream's shared SSH contract (IPC
// channel table, connection rows, health types) is not consumed by Nexus.

/**
 * SSH Config Host entry parsed from ~/.ssh/config
 */
export interface SshConfigHost {
  host: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  identityAgent?: string;
  proxyJump?: string;
  proxyCommand?: string;
  forwardAgent?: boolean;
  forwardAgentValue?: string;
}
