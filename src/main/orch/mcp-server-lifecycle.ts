import type http from 'node:http';
import type { AddressInfo } from 'node:net';

const MCP_LOOPBACK_HOST = '127.0.0.1';

type Disposer = () => void;
type EventTapInstaller = (
  track: (dispose: Disposer) => void,
) => void;

function disposeAll(disposers: readonly Disposer[]): void {
  const errors: unknown[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'failed to dispose MCP event taps',
    );
  }
}

/**
 * Owns exactly one generation of process-wide PTY taps.
 *
 * MCP startup is retried in-process. Replacing the generation first removes
 * every listener installed by the previous attempt, preventing duplicate
 * data/state/exit delivery. A partially installed generation is rolled back.
 */
export class ReplaceableEventTapScope {
  private disposers: Disposer[] = [];

  replace(install: EventTapInstaller): void {
    this.dispose();
    const next: Disposer[] = [];
    try {
      install((dispose) => {
        next.push(dispose);
      });
      this.disposers = next;
    } catch (error) {
      try {
        disposeAll(next);
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'failed to install and roll back MCP event taps',
        );
      }
      throw error;
    }
  }

  dispose(): void {
    const current = this.disposers;
    this.disposers = [];
    disposeAll(current);
  }
}

/**
 * Binds an HTTP server to the Nexus-only loopback endpoint.
 *
 * `Server.listen()` reports bind/DNS failures through its `error` event, not
 * its callback. Observing both terminal events guarantees the startup promise
 * settles so the orchestration supervisor can retry.
 */
export function listenOnLoopback(
  candidate: http.Server,
  requestedPort = 0,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let hasSettled = false;

    const cleanup = (): void => {
      candidate.off('error', onError);
      candidate.off('listening', onListening);
    };
    const rejectOnce = (error: unknown): void => {
      if (hasSettled) return;
      hasSettled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => {
      rejectOnce(error);
    };
    const onListening = (): void => {
      if (hasSettled) return;
      const address = candidate.address();
      if (!address || typeof address === 'string') {
        rejectOnce(
          new Error('embedded MCP server has no TCP listen address'),
        );
        return;
      }
      hasSettled = true;
      cleanup();
      resolve((address as AddressInfo).port);
    };

    candidate.once('error', onError);
    candidate.once('listening', onListening);
    try {
      candidate.listen(requestedPort, MCP_LOOPBACK_HOST);
    } catch (error) {
      rejectOnce(error);
    }
  });
}
