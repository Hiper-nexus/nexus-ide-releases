import { z } from 'zod';

function isHttpUrlOrEmpty(value: string): boolean {
  if (value.trim() === '') return true;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAbsolutePathOrEmpty(value: string): boolean {
  return (
    value === '' ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

/**
 * User-facing terminal settings (theme / font / shell) — the TERMINAL module
 * of the settings drawer. JSON-safe; persisted by the main process in
 * ~/.nexus/settings.json and applied live to every open terminal.
 */

export const TERMINAL_THEME_IDS = [
  'nexus-pink-city',
  'nexus-dark',
  'nexus-light',
  'nexus-gray',
  'nexus-red',
  'dracula',
  'solarized-dark',
] as const;

export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number];

export const terminalSettingsSchema = z.object({
  themeId: z.enum(TERMINAL_THEME_IDS).default('nexus-pink-city'),
  /** Empty string = the app's default monospace stack. */
  fontFamily: z.string().max(256).default(''),
  fontSize: z.number().int().min(9).max(24).default(13),
  /**
   * Shell override for new shell panes. Empty string = $SHELL. When set it
   * must be an absolute path (same rule the PTY spawn boundary enforces).
   */
  shell: z
    .string()
    .max(4096)
    .refine(isAbsolutePathOrEmpty, {
      message: 'shell must be an absolute path',
    })
    .default(''),
  /**
   * adaptive: batches agent output, parks fully hidden panes and trims their
   * in-memory scrollback under pressure. quality: keeps every mounted pane
   * rendering immediately with the larger scrollback budget.
   */
  performanceMode: z.enum(['adaptive', 'quality']).default('adaptive'),
});

export type TerminalSettings = z.infer<typeof terminalSettingsSchema>;

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings =
  terminalSettingsSchema.parse({});

/**
 * Renderer sends a partial patch; main merges + validates + persists.
 * Defined explicitly (not via .partial()) because zod still fills `.default()`
 * values on partial objects — that would silently reset every unspecified
 * field back to its default on merge.
 */
export const terminalSettingsPatchSchema = z.object({
  themeId: z.enum(TERMINAL_THEME_IDS).optional(),
  fontFamily: z.string().max(256).optional(),
  fontSize: z.number().int().min(9).max(24).optional(),
  shell: z
    .string()
    .max(4096)
    .refine(isAbsolutePathOrEmpty, {
      message: 'shell must be an absolute path',
    })
    .optional(),
  performanceMode: z.enum(['adaptive', 'quality']).optional(),
});
export type TerminalSettingsPatch = z.infer<typeof terminalSettingsPatchSchema>;

/**
 * Direções estéticas do perfil de design (taxonomia adaptada do taste-skill,
 * MIT — github.com/leonxlnx/taste-skill). `auto` = seguir o design system do
 * projeto, sem direção imposta.
 */
export const DESIGN_DIRECTIONS = [
  'auto',
  'minimalist',
  'brutalist',
  'soft',
] as const;
export type DesignDirection = (typeof DESIGN_DIRECTIONS)[number];

/** Dial 1–10 do perfil de design. 5 = neutro: não injeta nenhuma linha extra. */
export const DESIGN_DIAL_NEUTRAL = 5;
const designDialSchema = z
  .number()
  .int()
  .min(1)
  .max(10)
  .default(DESIGN_DIAL_NEUTRAL);

/**
 * Configurações de orquestração (seção `orch` do ~/.nexus/settings.json).
 * leanCode = injetar as regras ponytail (lazy senior dev, MIT —
 * github.com/DietrichGebert/ponytail) no prompt de todo worker de squad.
 */
export const orchSettingsSchema = z.object({
  leanCode: z.boolean().default(true),
  /** Carta de Engenharia (XP/sênior) injetada em todo worker de squad. */
  seniorMode: z.boolean().default(true),
  /**
   * Piloto automático Jev: revisão de evidência dos handoffs de missão e
   * triagens do Nexus; exige chave TypeSafe. Falha do serviço nunca bloqueia:
   * sem resposta = comportamento atual.
   */
  jevAutopilot: z.boolean().default(true),
  /**
   * Superfícies do piloto automático Jev: um toggle por lugar onde o Jev
   * decide algo (revisão de handoff, triagem do pedido, estado dos panes,
   * triagem de falhas e ranking de entregas). O mestre `jevAutopilot`
   * continua mandando — superfície ligada sem o mestre não chama o modelo.
   */
  jevSurfaces: z
    .object({
      handoffReview: z.boolean().default(true),
      intake: z.boolean().default(true),
      paneState: z.boolean().default(true),
      terminalTriage: z.boolean().default(true),
      rank: z.boolean().default(true),
      /** Guarda de chamadas `nexus_*` com efeito dentro de missão. */
      dispatchGuard: z.boolean().default(true),
      /** Recomendação semântica de ferramenta (`nexus_tool_pick`). */
      toolPick: z.boolean().default(true),
      /** Tier/especialidade do `nexus_route_task` via Jev. */
      taskRouting: z.boolean().default(true),
      /** Desempate Jev na resolução de elementos por texto no browser. */
      browserTool: z.boolean().default(true),
      /** Triagem de hits de pesquisa: melhor resposta + se falta pesquisar. */
      researchTriage: z.boolean().default(true),
      /** Conselho de delegação por mensagem nos panes do operador (hook). */
      delegation: z.boolean().default(true),
      /** Destilação de memória: resumo de handoff aceito vira linha trusted. */
      memoryDistill: z.boolean().default(true),
      /** Reuso de helper ocioso com contexto relacionado em vez de spawn novo. */
      helperReuse: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Injeta o bloco <workspace-memory> no brief de spawn, nas instructions do
   * MCP do "+ Pane" e no hook do Codex. Default ligado; desligar aqui
   * mantém o restante do sistema de memória intacto.
   */
  workspaceMemoryInjection: z.boolean().default(true),
  /** Carta de Design anti-genérico (Impeccable) para tarefas com UI. */
  designPro: z.boolean().default(true),
  /** Direção estética aplicada pelo motor de design junto com a carta. */
  designDirection: z.enum(DESIGN_DIRECTIONS).default('auto'),
  /** Ousadia de layout: 1 = padrões convencionais, 10 = composição editorial. */
  designVariance: designDialSchema,
  /** Intensidade de motion: 1 = UI estática, 10 = animação coreografada. */
  designMotion: designDialSchema,
  /** Densidade visual: 1 = uma ideia por viewport, 10 = UI densa em dados. */
  designDensity: designDialSchema,
  /**
   * Diretório do catálogo LOCAL de design (um `.md` por marca, no formato
   * DESIGN.md). Vazio = `~/.design-references`, a convenção do `getdesign`.
   * É a fonte de contrato de design que não depende de rede nem de chave:
   * designmd.ai serve metadados públicos mas exige
   * `external:designmd-api-key` para o corpo do DESIGN.md.
   */
  designLocalCatalogDir: z
    .string()
    .max(4096)
    .refine(isAbsolutePathOrEmpty, {
      message: 'design catalog directory must be empty or an absolute path',
    })
    .default(''),
  /**
   * Kit do catálogo local fixado como direção padrão do contrato de design que
   * o bootstrap materializa sozinho (`orch.designDefaultKit`). Vazio = sem
   * pino: a escolha cai no casamento por sinais do objetivo e, se nada casar
   * com folga, no contrato NEUTRO de casa.
   *
   * Este setting é a ÚNICA forma de uma marca famosa entrar por decisão
   * humana. Um pino que não existe no catálogo NUNCA vira outro kit por
   * aproximação — cai direto no neutro, com o motivo declarado no documento.
   */
  designDefaultKit: z
    .string()
    .trim()
    .max(64)
    .refine((value) => value === '' || /^[a-z0-9][a-z0-9._-]*$/.test(value), {
      message:
        'design default kit must be empty or a lowercase catalog kit id',
    })
    .default(''),
  /** Modo sóbrio: oculta HUD/celebrações/narração da gamificação (o XP
   *  continua acumulando em silêncio). */
  soberMode: z.boolean().default(false),
  /**
   * Autoaceita somente menus de boot conhecidos e assinados por adapter.
   * O default preserva o fluxo sem pane engolindo kickoff; false é o kill
   * switch persistido e de efeito imediato para impedir qualquer keypress.
   */
  cliPromptAutoResponderEnabled: z.boolean().default(true),
  /**
   * Restore preference for standalone agent panes. Main-owned mission panes
   * always resume their persisted authority automatically on app/workspace
   * restore; technical recovery remains Main-owned and retryable.
   * - `ask`: confirm before standalone agents run
   * - `pause`: keep standalone agents paused
   * - `resume` (default): silently resume standalone agents too — they were
   *   already running with auto-approve; the dialog only added friction to
   *   every cold start. `ask`/`pause` remain as hardened opt-ins.
   */
  agentRestorePolicy: z.enum(['ask', 'pause', 'resume']).default('resume'),
  /**
   * Gateway de IA local (OmniRoute-like) na frente das CLIs. Vazio = desligado
   * (a env var `NEXUS_AI_GATEWAY_BASE_URL` continua valendo como fallback).
   * Só http(s): o valor vira `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` dentro do
   * PTY das CLIs que declaram essas vars, então um esquema exótico aqui viraria
   * endpoint em toda CLI roteada.
   */
  aiGatewayBaseUrl: z
    .string()
    .max(2048)
    .refine(isHttpUrlOrEmpty, {
      message: 'gateway base URL must be empty or an http(s) URL',
    })
    .default(''),
  /** CLI provider used by the next squad orchestrator. */
  defaultAdapterId: z.string().max(64).default('claude'),
  /** Empty means the selected provider's configured default model. */
  defaultModel: z.string().max(128).default(''),
  /** Empty means the selected provider's currently active/default account. */
  defaultAccountId: z.string().max(128).default(''),
  /** Diagnostic LLM used by the realtime Doctor. `auto` selects an available
   * provider at runtime; recovery itself never depends on this model. */
  doctorAdapterId: z.string().max(64).default('auto'),
  /** Empty means the selected provider's configured/default model. */
  doctorModel: z.string().max(128).default(''),
  /** Highest supported effort is resolved per adapter when set to `max`. */
  doctorEffort: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('auto'),
  /**
   * Intent-first mission runtime (v1): selecting a squad arms a mission shell
   * (`awaiting_goal`) without spawning an orchestrator pane or burning tokens.
   * Set false to restore the legacy zero-click kickoff path (rollback).
   */
  intentFirstMissionRuntimeV1: z.boolean().default(true),
  /**
   * Who may act as Maestro / autonomous writer inside a Squad mission:
   * - `operator-choice` (**default for everyone**): vibe-coder / peer ADE
   *   autopilot — any installed + authenticated + handoff-capable CLI. Tasks
   *   use an isolated worktree, per-session bearer and Main-owned merge;
   *   auto-approve and web stay on; **no OS process sandbox** on panes.
   * - `governed`: explicit opt-in only — operator must open Settings and pick
   *   Hardened (Codex writers, verified Maestro, advisory Seatbelt). Never
   *   applied by omission, missing policy, or schema default.
   */
  squadCliPolicy: z
    .enum(['governed', 'operator-choice'])
    .default('operator-choice'),
  /**
   * Escada adaptativa de concorrência da política Hardened (governed). Só tem
   * efeito quando `squadCliPolicy === 'governed'`; no Autopiloto o teto da onda
   * é o `maxWorkers` aprovado, sem escada.
   *
   * O padrão antigo era fixo (começa em 2, para em 6) e engessava projetos
   * grandes numa máquina capaz de mais — sem o operador poder mudar nada sem
   * editar código. Agora é ajustável, e `maxCap: null` significa "alinhe ao
   * teto real da máquina" (cores-2 / orçamento de panes), para o usuário nunca
   * ficar calado abaixo do que o hardware aguenta.
   */
  adaptiveWaveLadder: z
    .object({
      /** Largura da primeira onda sob Hardened. */
      startCap: z.number().int().min(1).max(64).default(2),
      /** Teto da escada; null = alinhar ao teto de hardware calculado. */
      maxCap: z.number().int().min(1).max(64).nullable().default(null),
      /** Ondas limpas consecutivas exigidas para alargar +1. */
      rampAfterCleanWaves: z.number().int().min(1).max(10).default(2),
    })
    .default({ startCap: 2, maxCap: null, rampAfterCleanWaves: 2 }),
  /**
   * Fast path (default on): `risk=normal` standard missions skip Guided PREVC
   * fence/freeze before the first writable pane — Autopilot libre speed for
   * vibe feature work. Sensitive/destructive keep PREVC. Set false to restore
   * legacy PREVC-on-every-guided-delivery behavior.
   * @see docs/design/orch-fast-path.md
   */
  fastPath: z.boolean().default(true),
  /**
   * Physical agent transport for main-owned mission panes.
   * - `cli-pty` (default): legacy CLI adapters over PTY — unchanged path.
   * - `acp`: ACP stdio harness from the BYOH catalog. Never silently falls
   *   back to PTY when this is selected; spawn fails with an explicit error.
   */
  agentTransport: z.enum(['cli-pty', 'acp']).default('cli-pty'),
  /**
   * Selected ACP harness id (preset or custom) when `agentTransport === 'acp'`.
   * Empty means "no harness chosen" — ACP spawn refuses until the operator
   * picks one in Settings → Harness ACP.
   */
  acpHarnessId: z.string().max(64).default(''),
  /**
   * Cryptographic agent-identity gate on physical handoff submits.
   * - `off` (default): Autopilot libre Autopilot — handoffs do not require
   *   agent attestation crypto; first pane is not blocked by keyring/vault.
   * - `required` (opt-in Hardened): when a mission has issued identity material,
   *   handoff fails closed unless the presented attestation verifies
   *   (signature, scope, expiry, revocation, issued-set membership).
   */
  agentAttestationGate: z.enum(['off', 'required']).default('off'),
  /**
   * User-supplied BYOH definitions (tier custom). Validated via
   * `parseHarnessDefinition` before spawn; reserved ids rejected.
   */
  acpCustomHarnesses: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
  /**
   * Write-only probe trigger. Settings UI sets `{ id, requestId }`; main
   * runs `probeAcpHarness` and publishes the result into
   * `acpHarnessLastProbe`. Cleared after the probe is scheduled.
   */
  acpHarnessProbeRequest: z
    .object({
      id: z.string().max(64),
      requestId: z.string().max(128),
    })
    .nullable()
    .default(null),
  /** Last ACP harness probe result (read by Settings UI). */
  acpHarnessLastProbe: z
    .object({
      requestId: z.string().max(128),
      harnessId: z.string().max(64),
      ok: z.boolean(),
      detail: z.string().max(2048),
      at: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  /**
   * Harness por tarefa (paridade Overclock 1.4): categorias × tipos ×
   * {cli, model, account, effort, skills, agent}. `null` = tabela de fábrica.
   * Persistida pelo `nexus_harness` action=apply via replaceOrchSettings.
   */
  taskHarnessTable: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type OrchSettings = z.infer<typeof orchSettingsSchema>;
export const DEFAULT_ORCH_SETTINGS: OrchSettings = orchSettingsSchema.parse({});
export type SquadCliPolicy = OrchSettings['squadCliPolicy'];
export type AgentTransport = OrchSettings['agentTransport'];
export type AgentAttestationGate = OrchSettings['agentAttestationGate'];

/** Product floor: Autopilot never requires handoff crypto by default. */
export function isAgentAttestationRequired(
  gate: AgentAttestationGate | null | undefined = DEFAULT_ORCH_SETTINGS.agentAttestationGate,
): boolean {
  return gate === 'required';
}

/**
 * App-wide voice audio routing. `default` follows the current operating-system
 * device; an opaque MediaDeviceInfo.deviceId pins one explicit device.
 */
export const audioSettingsSchema = z.object({
  inputDeviceId: z.string().max(512).default('default'),
  outputDeviceId: z.string().max(512).default('default'),
});
export type AudioSettings = z.infer<typeof audioSettingsSchema>;
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = audioSettingsSchema.parse({});

export const audioSettingsPatchSchema = z.object({
  inputDeviceId: z.string().max(512).optional(),
  outputDeviceId: z.string().max(512).optional(),
});
export type AudioSettingsPatch = z.infer<typeof audioSettingsPatchSchema>;

/**
 * Privacy settings for Jarvis Vision. Defaults are fail-closed: raw screenshots
 * stay local unless explicit UI consent enables access.
 */
export const visionSettingsSchema = z.object({
  allowCloudImage: z.boolean().default(false),
});
export type VisionSettings = z.infer<typeof visionSettingsSchema>;
export const DEFAULT_VISION_SETTINGS: VisionSettings =
  visionSettingsSchema.parse({});

/**
 * Aparência global do app (não do xterm): modo pixel, etc.
 * Persistido em ~/.nexus/settings.json → `ui`.
 */
export const uiSettingsSchema = z.object({
  /** Cantos retos, VT323 como --font-ui, antialias desligado (data-theme-pixel). */
  pixelMode: z.boolean().default(false),
});
export type UiSettings = z.infer<typeof uiSettingsSchema>;
export const DEFAULT_UI_SETTINGS: UiSettings = uiSettingsSchema.parse({});

export const uiSettingsPatchSchema = z.object({
  pixelMode: z.boolean().optional(),
});
export type UiSettingsPatch = z.infer<typeof uiSettingsPatchSchema>;

/**
 * Integrações externas (forges/trackers). `githubOauthClientId` habilita a
 * opção de login GitHub via Device Flow; a env NEXUS_GITHUB_OAUTH_CLIENT_ID
 * tem precedência (override de dev). Sem clientId a opção fica oculta na UI.
 */
export const integrationsSettingsSchema = z.object({
  githubOauthClientId: z.string().max(256).default(''),
});
export type IntegrationsSettings = z.infer<typeof integrationsSettingsSchema>;
export const DEFAULT_INTEGRATIONS_SETTINGS: IntegrationsSettings =
  integrationsSettingsSchema.parse({});

export const SETTINGS_CHANNELS = {
  get: 'settings:get',
  set: 'settings:set',
  changed: 'settings:changed',
  orchGet: 'settings:orch:get',
  orchSet: 'settings:orch:set',
  audioGet: 'settings:audio:get',
  audioSet: 'settings:audio:set',
  audioChanged: 'settings:audio:changed',
  shellsList: 'settings:shells:list',
  uiGet: 'settings:ui:get',
  uiSet: 'settings:ui:set',
  uiChanged: 'settings:ui:changed',
} as const;
