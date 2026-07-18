import { z } from 'zod';

function isAbsoluteShellPath(value: string): boolean {
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
  'nexus-dark',
  'nexus-light',
  'dracula',
  'solarized-dark',
] as const;

export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number];

export const terminalSettingsSchema = z.object({
  themeId: z.enum(TERMINAL_THEME_IDS).default('nexus-dark'),
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
    .refine(isAbsoluteShellPath, {
      message: 'shell must be an absolute path',
    })
    .default(''),
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
    .refine(isAbsoluteShellPath, {
      message: 'shell must be an absolute path',
    })
    .optional(),
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
  /** Modo sóbrio: oculta HUD/celebrações/narração da gamificação (o XP
   *  continua acumulando em silêncio). */
  soberMode: z.boolean().default(false),
  /** Mission driver ativo (Fase C): aplica efeitos autônomos (advance/complete/
   *  signal-stall/respawn) com budget. Default true: o Ralph coordena missões
   *  autopilot; false permanece como opt-out/shadow. Exige restart para aplicar. */
  missionDriverActiveMode: z.boolean().default(true),
  /**
   * When a saved layout with mission agents is restored (app start, workspace
   * open, any OS — macOS / Linux / Windows, same code path):
   * - `ask` (default, safe): hold agents and confirm before they run
   * - `pause`: never auto-start; user must retomar no rail
   * - `resume`: legacy silent auto-resume (power users only)
   */
  agentRestorePolicy: z.enum(['ask', 'pause', 'resume']).default('ask'),
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
   * How Oh My Pi (omp) participates in auto-routing and squad roster sticky:
   * - `off`: never force; only explicit manual spawn
   * - `fallback`: late ladder only (legacy)
   * - `diversity`: multi-CLI share — omp second when unused
   * - `prefer` (default): omp first among eligible workers (vibe-coder zero-friction)
   *
   * When not `off`/`fallback`, the system also auto-spawns one omp companion
   * worker on the first non-omp mission spawn (no human / Maestro required).
   */
  ompParticipation: z
    .enum(['off', 'fallback', 'diversity', 'prefer'])
    .default('prefer'),
  /**
   * When true, opening the OMP RPC panel starts a session automatically if
   * none is active (install/auth failures still surface as startError).
   */
  ompRpcAutoStart: z.boolean().default(true),
  /**
   * How mission/orchestrator spawns of adapter `omp` are hosted:
   * - `pty`: terminal pane with full Nexus MCP inject
   * - `rpc`: `omp --mode rpc-ui` pipes + host tools
   * - `auto` (default): try rpc first, fall back to pty on bin/protocol failure
   */
  ompMissionTransport: z.enum(['pty', 'rpc', 'auto']).default('auto'),
  /**
   * Auto-spawn one Oh My Pi worker on missions without human action.
   * Default true for vibe-coder zero friction; disable only for pure routing demos.
   */
  ompAutoSpawn: z.boolean().default(true),
});
export type OrchSettings = z.infer<typeof orchSettingsSchema>;
export const DEFAULT_ORCH_SETTINGS: OrchSettings = orchSettingsSchema.parse({});
export type OmpParticipation = OrchSettings['ompParticipation'];
export type OmpMissionTransport = OrchSettings['ompMissionTransport'];

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
