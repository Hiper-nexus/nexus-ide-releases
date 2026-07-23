/**
 * Bounded ssh2 exec/SFTP/PTY operations.
 *
 * No operation retries itself. Every callback is fenced to the connection
 * generation that created it, and late resources are closed immediately.
 */

import type {
  SshOperationOptions,
  SshTransport,
} from '../remote/ssh/ssh-session-manager';
import {
  SshTransportError,
  type BoundedSshOperation,
} from '../remote/ssh/ssh-operation-lifecycle';
import {
  assertPtyDimensions,
  chunkText,
  closeResource,
  releaseResource,
  requireConnected,
  type ConnectionState,
  type Ssh2TransportTimeouts,
} from './ssh2-transport-shared';

type OperationContext = {
  readonly timeouts: Ssh2TransportTimeouts;
  readonly getCurrent: () => ConnectionState | null;
  readonly isCurrent: (state: ConnectionState) => boolean;
  readonly beginOperation: <T>(
    state: ConnectionState,
    label: string,
    options: SshOperationOptions | undefined,
    defaultTimeoutMs: number,
    outcomeUnknown: boolean,
  ) => BoundedSshOperation<T>;
};

type OperationMethods = Pick<
  SshTransport,
  'exec' | 'readFile' | 'writeFile' | 'listDir' | 'openPty'
>;

export function createSsh2OperationMethods(
  context: OperationContext,
): OperationMethods {
  const { timeouts } = context;
  return {
    exec(command: string, options?: SshOperationOptions) {
      const state = requireConnected(context.getCurrent(), 'exec');
      const operation = context.beginOperation<{
        code: number;
        stdout: string;
        stderr: string;
      }>(state, 'exec', options, timeouts.operationMs, true);
      let stdout = '';
      let stderr = '';
      if (!operation.isActive()) return operation.promise;
      try {
        state.client.exec(command, (error, stream) => {
          if (error || !stream) {
            if (stream) closeResource(stream);
            operation.reject(error ?? new Error('SSH exec não abriu um channel.'));
            return;
          }
          if (!operation.isActive()) {
            closeResource(stream);
            return;
          }
          state.resources.add(stream);
          operation.setCleanup(() => releaseResource(state, stream));
          stream.on('data', (chunk: unknown) => {
            if (operation.isActive()) stdout += chunkText(chunk);
          });
          stream.stderr.on('data', (chunk: unknown) => {
            if (operation.isActive()) stderr += chunkText(chunk);
          });
          stream.on('error', (streamError: unknown) => {
            operation.reject(new SshTransportError(
              'operation_failed',
              'SSH exec perdeu o channel após despacho; verifique o estado remoto antes de repetir.',
              { cause: streamError, outcomeUnknown: true },
            ));
          });
          stream.on('close', (code: unknown) => {
            state.resources.delete(stream);
            if (!operation.isActive()) return;
            operation.resolve({
              code: typeof code === 'number' ? code : 0,
              stdout,
              stderr,
            });
          });
        });
      } catch (error) {
        operation.reject(error);
      }
      return operation.promise;
    },

    readFile(remotePath: string, options?: SshOperationOptions): Promise<string> {
      const state = requireConnected(context.getCurrent(), 'readFile');
      const operation = context.beginOperation<string>(
        state,
        'readFile',
        options,
        timeouts.operationMs,
        false,
      );
      if (!operation.isActive()) return operation.promise;
      try {
        state.client.sftp((error, sftp) => {
          if (error || !sftp) {
            if (sftp) closeResource(sftp);
            operation.reject(error ?? new Error('SSH SFTP indisponível.'));
            return;
          }
          if (!operation.isActive()) {
            closeResource(sftp);
            return;
          }
          state.resources.add(sftp);
          operation.setCleanup(() => releaseResource(state, sftp));
          sftp.readFile(remotePath, (readError, data) => {
            if (!operation.isActive()) return;
            if (readError) {
              operation.reject(readError);
              return;
            }
            releaseResource(state, sftp);
            operation.resolve(data.toString('utf8'));
          });
        });
      } catch (error) {
        operation.reject(error);
      }
      return operation.promise;
    },

    writeFile(
      remotePath: string,
      content: string,
      options?: SshOperationOptions,
    ): Promise<void> {
      const state = requireConnected(context.getCurrent(), 'writeFile');
      const operation = context.beginOperation<void>(
        state,
        'writeFile',
        options,
        timeouts.operationMs,
        true,
      );
      if (!operation.isActive()) return operation.promise;
      try {
        state.client.sftp((error, sftp) => {
          if (error || !sftp) {
            if (sftp) closeResource(sftp);
            operation.reject(error ?? new Error('SSH SFTP indisponível.'));
            return;
          }
          if (!operation.isActive()) {
            closeResource(sftp);
            return;
          }
          state.resources.add(sftp);
          operation.setCleanup(() => releaseResource(state, sftp));
          sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), (writeError) => {
            if (!operation.isActive()) return;
            if (writeError) {
              operation.reject(new SshTransportError(
                'operation_failed',
                'SSH writeFile falhou após despacho; verifique o arquivo remoto antes de repetir.',
                { cause: writeError, outcomeUnknown: true },
              ));
              return;
            }
            releaseResource(state, sftp);
            operation.resolve();
          });
        });
      } catch (error) {
        operation.reject(error);
      }
      return operation.promise;
    },

    listDir(
      remotePath: string,
      options?: SshOperationOptions,
    ): Promise<readonly string[]> {
      const state = requireConnected(context.getCurrent(), 'listDir');
      const operation = context.beginOperation<readonly string[]>(
        state,
        'listDir',
        options,
        timeouts.operationMs,
        false,
      );
      if (!operation.isActive()) return operation.promise;
      try {
        state.client.sftp((error, sftp) => {
          if (error || !sftp) {
            if (sftp) closeResource(sftp);
            operation.reject(error ?? new Error('SSH SFTP indisponível.'));
            return;
          }
          if (!operation.isActive()) {
            closeResource(sftp);
            return;
          }
          state.resources.add(sftp);
          operation.setCleanup(() => releaseResource(state, sftp));
          sftp.readdir(remotePath, (readError, list) => {
            if (!operation.isActive()) return;
            if (readError) {
              operation.reject(readError);
              return;
            }
            releaseResource(state, sftp);
            operation.resolve(list.map((entry) => entry.filename));
          });
        });
      } catch (error) {
        operation.reject(error);
      }
      return operation.promise;
    },

    openPty(cols: number, rows: number, options?: SshOperationOptions) {
      const state = requireConnected(context.getCurrent(), 'openPty');
      assertPtyDimensions(cols, rows);
      const operation = context.beginOperation<{
        write: (data: string) => void;
        onData: (cb: (data: string) => void) => void;
        resize: (nextCols: number, nextRows: number) => void;
        close: () => void;
      }>(state, 'openPty', options, timeouts.ptyOpenMs, false);
      if (!operation.isActive()) return operation.promise;
      try {
        state.client.shell(
          { term: 'xterm-256color', cols, rows, width: 0, height: 0 },
          (error, channel) => {
            if (error || !channel) {
              if (channel) closeResource(channel);
              operation.reject(error ?? new Error('SSH shell PTY não abriu.'));
              return;
            }
            if (!operation.isActive()) {
              closeResource(channel);
              return;
            }
            state.resources.add(channel);
            operation.setCleanup(() => releaseResource(state, channel));
            let closed = false;
            let dataCallback: ((data: string) => void) | null = null;
            const assertLive = (action: string): void => {
              if (closed || !context.isCurrent(state)) {
                throw new SshTransportError(
                  'connection_lost',
                  `PTY SSH indisponível para ${action}; reconecte e abra um novo terminal.`,
                );
              }
            };
            channel.on('data', (chunk: unknown) => {
              if (!closed && context.isCurrent(state)) {
                dataCallback?.(chunkText(chunk));
              }
            });
            channel.on('error', () => {
              closed = true;
              dataCallback = null;
              state.resources.delete(channel);
              closeResource(channel);
            });
            channel.on('close', () => {
              closed = true;
              dataCallback = null;
              state.resources.delete(channel);
            });
            operation.resolve({
              write(data) {
                assertLive('escrita');
                channel.write(data);
              },
              onData(callback) {
                assertLive('assinatura de saída');
                dataCallback = callback;
              },
              resize(nextCols, nextRows) {
                assertLive('resize');
                assertPtyDimensions(nextCols, nextRows);
                channel.setWindow(nextRows, nextCols, 0, 0);
              },
              close() {
                if (closed) return;
                closed = true;
                dataCallback = null;
                releaseResource(state, channel);
              },
            });
          },
        );
      } catch (error) {
        operation.reject(error);
      }
      return operation.promise;
    },
  };
}
