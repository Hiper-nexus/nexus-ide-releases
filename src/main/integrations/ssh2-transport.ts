/**
 * Production SSH transport using optional `ssh2` package.
 * When ssh2 is not installed, createSsh2Transport throws a clear error so
 * unit tests continue using MockSshTransport.
 *
 * Patterns inspired by stablyai/orca ssh-connection-manager @ 143c36e
 * Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
 * See third_party/licenses/orca-MIT.txt.
 */
import type { SshConnectOptions, SshTransport } from '../remote/ssh/ssh-session-manager';
import { hostKeyVerdict, pinHostKey } from '../remote/ssh/known-hosts';

type Ssh2Client = {
  on(event: string, cb: (...args: unknown[]) => void): void;
  connect(cfg: Record<string, unknown>): void;
  end(): void;
  exec(
    command: string,
    cb: (err: Error | undefined, stream: NodeJS.ReadableStream & {
      stderr: NodeJS.ReadableStream;
      on(event: string, cb: (...args: unknown[]) => void): void;
    }) => void,
  ): void;
  sftp(
    cb: (
      err: Error | undefined,
      sftp: {
        readFile(path: string, cb: (err: Error | undefined, data: Buffer) => void): void;
        writeFile(path: string, data: Buffer, cb: (err: Error | undefined) => void): void;
        readdir(
          path: string,
          cb: (err: Error | undefined, list: Array<{ filename: string }>) => void,
        ): void;
      },
    ) => void,
  ): void;
};

function loadSsh2(): { Client: new () => Ssh2Client } {
  try {
    // Optional dependency — not all installs ship native ssh2.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ssh2') as { Client: new () => Ssh2Client };
  } catch {
    throw new Error(
      'ssh2 package is not installed. Run: npm i ssh2  (or use MockSshTransport in tests)',
    );
  }
}

export function createSsh2Transport(): SshTransport {
  const { Client } = loadSsh2();
  let client: Ssh2Client | null = null;
  let connected = false;

  return {
    async connect(options: SshConnectOptions): Promise<void> {
      client = new Client();
      await new Promise<void>((resolve, reject) => {
        const c = client!;
        c.on('ready', () => {
          connected = true;
          resolve();
        });
        c.on('error', (err: unknown) => {
          connected = false;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        const host = options.host;
        const port = options.port ?? 22;
        const cfg: Record<string, unknown> = {
          host,
          port,
          username: options.username,
          keepaliveInterval: options.keepaliveIntervalMs ?? 15_000,
          // ssh2 auto-accepts ANY server host key when hostVerifier is absent
          // (unlike the OpenSSH CLI it reads no known_hosts) — an on-path
          // attacker could silently impersonate the host and capture the
          // session/password. Pin the key on first use and reject a CHANGED key
          // (fail closed). `verify` MUST be called exactly once; returning a
          // value would make ssh2 call it a second time (client.js:284-286).
          hostVerifier: (key: Buffer, verify: (ok: boolean) => void): void => {
            let assessment: ReturnType<typeof hostKeyVerdict>;
            try {
              assessment = hostKeyVerdict(host, port, key);
            } catch {
              verify(false);
              return;
            }
            if (assessment.verdict === 'match') {
              verify(true);
              return;
            }
            if (assessment.verdict === 'mismatch') {
              // Changed since pinned: possible MITM. Never overridable here.
              verify(false);
              return;
            }
            // Unknown key → trust-on-first-use. An interactive caller confirms
            // the fingerprint; without a hook we pin automatically (accept-new).
            const confirm = options.confirmUnknownHostKey;
            if (!confirm) {
              try {
                pinHostKey(host, port, key);
                verify(true);
              } catch {
                verify(false);
              }
              return;
            }
            Promise.resolve(
              confirm({ host, port, fingerprint: assessment.fingerprint }),
            )
              .then((accepted) => {
                if (!accepted) {
                  verify(false);
                  return;
                }
                pinHostKey(host, port, key);
                verify(true);
              })
              .catch(() => verify(false));
          },
        };
        if (options.auth.kind === 'password') {
          cfg.password = options.auth.password;
        } else if (options.auth.kind === 'privateKey') {
          cfg.privateKey = options.auth.privateKey;
          if (options.auth.passphrase) cfg.passphrase = options.auth.passphrase;
        } else {
          cfg.agent = process.env.SSH_AUTH_SOCK;
          // Fingerprint allowlist enforced by session manager before connect.
        }
        c.connect(cfg);
      });
    },
    async disconnect(): Promise<void> {
      connected = false;
      try {
        client?.end();
      } catch {
        // ignore
      }
      client = null;
    },
    isConnected(): boolean {
      return connected;
    },
    async exec(command: string) {
      const c = client;
      if (!c || !connected) throw new Error('ssh not connected');
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        c.exec(command, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          });
          stream.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
          stream.on('close', (code: number) => {
            resolve({ code: code ?? 0, stdout, stderr });
          });
        });
      });
    },
    async readFile(remotePath: string): Promise<string> {
      const c = client;
      if (!c || !connected) throw new Error('ssh not connected');
      return new Promise((resolve, reject) => {
        c.sftp((err, sftp) => {
          if (err) {
            reject(err);
            return;
          }
          sftp.readFile(remotePath, (e, data) => {
            if (e) reject(e);
            else resolve(data.toString('utf8'));
          });
        });
      });
    },
    async writeFile(remotePath: string, content: string): Promise<void> {
      const c = client;
      if (!c || !connected) throw new Error('ssh not connected');
      return new Promise((resolve, reject) => {
        c.sftp((err, sftp) => {
          if (err) {
            reject(err);
            return;
          }
          sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), (e) => {
            if (e) reject(e);
            else resolve();
          });
        });
      });
    },
    async listDir(remotePath: string): Promise<readonly string[]> {
      const c = client;
      if (!c || !connected) throw new Error('ssh not connected');
      return new Promise((resolve, reject) => {
        c.sftp((err, sftp) => {
          if (err) {
            reject(err);
            return;
          }
          sftp.readdir(remotePath, (e, list) => {
            if (e) reject(e);
            else resolve(list.map((x) => x.filename));
          });
        });
      });
    },
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
