/**
 * PTY daemon — Fase 0: o protocolo de posse do endpoint (docs/architecture/
 * pty-daemon-spec.md). Socket puro sobre node:net, SEM Electron e sem
 * processo detached: é o coração do protocolo isolado para travá-lo em teste.
 *
 * Doutrina (Orca + lições do revival do Nexus):
 *  - bind privado → link() exclusivo → só um dono nasce quando o caminho
 *    público está livre;
 *  - incumbente é provado POR CONEXÃO (respondeu = vivo), nunca por
 *    heurística de arquivo ou timestamp;
 *  - "não sei" NUNCA colapsa em "morto": timeout de probe ou EACCES é
 *    `unverifiable` e o nascido se suicida em vez de tomar o endpoint;
 *  - morte é provada por conexão recusada (ECONNREFUSED/ENOENT) e a
 *    sucessão é um rename() atômico do privado sobre o público;
 *  - o endpoint público NUNCA é removido no shutdown — não existe
 *    sweeper; a sucessão é sempre por evento (nascer→provar→substituir).
 */

import { link, rename, rm } from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

export type EndpointClaim =
  | { readonly kind: 'claimed'; readonly socketPath: string }
  | { readonly kind: 'incumbent-live'; readonly socketPath: string }
  | { readonly kind: 'unverifiable'; readonly reason: string };

/** O que um dono vivo escreve na conexão: a resposta que o probe espera. */
const ENDPOINT_GREETING = 'nexus-ptyd\n';

/**
 * Listeners detidos por claim — release fecha o listener, mas JAMAIS toca o
 * arquivo do endpoint público (o sucessor prova e renomeia).
 */
const listenersByPublicPath = new Map<string, net.Server>();

/** Socket privado efêmero deste processo dentro do diretório do endpoint. */
function privateSocketPath(publicPath: string): string {
  return path.join(
    path.dirname(publicPath),
    `.ptyd.${process.pid}.sock`,
  );
}

type ProbeResult =
  | { readonly kind: 'live' }
  | { readonly kind: 'dead' }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Prova de vida por conexão: qualquer byte dentro do timeout é vida;
 * conexão recusada é morte física; todo outro desenlace (timeout em socket
 * que aceita, EACCES, erro de transporte) é "não sei" e NUNCA autoriza
 * takeover.
 */
function probeEndpoint(
  publicPath: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.connect(publicPath);
    const finish = (result: ProbeResult): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      finish({
        kind: 'unknown',
        reason: `probe timeout: endpoint aceitou a conexão e nunca respondeu em ${timeoutMs}ms`,
      }),
    );
    socket.once('data', () => finish({ kind: 'live' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        finish({ kind: 'dead' });
        return;
      }
      finish({
        kind: 'unknown',
        reason: `probe ${err.code ?? 'error'}: ${err.message}`,
      });
    });
  });
}

async function destroyPrivateEndpoint(
  server: net.Server,
  privatePath: string,
): Promise<void> {
  server.close();
  await rm(privatePath, { force: true });
}

export async function claimDaemonEndpoint(input: {
  readonly publicPath: string;
  readonly probeTimeoutMs?: number;
}): Promise<EndpointClaim> {
  const publicPath = input.publicPath;
  const probeTimeoutMs = input.probeTimeoutMs ?? 1500;
  const privatePath = privateSocketPath(publicPath);
  // O privado é propriedade exclusiva deste processo: limpar resíduo de um
  // claim anterior do mesmo pid é seguro (o público é intocável aqui).
  await rm(privatePath, { force: true });

  const server = net.createServer((socket) => {
    try {
      socket.write(ENDPOINT_GREETING);
    } catch {
      // Cliente foi embora entre accept e write: nada a fazer.
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(privatePath, resolve);
  });

  try {
    await link(privatePath, publicPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      await destroyPrivateEndpoint(server, privatePath);
      throw err;
    }
    // Caminho público ocupado: provar o incumbente POR CONEXÃO.
    const probe = await probeEndpoint(publicPath, probeTimeoutMs);
    if (probe.kind === 'live') {
      await destroyPrivateEndpoint(server, privatePath);
      return { kind: 'incumbent-live', socketPath: publicPath };
    }
    if (probe.kind === 'unknown') {
      await destroyPrivateEndpoint(server, privatePath);
      return { kind: 'unverifiable', reason: probe.reason };
    }
    // Morte física provada: sucessão atômica, sem janela sem dono.
    await rename(privatePath, publicPath);
    listenersByPublicPath.set(publicPath, server);
    return { kind: 'claimed', socketPath: publicPath };
  }

  listenersByPublicPath.set(publicPath, server);
  return { kind: 'claimed', socketPath: publicPath };
}

/**
 * Shutdown do dono: fecha o listener e ABANDONA o endpoint público no chão.
 * O contrato é NÃO fazer unlink — o sucessor prova a morte por conexão e
 * substitui por rename. Não existe sweeper.
 */
export async function releaseDaemonEndpoint(claim: {
  readonly socketPath: string;
}): Promise<void> {
  const server = listenersByPublicPath.get(claim.socketPath);
  if (!server) return;
  listenersByPublicPath.delete(claim.socketPath);
  server.close();
}
