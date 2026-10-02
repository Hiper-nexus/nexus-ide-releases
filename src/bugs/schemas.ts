import { z } from 'zod';
import { scrubLine, scrubText } from './scrub.js';
import {
  ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT, BUG_CATEGORIES, BUG_IMPACTS, BUG_PLATFORMS, BUG_SEVERITIES, BUG_STATUSES,
} from './constants.js';

/**
 * Texto livre: o tamanho do contrato vale para o que foi enviado; depois vem a limpeza (segredos, caminhos,
 * e-mails, controle) e só então o mínimo, para que "cinco caracteres invisíveis" não contem como título.
 */
function cleaned(kind: 'line' | 'text', min: number, max: number) {
  const scrub = kind === 'line' ? scrubLine : scrubText;
  return z.string().trim().max(max).transform(value => scrub(value, max)).pipe(z.string().min(min));
}

/** Parecido com semver: 0.76.110, 1.2, 1.2.3-beta.1+build5. */
const VERSION = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]+)?$/;
const ARCH = /^[A-Za-z0-9_-]+$/;

const appSchema = z.strictObject({
  version: z.string().max(32).regex(VERSION),
  platform: z.enum(BUG_PLATFORMS),
  arch: z.string().min(1).max(16).regex(ARCH),
  osVersion: cleaned('line', 0, 64).optional(),
});

const contextSchema = z.strictObject({
  adapter: cleaned('line', 0, 40).optional(),
  model: cleaned('line', 0, 80).optional(),
  paneCount: z.number().int().min(0).max(64).optional(),
  missionActive: z.boolean().optional(),
});

/** Só valida tamanhos; a limpeza do diagnóstico é feita num ponto único, em scrubDiagnostics (buildNewReport). */
const diagnosticsSchema = z.strictObject({
  events: z.array(z.strictObject({
    t: z.number().int().min(0),
    kind: z.string().min(1).max(40),
    code: z.string().min(1).max(80).optional(),
  })).max(50),
  errors: z.array(z.string().max(200)).max(20),
});

/** POST /v1/bug-reports. A gravidade não existe aqui: nasce 'medium' e o admin ajusta. */
export const createReportSchema = z.strictObject({
  title: cleaned('line', 5, 120),
  description: cleaned('text', 10, 4000),
  steps: cleaned('text', 0, 2000).optional(),
  category: z.enum(BUG_CATEGORIES),
  impact: z.enum(BUG_IMPACTS),
  app: appSchema,
  context: contextSchema.optional(),
  consent: z.strictObject({ diagnostics: z.boolean() }),
  diagnostics: diagnosticsSchema.optional(),
});
export type CreateReportInput = z.output<typeof createReportSchema>;

/** Rótulos que só existem dentro de uma rede (um agente que abrisse a URL viraria SSRF): nunca são um repositório público. */
const INTERNAL_SUFFIX = /\.(?:local|localhost|internal|lan|home|corp|intranet|private)$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** https, sem credenciais e com um nome de domínio público: nada de IP, `localhost` ou host interno. */
function isPublicHttps(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const isInternal = !host.includes('.') || host.startsWith('[') || IPV4.test(host) || INTERNAL_SUFFIX.test(host);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && !isInternal;
  } catch { return false; }
}

/** PATCH /v1/admin/bug-reports/:id. */
export const patchReportSchema = z.strictObject({
  status: z.enum(BUG_STATUSES).optional(),
  severity: z.enum(BUG_SEVERITIES).optional(),
  note: cleaned('text', 1, 2000).optional(),
  duplicateOf: z.uuid().optional(),
  fixSummary: cleaned('text', 1, 2000).optional(),
  fixPrUrl: z.string().trim().max(500).refine(isPublicHttps, { message: 'Use uma URL https pública, sem credenciais.' }).transform(value => new URL(value).href)
    // O href normalizado (com acentos em %xx) pode passar de 500: o CHECK do banco olharia para ele, não para o texto cru.
    .refine(href => href.length <= 500, { message: 'URL longa demais.' }).optional(),
}).refine(body => Object.values(body).some(value => value !== undefined), { message: 'Nada para alterar.' });
export type PatchReportInput = z.output<typeof patchReportSchema>;

/** GET /v1/admin/bug-reports. */
export const listQuerySchema = z.strictObject({
  status: z.enum(BUG_STATUSES).optional(),
  category: z.enum(BUG_CATEGORIES).optional(),
  severity: z.enum(BUG_SEVERITIES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_LIST_MAX_LIMIT).default(ADMIN_LIST_DEFAULT_LIMIT),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
});
export type ListQuery = z.output<typeof listQuerySchema>;
