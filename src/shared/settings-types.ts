import { z } from 'zod';

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
    .refine((value) => value === '' || value.startsWith('/'), {
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
    .refine((value) => value === '' || value.startsWith('/'), {
      message: 'shell must be an absolute path',
    })
    .optional(),
});
export type TerminalSettingsPatch = z.infer<typeof terminalSettingsPatchSchema>;

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
});
export type OrchSettings = z.infer<typeof orchSettingsSchema>;
export const DEFAULT_ORCH_SETTINGS: OrchSettings = orchSettingsSchema.parse({});

export const SETTINGS_CHANNELS = {
  get: 'settings:get',
  set: 'settings:set',
  changed: 'settings:changed',
  orchGet: 'settings:orch:get',
  orchSet: 'settings:orch:set',
} as const;
