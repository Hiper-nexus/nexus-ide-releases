// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/ssh/lifecycle/ssh-client-proxy.ts
// See src/vendor/emdash/ssh/LICENSE.md. Nexus changes:
//  - `ssh2` type imports repointed to the local minimal ./ssh2-types surface
//    (@types/ssh2 is not installed; ssh2 is an optionalDependency loaded via
//    require() at runtime).
//  - The remote-shell-profile capture/cache layer (getRemoteShellProfile/
//    refreshRemoteShellProfile and the RemoteShellProfileState machine) is NOT
//    vendored: it pulls emdash's execution-context/userEnv/terminal-settings
//    module web. The parts Nexus consumes are the reconnect-surviving stable
//    client reference and the channel health reporting below. Re-add the
//    profile layer together with its dependencies if a future wave needs
//    remote env capture for remote panes.

import type { Client, ClientCallback, ClientSFTPCallback, ExecOptions } from './ssh2-types';

/**
 * Stable reference to an ssh2 Client that survives reconnects.
 *
 * Services like a remote filesystem or remote git hold a SshClientProxy
 * rather than a raw Client. The connection owner calls update() each time
 * a connection is established (including after reconnect) and invalidate()
 * when the connection drops. Callers that access proxy.client at call time
 * therefore always get the current live Client without needing to be
 * rebuilt or replaced.
 */
export class SshClientProxy {
  private _client: Client | null = null;

  constructor(
    readonly connectionId: string,
    private healthReporter?: { reportChannelError(connectionId: string, error: unknown): void }
  ) {}

  /** Called by the connection owner when a connection becomes ready. */
  update(client: Client): void {
    this._client = client;
  }

  exec(command: string, callback: ClientCallback): void;
  exec(command: string, options: ExecOptions, callback: ClientCallback): void;
  exec(
    command: string,
    optionsOrCallback: ExecOptions | ClientCallback,
    callback?: ClientCallback
  ): void {
    const wrappedCallback = this.wrapClientCallback(
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    );

    if (typeof optionsOrCallback === 'function') {
      this.client.exec(command, wrappedCallback);
      return;
    }

    this.client.exec(command, optionsOrCallback, wrappedCallback);
  }

  execPty(command: string, options: ExecOptions, callback: ClientCallback): void {
    this.client.exec(command, options, this.wrapClientCallback(callback));
  }

  sftp(callback: ClientSFTPCallback): void {
    this.client.sftp((err, sftp) => {
      this.reportChannelResult(err);
      callback(err, sftp);
    });
  }

  private wrapClientCallback(callback: ClientCallback | undefined): ClientCallback {
    return (err, channel) => {
      this.reportChannelResult(err);
      callback?.(err, channel);
    };
  }

  private reportChannelResult(err: Error | undefined): void {
    if (err) {
      this.healthReporter?.reportChannelError(this.connectionId, err);
      return;
    }
  }

  /** Called by the connection owner when the connection drops. */
  invalidate(): void {
    this._client = null;
  }

  /**
   * The live ssh2 Client. Throws if the connection is not currently
   * established. Callers should check isConnected first if they want to
   * avoid throwing.
   */
  get client(): Client {
    if (!this._client) {
      throw new Error('SSH connection is not available');
    }
    return this._client;
  }

  /** True while an active connection is held. */
  get isConnected(): boolean {
    return this._client !== null;
  }
}
