import { z } from 'zod';

/**
 * Reporte de problema (contrato v1 com `POST /v1/bug-reports`).
 *
 * Dois formatos, duas fronteiras:
 * - `BugReportRequest` — o que o RENDERER entrega ao Main (texto digitado,
 *   escolhas e o consentimento). Nunca carrega diagnóstico: quem o monta é o
 *   Main, a partir do que ele mesmo sabe.
 * - `BugReportPayload` — o corpo exato que o Main envia ao servidor, já
 *   redigido. É também o que a prévia "Ver exatamente o que será enviado"
 *   mostra: o que a pessoa vê é o que sai.
 *
 * Dependência só de zod: o preload, o Main e o renderer importam este arquivo.
 */

export const BUG_REPORT_CATEGORIES = [
  'crash',
  'terminal',
  'agents',
  'license',
  'billing',
  'ui',
  'performance',
  'other',
] as const;
export type BugReportCategory = (typeof BUG_REPORT_CATEGORIES)[number];

export const BUG_REPORT_IMPACTS = ['annoying', 'blocks_work'] as const;
export type BugReportImpact = (typeof BUG_REPORT_IMPACTS)[number];

export const BUG_REPORT_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type BugReportPlatform = (typeof BUG_REPORT_PLATFORMS)[number];

export const BUG_REPORT_CATEGORY_LABELS: Readonly<Record<BugReportCategory, string>> = {
  crash: 'Travamento ou fechamento inesperado',
  terminal: 'Terminal',
  agents: 'Agentes e missões',
  license: 'Licença e acesso',
  billing: 'Cobrança e assinatura',
  ui: 'Interface',
  performance: 'Lentidão ou desempenho',
  other: 'Outro',
};

export const BUG_REPORT_IMPACT_LABELS: Readonly<Record<BugReportImpact, string>> = {
  annoying: 'Atrapalha',
  blocks_work: 'Me impede de trabalhar',
};

/** Tetos do contrato v1 — o servidor recusa o que passar deles. */
export const BUG_REPORT_LIMITS = {
  titleMin: 5,
  titleMax: 120,
  descriptionMin: 10,
  descriptionMax: 4000,
  stepsMax: 2000,
  kindMax: 40,
  codeMax: 80,
  maxEvents: 50,
  maxErrors: 20,
  errorMax: 200,
  maxPanes: 64,
  /** Corpo JSON máximo aceito pelo servidor (64 KB). */
  bodyMaxBytes: 64 * 1024,
} as const;

const LIMITS = BUG_REPORT_LIMITS;

/** Renderer → Main. Estrito: chave desconhecida é recusada. */
export const bugReportRequestSchema = z
  .object({
    title: z.string().trim().min(LIMITS.titleMin).max(LIMITS.titleMax),
    description: z.string().trim().min(LIMITS.descriptionMin).max(LIMITS.descriptionMax),
    steps: z.string().trim().max(LIMITS.stepsMax).optional(),
    category: z.enum(BUG_REPORT_CATEGORIES),
    impact: z.enum(BUG_REPORT_IMPACTS),
    /** Consentimento explícito: sem `true` não há diagnóstico no corpo. */
    includeDiagnostics: z.boolean(),
    /**
     * Seletor do pane em foco, só para o Main escolher qual agente descrever.
     * O id nunca vai ao servidor.
     */
    activePaneId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type BugReportRequest = z.infer<typeof bugReportRequestSchema>;

const appSchema = z
  .object({
    version: z.string().min(1).max(40),
    platform: z.enum(BUG_REPORT_PLATFORMS),
    arch: z.string().min(1).max(20),
    osVersion: z.string().min(1).max(64).optional(),
  })
  .strict();

const contextSchema = z
  .object({
    adapter: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(80).optional(),
    paneCount: z.number().int().min(0).max(LIMITS.maxPanes),
    missionActive: z.boolean(),
  })
  .strict();

const diagnosticEventSchema = z
  .object({
    /** Instante do evento, em milissegundos desde a época Unix. */
    t: z.number().int().nonnegative(),
    kind: z.string().min(1).max(LIMITS.kindMax),
    code: z.string().min(1).max(LIMITS.codeMax).optional(),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    events: z.array(diagnosticEventSchema).max(LIMITS.maxEvents),
    errors: z.array(z.string().max(LIMITS.errorMax)).max(LIMITS.maxErrors),
  })
  .strict();

/** Corpo de `POST /v1/bug-reports`. */
export const bugReportPayloadSchema = z
  .object({
    title: z.string().min(LIMITS.titleMin).max(LIMITS.titleMax),
    description: z.string().min(LIMITS.descriptionMin).max(LIMITS.descriptionMax),
    steps: z.string().max(LIMITS.stepsMax).optional(),
    category: z.enum(BUG_REPORT_CATEGORIES),
    impact: z.enum(BUG_REPORT_IMPACTS),
    app: appSchema,
    context: contextSchema.optional(),
    consent: z.object({ diagnostics: z.boolean() }).strict(),
    diagnostics: diagnosticsSchema.optional(),
  })
  .strict()
  .refine(
    (payload) =>
      payload.consent.diagnostics ||
      (payload.diagnostics === undefined && payload.context === undefined),
    { message: 'diagnostics and context require consent.diagnostics' },
  );
export type BugReportPayload = z.infer<typeof bugReportPayloadSchema>;
export type BugReportDiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

export type BugReportFailureCode =
  | 'invalid'
  | 'busy'
  | 'no-session'
  | 'too-large'
  | 'rejected'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'invalid-response';

export type BugReportPreviewResult =
  | { ok: true; payload: BugReportPayload }
  | { ok: false; code: BugReportFailureCode; message: string };

/**
 * `payload` acompanha a falha quando o Main já o montou: é o texto (redigido)
 * que a pessoa pode copiar e mandar por outro canal. Nunca contém sessão.
 */
export type BugReportSubmitResult =
  | { ok: true; id: string }
  | {
      ok: false;
      code: BugReportFailureCode;
      message: string;
      payload?: BugReportPayload;
    };

export interface BugReportDraft {
  title: string;
  description: string;
  steps?: string;
}

export type BugReportDraftErrors = Partial<Record<'title' | 'description' | 'steps', string>>;

/** Validação do formulário, em português, campo a campo. */
export function validateBugReportDraft(draft: BugReportDraft): BugReportDraftErrors {
  const errors: BugReportDraftErrors = {};
  const title = draft.title.trim();
  const description = draft.description.trim();
  const steps = (draft.steps ?? '').trim();
  if (title.length < LIMITS.titleMin) {
    errors.title = `O título precisa ter pelo menos ${LIMITS.titleMin} caracteres.`;
  } else if (title.length > LIMITS.titleMax) {
    errors.title = `O título pode ter no máximo ${LIMITS.titleMax} caracteres.`;
  }
  if (description.length < LIMITS.descriptionMin) {
    errors.description = `Descreva o problema com pelo menos ${LIMITS.descriptionMin} caracteres.`;
  } else if (description.length > LIMITS.descriptionMax) {
    errors.description = `A descrição pode ter no máximo ${LIMITS.descriptionMax} caracteres.`;
  }
  if (steps.length > LIMITS.stepsMax) {
    errors.steps = `Os passos podem ter no máximo ${LIMITS.stepsMax} caracteres.`;
  }
  return errors;
}

const PLATFORM_LABELS: Readonly<Record<BugReportPlatform, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

export type BugReportMarkdownInput = Pick<
  BugReportPayload,
  'title' | 'description' | 'category' | 'impact'
> &
  Partial<Pick<BugReportPayload, 'steps' | 'app' | 'context' | 'diagnostics'>>;

/**
 * Texto do relato em markdown, para a pessoa copiar e mandar por outro canal
 * quando o envio falhar. Determinístico: mesma entrada, mesmo texto.
 */
export function formatBugReportMarkdown(report: BugReportMarkdownInput): string {
  const lines: string[] = [
    `# ${report.title}`,
    '',
    `- Categoria: ${BUG_REPORT_CATEGORY_LABELS[report.category]}`,
    `- Impacto: ${BUG_REPORT_IMPACT_LABELS[report.impact]}`,
  ];
  if (report.app) {
    const os = report.app.osVersion ? ` · SO ${report.app.osVersion}` : '';
    lines.push(
      `- App: NexusIDE ${report.app.version} · ${PLATFORM_LABELS[report.app.platform]} (${report.app.platform} ${report.app.arch})${os}`,
    );
  }
  lines.push('', '## Descrição', '', report.description);
  if (report.steps) lines.push('', '## Passos para reproduzir', '', report.steps);
  if (report.context || report.diagnostics) {
    lines.push('', '## Diagnóstico técnico', '');
    if (report.context) {
      const agent = [report.context.adapter, report.context.model && `(${report.context.model})`]
        .filter(Boolean)
        .join(' ');
      lines.push(`- Agente ativo: ${agent || 'nenhum'}`);
      lines.push(`- Panes de agente: ${report.context.paneCount}`);
      lines.push(`- Missão ativa: ${report.context.missionActive ? 'sim' : 'não'}`);
    }
    const events = report.diagnostics?.events ?? [];
    if (events.length > 0) {
      lines.push('', 'Eventos recentes:');
      for (const event of events) {
        const code = event.code ? ` · ${event.code}` : '';
        lines.push(`- ${new Date(event.t).toISOString()} · ${event.kind}${code}`);
      }
    }
    const errors = report.diagnostics?.errors ?? [];
    if (errors.length > 0) {
      lines.push('', 'Erros recentes:');
      for (const error of errors) lines.push(`- ${error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
