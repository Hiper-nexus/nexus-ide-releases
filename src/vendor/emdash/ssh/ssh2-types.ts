// Minimal structural ssh2 type surface for the vendored emdash SSH modules.
// Nexus-authored — NOT vendored from emdash. ssh2 is an optionalDependency
// loaded through require() at runtime (see src/main/integrations/ssh2-transport.ts)
// and @types/ssh2 is not installed, so the vendored files import these local
// types instead of `from 'ssh2'`. Keep in sync with the ssh2 1.x API surface
// actually used under src/vendor/emdash/ssh/.

import type { Duplex } from 'node:stream';

/** ssh2 ClientChannel: a duplex stream with a separate stderr stream. */
export type ClientChannel = Duplex & { stderr: Duplex };

export type ClientCallback = (err: Error | undefined, channel: ClientChannel) => void;

export type ExecOptions = {
  pty?: boolean | { cols?: number; rows?: number; term?: string };
  env?: Record<string, string>;
  x11?: boolean;
};

/** Opaque SFTP wrapper — the vendored proxy only forwards it to callbacks. */
export type SFTPWrapper = object;

export type ClientSFTPCallback = (err: Error | undefined, sftp: SFTPWrapper) => void;

export type ForwardOutCallback = (err: Error | undefined, channel: ClientChannel) => void;

/** Structural subset of ssh2.Client used by the vendored modules. */
export interface Client {
  exec(command: string, callback: ClientCallback): void;
  exec(command: string, options: ExecOptions, callback: ClientCallback): void;
  sftp(callback: ClientSFTPCallback): void;
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: ForwardOutCallback,
  ): void;
}
