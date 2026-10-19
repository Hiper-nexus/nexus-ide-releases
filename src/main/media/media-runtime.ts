import path from 'node:path';
import type { MediaGenerationResult } from '../../shared/media-types';
import type { BrowserAddressResolver } from '../browser/url-policy';
import type { PinnedMediaFetch } from './media-download';
import type { MediaInputFile } from './media-path-policy';
import { MediaProviderUnavailableError, type MediaProviderDef } from './media-providers';

/**
 * Execução comum a todos os motores de mídia (`media-generation.ts`): as
 * dependências injetadas, a autoridade revalidada a cada passo, o estouro de
 * tempo com `recoverJobId`, a chave obrigatória e o resultado. Saiu do motor
 * quando ele passou do teto de linhas do oxlint (F-1599).
 */

export interface MediaDeps {
  fetchFn: typeof fetch;
  resolveHostname: BrowserAddressResolver;
  fetchPinned?: PinnedMediaFetch;
  getKey(def: MediaProviderDef): string | undefined;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Timeout on a long-running Replicate/Google media job (image or video).
 * `recoverable` controls whether the message promises resume via recoverJobId
 * — only video jobs are persisted, so only they may advertise recovery.
 */
export class MediaJobTimeoutError extends Error {
  readonly jobId: string;
  readonly provider: string;
  readonly recoverable: boolean;

  constructor(provider: string, jobId: string, recoverable = true) {
    super(
      recoverable
        ? `${provider}: timeout esperando job ${jobId} — chame de novo com ` +
            `recoverJobId="${jobId}" para retomar sem pagar duas vezes`
        : `${provider}: timeout esperando job ${jobId} — a prediction pode ` +
            'ter completado no provider; reenvie a geração',
    );
    this.name = 'MediaJobTimeoutError';
    this.jobId = jobId;
    this.provider = provider;
    this.recoverable = recoverable;
  }
}

/**
 * F-1587: o vídeo já foi gerado e cobrado, mas não chegou (a Files API ou o
 * download falhou no meio). O job segue pendente e `recoverJobId` baixa sem
 * gerar de novo. Herda de `MediaJobTimeoutError` para o IPC e o MCP
 * devolverem o `recoverJobId` pelo mesmo caminho.
 */
export class MediaJobInterruptedError extends MediaJobTimeoutError {
  constructor(provider: string, jobId: string, cause: unknown) {
    super(provider, jobId);
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.message =
      `${provider}: o vídeo já foi gerado, mas não chegou (${detail}). ` +
      `Chame de novo com recoverJobId="${jobId}" para baixar sem pagar duas vezes`;
    this.name = 'MediaJobInterruptedError';
    this.cause = cause;
  }
}

/** Local abort (mission preempt / Estúdio cancel button) — not an error. */
export class MediaAbortError extends Error {
  constructor() {
    super('geração de mídia cancelada');
    this.name = 'MediaAbortError';
  }
}

export function throwIfMediaAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaAbortError();
}

export interface MediaAuthorityRequest {
  /** Aborted on caller/mission revocation. */
  signal?: AbortSignal;
  /** Revalidates non-signal authority (PREVC/scope/intent) at commit points. */
  assertCurrentAuthority?: () => void;
}

export function assertMediaAuthorityCurrent(req: MediaAuthorityRequest): void {
  req.assertCurrentAuthority?.();
  throwIfMediaAborted(req.signal);
}

export async function sleepWhileAuthorized(
  deps: MediaDeps,
  delayMs: number,
  req: MediaAuthorityRequest,
): Promise<void> {
  assertMediaAuthorityCurrent(req);
  if (!req.signal) {
    await deps.sleep(delayMs);
    assertMediaAuthorityCurrent(req);
    return;
  }
  let rejectAbort!: (reason: MediaAbortError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new MediaAbortError());
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([deps.sleep(delayMs), aborted]);
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
  assertMediaAuthorityCurrent(req);
}

export function requireKey(def: MediaProviderDef, deps: MediaDeps): string {
  const key = deps.getKey(def);
  if (!key) {
    throw new MediaProviderUnavailableError(
      def.kind,
      `${def.label} sem chave — conecte em Ajustes → Serviços de mídia`,
    );
  }
  return key;
}

export function fileToInlineData(image: MediaInputFile): {
  mimeType: string;
  data: string;
} {
  const ext = path.extname(image.path).toLowerCase().replace('.', '');
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : `image/${ext || 'png'}`;
  return { mimeType: mime, data: image.data.toString('base64') };
}

export function dataUri(image: MediaInputFile): string {
  const { mimeType, data } = fileToInlineData(image);
  return `data:${mimeType};base64,${data}`;
}

export function mediaResult(
  def: MediaProviderDef,
  model: string,
  outPath: string,
  startedAt: number,
  deps: MediaDeps,
  costParams: { chars?: number; seconds?: number; resolution?: string } = {},
  jobId?: string,
): MediaGenerationResult {
  return {
    ok: true,
    path: outPath,
    provider: def.id,
    model,
    kind: def.kind,
    estimatedCostUsd: def.estimateCost({ model, ...costParams }),
    durationMs: deps.now() - startedAt,
    ...(jobId ? { jobId } : {}),
  };
}
