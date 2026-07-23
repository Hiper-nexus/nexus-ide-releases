/**
 * Production SSH transport using optional `ssh2` package.
 * When ssh2 is not installed, createSsh2Transport throws a clear error so
 * unit tests continue using MockSshTransport.
 *
 * Patterns inspired by stablyai/orca ssh-connection-manager @ 143c36e
 * Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
 * See third_party/licenses/orca-MIT.txt.
 */
import type {
  SshConnectOptions,
  SshOperationOptions,
  SshTransport,
} from '../remote/ssh/ssh-session-manager';
import {
  createIdentityFilteredAgent,
} from '../remote/ssh/ssh-identity-filter';
import { hostKeyVerdict, pinHostKey } from '../remote/ssh/known-hosts';
import { buildProxiedConnectFragment } from '../remote/ssh/proxied-connect-config';
import {
  createBoundedSshOperation,
  SshTransportError,
  type BoundedSshOperation,
} from '../remote/ssh/ssh-operation-lifecycle';
import { createSsh2OperationMethods } from './ssh2-transport-operations';
import {
  boundedTimeout,
  clearConnectTimer,
  closeResource,
  errorMessage,
  resolveTimeouts,
  teardownConnection,
  type ConnectionState,
  type PendingOperation,
  type Ssh2Module,
  type Ssh2TransportFactoryOptions,
} from './ssh2-transport-shared';

export type {
  Ssh2TransportFactoryOptions,
  Ssh2TransportTimeouts,
} from './ssh2-transport-shared';

function loadSsh2(): Ssh2Module {
  try {
    // Optional dependency — not all installs ship native ssh2.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ssh2') as Ssh2Module;
  } catch {
    throw new Error(
      'ssh2 package is not installed. Run: npm i ssh2  (or use MockSshTransport in tests)',
    );
  }
}

export function createSsh2Transport(
  factoryOptions: Ssh2TransportFactoryOptions = {},
): SshTransport {
  const ssh2 = loadSsh2();
  const { Client } = ssh2;
  const timeouts = resolveTimeouts(factoryOptions.timeouts);
  let generation = 0;
  let current: ConnectionState | null = null;

  const isCurrent = (state: ConnectionState): boolean => (
    current === state
    && state.generation === generation
    && state.phase === 'connected'
  );

  const failCurrent = (
    state: ConnectionState,
    error: SshTransportError,
  ): void => {
    if (current !== state || state.generation !== generation) return;
    current = null;
    generation += 1;
    teardownConnection(state, error);
  };

  const beginOperation = <T>(
    state: ConnectionState,
    label: string,
    options: SshOperationOptions | undefined,
    defaultTimeoutMs: number,
    outcomeUnknown: boolean,
  ): BoundedSshOperation<T> => {
    const controller = createBoundedSshOperation<T>({
      label,
      timeoutMs: boundedTimeout(options?.timeoutMs, defaultTimeoutMs, label),
      signal: options?.signal,
      outcomeUnknownOnTimeout: outcomeUnknown,
      isGenerationCurrent: () => isCurrent(state),
    });
    const pending: PendingOperation = {
      label,
      outcomeUnknown,
      controller: controller as BoundedSshOperation<unknown>,
    };
    state.operations.add(pending);
    const remove = (): void => {
      state.operations.delete(pending);
    };
    void controller.promise.then(remove, remove);
    return controller;
  };
  const operationMethods = createSsh2OperationMethods({
    timeouts,
    getCurrent: () => current,
    isCurrent,
    beginOperation,
  });

  return {
    async connect(options: SshConnectOptions): Promise<void> {
      const filteredAgent = options.auth.kind === 'agent'
        ? createIdentityFilteredAgent(
            process.env.SSH_AUTH_SOCK ?? '',
            options.auth.allowedFingerprints,
            ssh2,
          )
        : undefined;
      if (current) {
        const previous = current;
        current = null;
        generation += 1;
        teardownConnection(
          previous,
          new SshTransportError(
            'stale_generation',
            'A conexão SSH foi substituída por uma nova geração.',
          ),
        );
      }

      const state: ConnectionState = {
        generation: generation += 1,
        client: new Client(),
        phase: 'connecting',
        proxy: null,
        connectTimer: null,
        connectResolve: null,
        connectReject: null,
        operations: new Set(),
        resources: new Set(),
      };
      current = state;

      await new Promise<void>((resolve, reject) => {
        const c = state.client;
        state.connectResolve = resolve;
        state.connectReject = reject;

        c.on('ready', () => {
          if (
            current !== state
            || state.generation !== generation
            || state.phase !== 'connecting'
          ) {
            closeResource(c);
            return;
          }
          state.phase = 'connected';
          clearConnectTimer(state);
          const complete = state.connectResolve;
          state.connectResolve = null;
          state.connectReject = null;
          complete?.();
        });
        c.on('error', (err: unknown) => {
          failCurrent(
            state,
            new SshTransportError(
              'connection_lost',
              `Conexão SSH falhou: ${errorMessage(err)}. Reconecte manualmente antes de nova operação.`,
              { cause: err },
            ),
          );
        });
        c.on('end', () => {
          failCurrent(
            state,
            new SshTransportError(
              'connection_lost',
              'Conexão SSH encerrada pelo host. Reconecte manualmente antes de nova operação.',
            ),
          );
        });
        c.on('close', () => {
          failCurrent(
            state,
            new SshTransportError(
              'connection_lost',
              'Conexão SSH fechada. Reconecte manualmente antes de nova operação.',
            ),
          );
        });

        const host = options.host;
        const port = options.port ?? 22;
        // ssh2 auto-accepts ANY server host key when hostVerifier is absent
        // (unlike the OpenSSH CLI it reads no known_hosts) — an on-path
        // attacker could silently impersonate the host and capture the
        // session/password. Pin the key on first use and reject a CHANGED key
        // (fail closed). `verify` MUST be called exactly once; returning a
        // value would make ssh2 call it a second time (client.js:284-286).
        // Attached to EVERY connect config below — direct or proxied.
        const hostVerifier = (key: Buffer, verify: (ok: boolean) => void): void => {
          let settled = false;
          const finish = (accepted: boolean): void => {
            if (settled) return;
            settled = true;
            verify(accepted);
          };
          if (
            current !== state
            || state.generation !== generation
            || state.phase !== 'connecting'
          ) {
            finish(false);
            return;
          }
          let assessment: ReturnType<typeof hostKeyVerdict>;
          try {
            assessment = hostKeyVerdict(host, port, key);
          } catch {
            finish(false);
            return;
          }
          if (assessment.verdict === 'match') {
            finish(true);
            return;
          }
          if (assessment.verdict === 'mismatch') {
            // Changed since pinned: possible MITM. Never overridable here.
            finish(false);
            return;
          }
          // Unknown key → trust-on-first-use. An interactive caller confirms
          // the fingerprint; without a hook we pin automatically (accept-new).
          const confirm = options.confirmUnknownHostKey;
          if (!confirm) {
            try {
              pinHostKey(host, port, key);
              finish(true);
            } catch {
              finish(false);
            }
            return;
          }
          let confirmation: boolean | Promise<boolean>;
          try {
            confirmation = confirm({
              host,
              port,
              fingerprint: assessment.fingerprint,
            });
          } catch {
            finish(false);
            return;
          }
          Promise.resolve(confirmation)
            .then((accepted) => {
              if (
                !accepted
                || current !== state
                || state.generation !== generation
                || state.phase !== 'connecting'
              ) {
                finish(false);
                return;
              }
              pinHostKey(host, port, key);
              finish(true);
            })
            .catch(() => finish(false));
        };
        const cfg: Record<string, unknown> = {
          host,
          port,
          username: options.username,
          keepaliveInterval: options.keepaliveIntervalMs ?? 15_000,
          readyTimeout: timeouts.connectMs,
          hostVerifier,
        };
        try {
          if (factoryOptions.proxy) {
            // The pin identity remains the FINAL host even through cfg.sock.
            state.proxy = buildProxiedConnectFragment(
              factoryOptions.proxy,
              { host, port, username: options.username, originalHost: options.host },
              hostVerifier,
              factoryOptions.spawnProcess,
            );
            cfg.sock = state.proxy.sock;
          }
          if (options.auth.kind === 'password') {
            cfg.password = options.auth.password;
          } else if (options.auth.kind === 'privateKey') {
            cfg.privateKey = options.auth.privateKey;
            if (options.auth.passphrase) cfg.passphrase = options.auth.passphrase;
          } else {
            // Never pass SSH_AUTH_SOCK directly: the wrapper filters list+sign.
            cfg.agent = filteredAgent;
          }

          state.connectTimer = setTimeout(() => {
            failCurrent(
              state,
              new SshTransportError(
                'connect_timeout',
                `Conexão SSH excedeu ${timeouts.connectMs}ms e foi encerrada.`,
              ),
            );
          }, timeouts.connectMs);
          state.connectTimer.unref?.();
          c.connect(cfg);
        } catch (error) {
          failCurrent(
            state,
            new SshTransportError(
              'connection_lost',
              `Não foi possível iniciar a conexão SSH: ${errorMessage(error)}`,
              { cause: error },
            ),
          );
        }
      });
    },
    async disconnect(): Promise<void> {
      const state = current;
      current = null;
      generation += 1;
      if (!state) return;
      teardownConnection(
        state,
        new SshTransportError(
          'connection_lost',
          'Conexão SSH desconectada localmente; reconecte antes de nova operação.',
        ),
      );
    },
    isConnected(): boolean {
      return current?.phase === 'connected';
    },
    ...operationMethods,
  };
}

export async function remoteWorktreeCreate(
  transport: SshTransport,
  remotePath: string,
  branch?: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const branchArg = branch ? ` ${shellQuote(branch)}` : '';
  const cmd = `mkdir -p ${shellQuote(remotePath)} && cd ${shellQuote(remotePath)} && (test -d .git || git init) && git rev-parse --is-inside-work-tree${branch ? ` && git checkout -B${branchArg}` : ''}`;
  try {
    const r = await transport.exec(cmd);
    if (r.code !== 0) {
      return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` };
    }
    return { ok: true, path: remotePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
