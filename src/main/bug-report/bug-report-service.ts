import { createHash } from 'node:crypto';
import { z } from 'zod';
import { apiFetch, type ApiRequestInit, type ApiResult } from '../api-client';
import {
  BUG_REPORT_LIMITS,
  bugReportPayloadSchema,
  bugReportRequestSchema,
  type BugReportFailureCode,
  type BugReportPayload,
  type BugReportPreviewResult,
  type BugReportRequest,
  type BugReportSubmitResult,
} from '../../shared/bug-report';
import {
  buildAppInfo,
  buildContext,
  buildDiagnostics,
  createDefaultDiagnosticsDeps,
  type DiagnosticsDeps,
} from './bug-report-diagnostics';
import {
  redactBugReportPayload,
  redactBugReportText,
  type RedactionContext,
} from './bug-report-redaction';

/**
 * Serviço do reporte de problema (Main). Duas operações:
 *
 * - `preview`: valida o pedido do renderer, monta o corpo (diagnóstico só com
 *   consentimento), redige e devolve EXATAMENTE o que seria enviado.
 * - `submit`: o mesmo caminho, e então `POST /v1/bug-reports` com a sessão que
 *   só o Main conhece (`apiFetch`). Se o pedido for idêntico ao da última
 *   prévia, o corpo enviado é o da prévia — o que a pessoa viu é o que sai,
 *   mesmo que o trace tenha andado entre o clique de ver e o de enviar.
 *
 * Nada aqui escreve em log: corpo, texto digitado e sessão nunca saem pelo
 * console nem pelo trace.
 */

export interface BugReportServiceDeps {
  /** Cliente autenticado do Main (`apiFetch`); injetável para teste. */
  api: (path: string, init: ApiRequestInit) => Promise<ApiResult>;
  diagnostics: DiagnosticsDeps;
  now?: () => number;
  redaction?: RedactionContext;
  /** Teto do corpo serializado. Padrão: 64 KB do contrato. */
  maxBodyBytes?: number;
}

export interface BugReportService {
  preview(raw: unknown): Promise<BugReportPreviewResult>;
  submit(raw: unknown): Promise<BugReportSubmitResult>;
}

const ENDPOINT = '/v1/bug-reports';
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const SERVER_MESSAGE_MAX = 300;
/** A mensagem do servidor é cortada ANTES de redigir: o corpo pode ter 64 KB hostis. */
const SERVER_MESSAGE_SCAN_MAX = 1_000;
/** No máximo 10 tentativas de envio por processo a cada 10 minutos. */
const SUBMIT_WINDOW_MS = 10 * 60 * 1000;
const SUBMIT_WINDOW_MAX = 10;

const MESSAGES = {
  invalid: 'Confira o relato: título, descrição e as opções precisam estar preenchidos corretamente.',
  collapsed:
    'Depois de remover dados pessoais (e-mails, caminhos e chaves), o título ou a descrição ficou curto demais. Reescreva sem esses dados.',
  busy: 'Já estou enviando um relato. Aguarde o resultado.',
  stalePreview:
    'O conteúdo mudou desde a prévia que você conferiu. Abra "Ver exatamente o que será enviado" de novo e confirme.',
  tooManyAttempts: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
  noSession:
    'Você precisa entrar na sua conta Nexus para enviar o relato. Abra Configurações → Minha conta, entre e tente de novo.',
  tooLarge:
    'O relato ficou grande demais para enviar. Encurte a descrição ou desligue o diagnóstico técnico.',
  rejected: 'O servidor não aceitou o relato',
  rateLimited: 'Você já enviou 5 relatos por hora. Tente de novo mais tarde.',
  server: 'O servidor não conseguiu receber o relato agora. Tente de novo em instantes.',
  network: 'Não consegui falar com o servidor. Verifique a conexão e tente de novo.',
  invalidResponse: 'O servidor respondeu de um jeito inesperado. O relato pode não ter sido recebido.',
} as const;

const successSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    id: z.string().min(1).max(128),
    status: z.string().max(32).optional(),
  }),
});

function failure(
  code: BugReportFailureCode,
  message: string,
  payload?: BugReportPayload,
): Extract<BugReportSubmitResult, { ok: false }> {
  return { ok: false, code, message, ...(payload ? { payload } : {}) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Chave do pedido sem o resumo da prévia: o resumo descreve o corpo, não o pedido. */
function fingerprint(request: Omit<BugReportRequest, 'previewDigest'>): string {
  return sha256(JSON.stringify(request));
}

function digestOf(payload: BugReportPayload): string {
  return sha256(JSON.stringify(payload));
}

/** Mensagem do servidor, pronta para a tela: sem controle, redigida, curta. */
function serverMessage(json: unknown, redaction: RedactionContext | undefined): string | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const error = record.error;
  const nested =
    error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
  const candidate = [error, nested, record.message].find(
    (value): value is string => typeof value === 'string',
  );
  if (!candidate) return null;
  // eslint-disable-next-line no-control-regex
  const flat = candidate.slice(0, SERVER_MESSAGE_SCAN_MAX).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const safe = redactBugReportText(flat, redaction).slice(0, SERVER_MESSAGE_MAX).trim();
  return safe || null;
}

function mapResponse(
  result: ApiResult,
  payload: BugReportPayload,
  redaction: RedactionContext | undefined,
): BugReportSubmitResult {
  const { status, json } = result;
  const message = serverMessage(json, redaction);
  if (status >= 200 && status < 300) {
    const parsed = successSchema.safeParse(json);
    return parsed.success
      ? { ok: true, id: parsed.data.data.id }
      : failure('invalid-response', MESSAGES.invalidResponse, payload);
  }
  if (status === 401) return failure('no-session', MESSAGES.noSession, payload);
  if (status === 413) return failure('too-large', MESSAGES.tooLarge, payload);
  if (status === 400) {
    return failure(
      'rejected',
      message ? `${MESSAGES.rejected}: ${message}` : `${MESSAGES.rejected}.`,
      payload,
    );
  }
  if (status === 429) return failure('rate-limited', message ?? MESSAGES.rateLimited, payload);
  if (status === 0) return failure('network', MESSAGES.network, payload);
  return failure('server', status >= 500 ? MESSAGES.server : `${MESSAGES.server} (código ${status})`, payload);
}

async function buildPayload(
  request: BugReportRequest,
  deps: BugReportServiceDeps,
): Promise<BugReportPayload | null> {
  const consent = request.includeDiagnostics;
  const raw: BugReportPayload = {
    title: request.title,
    description: request.description,
    ...(request.steps ? { steps: request.steps } : {}),
    category: request.category,
    impact: request.impact,
    app: buildAppInfo(deps.diagnostics),
    // Sem consentimento o Main nem consulta a frota nem lê o trace.
    ...(consent ? { context: buildContext(deps.diagnostics, request.activePaneId) } : {}),
    consent: { diagnostics: consent },
    ...(consent ? { diagnostics: await buildDiagnostics(deps.diagnostics) } : {}),
  };
  const parsed = bugReportPayloadSchema.safeParse(redactBugReportPayload(raw, deps.redaction));
  return parsed.success ? parsed.data : null;
}

export function createBugReportService(getDeps: () => BugReportServiceDeps): BugReportService {
  let lastPreview: { key: string; payload: BugReportPayload; at: number } | null = null;
  let inFlight = false;
  let attempts: number[] = [];

  const parse = (raw: unknown): BugReportRequest | null => {
    const parsed = bugReportRequestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };

  return {
    async preview(raw) {
      const request = parse(raw);
      if (!request) return failure('invalid', MESSAGES.invalid);
      const deps = getDeps();
      const payload = await buildPayload(request, deps);
      if (!payload) return failure('invalid', MESSAGES.collapsed);
      const { previewDigest: _ignored, ...core } = request;
      lastPreview = { key: fingerprint(core), payload, at: (deps.now ?? Date.now)() };
      return { ok: true, payload, digest: digestOf(payload) };
    },

    async submit(raw) {
      const request = parse(raw);
      if (!request) return failure('invalid', MESSAGES.invalid);
      if (inFlight) return failure('busy', MESSAGES.busy);
      inFlight = true;
      try {
        const deps = getDeps();
        const now = (deps.now ?? Date.now)();
        const { previewDigest, ...core } = request;
        const previewed =
          lastPreview && lastPreview.key === fingerprint(core) && now - lastPreview.at <= PREVIEW_TTL_MS
            ? lastPreview.payload
            : null;
        const payload = previewed ?? (await buildPayload(request, deps));
        if (!payload) return failure('invalid', MESSAGES.collapsed);
        // O que a pessoa conferiu é o que sai: corpo diferente do da prévia não é enviado.
        if (previewDigest !== undefined && previewDigest !== digestOf(payload)) {
          return failure('stale-preview', MESSAGES.stalePreview);
        }
        attempts = attempts.filter((at) => now - at < SUBMIT_WINDOW_MS);
        if (attempts.length >= SUBMIT_WINDOW_MAX) {
          return failure('rate-limited', MESSAGES.tooManyAttempts, payload);
        }
        attempts.push(now);
        const maxBytes = deps.maxBodyBytes ?? BUG_REPORT_LIMITS.bodyMaxBytes;
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxBytes) {
          return failure('too-large', MESSAGES.tooLarge, payload);
        }
        let result: ApiResult;
        try {
          result = await deps.api(ENDPOINT, {
            method: 'POST',
            body: payload,
            timeoutMs: REQUEST_TIMEOUT_MS,
            maxResponseBytes: RESPONSE_MAX_BYTES,
            redirect: 'error',
          });
        } catch {
          // Nunca ecoa a exceção: ela pode citar URL, cabeçalho ou corpo.
          return failure('network', MESSAGES.network, payload);
        }
        const mapped = mapResponse(result, payload, deps.redaction);
        if (mapped.ok) lastPreview = null;
        return mapped;
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Fontes reais do Main: sessão por `apiFetch`, diagnóstico do app em execução. */
export function createDefaultBugReportServiceDeps(): BugReportServiceDeps {
  return {
    api: (path, init) => apiFetch(path, init),
    diagnostics: createDefaultDiagnosticsDeps(),
  };
}
