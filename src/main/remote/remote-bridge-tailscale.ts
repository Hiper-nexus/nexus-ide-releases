// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: o endpoint MagicDNS
// (probe só com Serve ativo → available | requires-configuration) vira o
// ciclo de vida do Serve da Remote Bridge: publicar/despublicar com marcador
// em ~/.nexus, nunca sobrescrever handler alheio, limpar órfão no boot;
// Effect → async; diagnósticos em rótulos fechados.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  RemoteBridgeTailscaleDiagnostic,
  RemoteBridgeTailscaleInfo,
} from '../../shared/remote-types';
import { writeJsonAtomic } from '../util/atomic-write';
import {
  buildTailscaleHttpsBaseUrl,
  buildTailscaleServeTarget,
  classifyTailscaleServePort,
  DEFAULT_TAILSCALE_SERVE_PORT,
  disableTailscaleServe,
  ensureTailscaleServe,
  probeTailscaleHttpsEndpoint,
  readTailscaleServeConfig,
  readTailscaleStatus,
  resolveTailscaleCli,
  type TailscaleCli,
  type TailscaleCommandFailure,
  type TailscaleParseFailure,
} from './tailscale';

/** Estado do Serve que esta bridge possui (target != null ⇔ handler nosso). */
export interface RemoteBridgeTailscaleState {
  readonly info: RemoteBridgeTailscaleInfo;
  readonly target: string | null;
  readonly servePort: number;
}

const DETECT_CACHE_MS = 10_000;

const ServeMarker = z.object({
  version: z.literal(1),
  servePort: z.number().int().min(1).max(65535),
  target: z.string().regex(/^https\+insecure:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/u),
  pid: z.number().int().positive(),
  createdAt: z.number(),
});
type ServeMarker = z.infer<typeof ServeMarker>;

function markerFile(): string {
  return path.join(os.homedir(), '.nexus', 'remote-bridge', 'tailscale-serve.json');
}

function readMarker(): ServeMarker | null {
  try {
    const parsed = ServeMarker.safeParse(JSON.parse(fs.readFileSync(markerFile(), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeMarker(marker: ServeMarker): void {
  writeJsonAtomic(markerFile(), marker);
}

function removeMarkerFor(target: string): void {
  const marker = readMarker();
  if (marker && marker.target !== target) return;
  try {
    fs.rmSync(markerFile(), { force: true });
  } catch {
    // Melhor esforço: o boot tenta de novo.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: existe, mas é de outro usuário.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Alvo que podemos tratar como nosso: o do marcador, se o dono não está vivo. */
function ownedTargetFromMarker(): string | null {
  const marker = readMarker();
  if (!marker) return null;
  if (marker.pid !== process.pid && isProcessAlive(marker.pid)) return null;
  return marker.target;
}

function diagnosticOf(
  failure: TailscaleCommandFailure | TailscaleParseFailure,
): RemoteBridgeTailscaleDiagnostic {
  switch (failure.reason) {
    case 'spawn':
      return 'not-installed';
    case 'timeout':
      return failure.stderrDiagnostic === 'serve-not-enabled' ? 'serve-not-enabled' : 'timeout';
    case 'exit':
      switch (failure.stderrDiagnostic) {
        case 'not-logged-in':
        case 'permission-denied':
        case 'serve-not-enabled':
          return failure.stderrDiagnostic;
        default:
          return 'unknown';
      }
    default:
      return 'unknown';
  }
}

function unavailable(
  diagnostic: RemoteBridgeTailscaleDiagnostic,
  magicDnsName: string | null = null,
): RemoteBridgeTailscaleInfo {
  return { magicDnsName, status: 'unavailable', diagnostic };
}

/** Lê CLI + status: o nome MagicDNS quando dá para publicar, ou o motivo. */
async function readPublishableIdentity(): Promise<
  | { readonly ok: true; readonly cli: TailscaleCli; readonly magicDnsName: string }
  | { readonly ok: false; readonly info: RemoteBridgeTailscaleInfo }
> {
  const cli = resolveTailscaleCli();
  if (!cli) return { ok: false, info: unavailable('not-installed') };
  const status = await readTailscaleStatus(cli);
  if (!status.ok) return { ok: false, info: unavailable(diagnosticOf(status)) };
  const { backendState, magicDnsName } = status.status;
  if (backendState === 'NeedsLogin' || backendState === 'NeedsMachineAuth') {
    return { ok: false, info: unavailable('not-logged-in') };
  }
  if (backendState !== null && backendState !== 'Running') {
    return { ok: false, info: unavailable('not-running') };
  }
  if (!magicDnsName) return { ok: false, info: unavailable('no-magicdns') };
  return { ok: true, cli, magicDnsName };
}

let detectCache: { at: number; value: RemoteBridgeTailscaleInfo } | null = null;
let detectInFlight: Promise<RemoteBridgeTailscaleInfo> | null = null;

/**
 * Detecção sem efeito colateral (só `status --json`): `requires-configuration`
 * quando a CLI existe, está logada e tem MagicDNS — o Serve ainda não foi
 * pedido. A UI usa isso para nascer com o toggle ligado.
 */
export function detectRemoteBridgeTailscale(): Promise<RemoteBridgeTailscaleInfo> {
  if (detectCache && Date.now() - detectCache.at < DETECT_CACHE_MS) {
    return Promise.resolve(detectCache.value);
  }
  detectInFlight ??= readPublishableIdentity()
    .then((identity): RemoteBridgeTailscaleInfo =>
      identity.ok
        ? { magicDnsName: identity.magicDnsName, status: 'requires-configuration' }
        : identity.info,
    )
    .catch(() => unavailable('unknown'))
    .then((value) => {
      detectCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      detectInFlight = null;
    });
  return detectInFlight;
}

/** Só para testes: esquece a detecção em cache. */
export function resetRemoteBridgeTailscaleDetection(): void {
  detectCache = null;
  detectInFlight = null;
}

export async function publishRemoteBridgeOnTailnet(input: {
  readonly localPort: number;
  readonly localHost: '127.0.0.1' | '[::1]';
  readonly servePort?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<RemoteBridgeTailscaleState> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const none = (info: RemoteBridgeTailscaleInfo): RemoteBridgeTailscaleState => ({
    info,
    target: null,
    servePort,
  });
  const identity = await readPublishableIdentity();
  if (!identity.ok) return none(identity.info);
  const { cli, magicDnsName } = identity;
  const requiresConfiguration = (diagnostic: RemoteBridgeTailscaleDiagnostic) =>
    none({ magicDnsName, status: 'requires-configuration', diagnostic });

  const serveConfig = await readTailscaleServeConfig(cli);
  if (!serveConfig.ok) return requiresConfiguration(diagnosticOf(serveConfig));
  const owner = classifyTailscaleServePort(
    serveConfig.config,
    servePort,
    ownedTargetFromMarker(),
  );
  // Outra configuração já publica nesta porta: o Nexus não a substitui nem,
  // depois, a desligaria no stop.
  if (owner === 'foreign') return requiresConfiguration('port-in-use');

  const target = buildTailscaleServeTarget(input);
  // Marcador ANTES do serve: um crash entre os dois ainda deixa o boot
  // reconhecer o handler como nosso e removê-lo.
  writeMarker({ version: 1, servePort, target, pid: process.pid, createdAt: Date.now() });
  const ensured = await ensureTailscaleServe(cli, {
    localPort: input.localPort,
    localHost: input.localHost,
    servePort,
  });
  if (!ensured.ok) {
    // Saída com erro = nada aplicado. Timeout é ambíguo: o marcador fica para
    // o stop/boot conferirem.
    if (ensured.reason !== 'timeout') removeMarkerFor(target);
    return {
      ...requiresConfiguration(diagnosticOf(ensured)),
      target: ensured.reason === 'timeout' ? target : null,
    };
  }

  const httpsUrl = buildTailscaleHttpsBaseUrl({ magicDnsName, servePort });
  const reachable = await probeTailscaleHttpsEndpoint({
    baseUrl: httpsUrl,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return {
    info: reachable
      ? { magicDnsName, httpsUrl, status: 'available' }
      : { magicDnsName, httpsUrl, status: 'requires-configuration', diagnostic: 'probe-failed' },
    target,
    servePort,
  };
}

/**
 * Desliga o handler `target` se (e só se) ele ainda for nosso. Quando o
 * status do Serve não pode ser lido, desliga mesmo assim: deixar o tailnet
 * apontando para uma porta efêmera que outro processo pode ocupar é pior.
 */
export async function unpublishRemoteBridgeFromTailnet(
  target: string,
  servePort: number = DEFAULT_TAILSCALE_SERVE_PORT,
): Promise<void> {
  try {
    const cli = resolveTailscaleCli();
    if (!cli) return;
    const serveConfig = await readTailscaleServeConfig(cli);
    const owner = serveConfig.ok
      ? classifyTailscaleServePort(serveConfig.config, servePort, target)
      : 'ours';
    if (owner !== 'ours') {
      removeMarkerFor(target);
      return;
    }
    const disabled = await disableTailscaleServe(cli, { servePort });
    if (disabled.ok) removeMarkerFor(target);
  } catch {
    // Nunca derruba stop/quit; o marcador fica para o boot.
  }
}

/**
 * Boot: remove o handler que uma execução anterior deixou (crash/kill). Sem
 * marcador não há spawn algum; marcador de processo vivo é de outra instância.
 */
export async function cleanupOrphanRemoteBridgeTailscale(): Promise<void> {
  const marker = readMarker();
  if (!marker) return;
  if (marker.pid === process.pid || isProcessAlive(marker.pid)) return;
  await unpublishRemoteBridgeFromTailnet(marker.target, marker.servePort);
}
