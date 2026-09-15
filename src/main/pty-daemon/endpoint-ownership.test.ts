import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimDaemonEndpoint,
  releaseDaemonEndpoint,
} from './endpoint-ownership';

// Fase 0 — contrato de teste do protocolo de posse (spec
// docs/architecture/pty-daemon-spec.md). Guard rails: tmpdir, sem Electron,
// sem processo detached — o coração do protocolo isolado.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptyd-fase0-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Listener de verdade: aceita conexão, RESPONDE ao probe e segura o socket. */
async function realListener(socketPath: string): Promise<{
  close: () => Promise<void>;
}> {
  const { createServer } = await import('node:net');
  const server = createServer((socket) => {
    // The probe destroys the client as soon as it receives the greeting;
    // Node reports that peer reset asynchronously on the incumbent socket.
    socket.once('error', () => {});
    socket.write('live\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Ocupante que CRASHA deixando o arquivo do socket no chão. O close() limpo
 * do Node faz unlink automático — só um SIGKILL reproduz o cenário real do
 * spec (daemon morto sem shutdown, arquivo órfão presente).
 */
async function dieLeavingSocketFile(socketPath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer(()=>{}).listen(${JSON.stringify(socketPath)},()=>{console.log('READY');setInterval(()=>{},1000);});`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  for (let i = 0; i < 100 && !existsSync(socketPath); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!existsSync(socketPath)) {
    child.kill('SIGKILL');
    throw new Error('setup: socket do ocupante nunca apareceu');
  }
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('claimDaemonEndpoint (Fase 0)', () => {
  it('1. posse limpa: dir vazio → link privado→público → claimed e o público ACEITA conexão', async () => {
    const publicPath = join(dir, 'nexus.ptyd.sock');
    const claim = await claimDaemonEndpoint({ publicPath });

    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    expect(claim.socketPath).toBe(publicPath);

    // O endpoint público precisa aceitar conexão de verdade.
    const net = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(publicPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });

    await releaseDaemonEndpoint(claim);
  });

  it('2. incumbente vivo: link EEXIST → connect responde → incumbent-live, o nascido se suicida e o público continua do primeiro', async () => {
    const publicPath = join(dir, 'nexus.ptyd.sock');
    const incumbent = await realListener(publicPath);

    const second = await claimDaemonEndpoint({ publicPath });
    expect(second.kind).toBe('incumbent-live');

    // O público continua aceitando conexão (do incumbente).
    const net = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(publicPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });

    await incumbent.close();
  });

  it('3. incumbente morto por conexão: arquivo órfão → connect recusado → rename → claimed e a conexão vai pro novo', async () => {
    const publicPath = join(dir, 'nexus.ptyd.sock');
    await dieLeavingSocketFile(publicPath);
    // Ocupante saiu de cena: ninguém ouvindo, arquivo presente.
    expect(statSync(publicPath).isSocket()).toBe(true);

    const claim = await claimDaemonEndpoint({ publicPath });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const net = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(publicPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });

    await releaseDaemonEndpoint(claim);
  });

  it('4a. nunca colapsar "não sei" em "morto": socket que aceita e não responde → unverifiable', async () => {
    const publicPath = join(dir, 'nexus.ptyd.sock');
    // Socket que aceita o connect TCP mas nunca responde nada (timeout da
    // prova). O listener de baixo nível aceita e cala.
    const { createServer } = await import('node:net');
    const server = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(publicPath, resolve);
    });

    const claim = await claimDaemonEndpoint({
      publicPath,
      probeTimeoutMs: 400,
    });
    expect(claim.kind).toBe('unverifiable');
    if (claim.kind === 'unverifiable') {
      expect(claim.reason.length).toBeGreaterThan(0);
    }
    // O endpoint público NÃO foi tomado: continua sendo o socket mudo.
    expect(statSync(publicPath).isSocket()).toBe(true);

    server.close();
  });

  it('4b. nunca colapsar "não sei" em "morto": socket EACCES → unverifiable', async () => {
    const publicPath = join(dir, 'nexus.ptyd.sock');
    const holder = await realListener(publicPath);
    const { chmodSync } = await import('node:fs');
    chmodSync(publicPath, 0o000);

    const claim = await claimDaemonEndpoint({
      publicPath,
      probeTimeoutMs: 400,
    });
    expect(claim.kind).toBe('unverifiable');

    chmodSync(publicPath, 0o666);
    await holder.close();
  });

  it('5. releaseDaemonEndpoint NUNCA faz unlink do público — o sucessor prova e renomeia', async () => {
    const publicPath = join(dir, 'nexus.ptyd.sock');
    const claim = await claimDaemonEndpoint({ publicPath });
    if (claim.kind !== 'claimed') throw new Error('setup: claim falhou');

    await releaseDaemonEndpoint(claim);
    // O arquivo do endpoint público continua no chão.
    expect(statSync(publicPath).isSocket()).toBe(true);
  });

  it('6. sem sweeper: nenhum timer no módulo (propriedade estrutural por inspecção de exports)', async () => {
    const mod = await import('./endpoint-ownership');
    const names = Object.keys(mod).sort();
    expect(names).toEqual([
      'claimDaemonEndpoint',
      'releaseDaemonEndpoint',
    ]);
  });
});
