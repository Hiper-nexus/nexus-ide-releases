import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import type { AdapterInfo } from '../../shared/adapter-types';
import { handleTrusted } from '../security/trusted-ipc';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_INTEGRATIONS_SETTINGS,
  DEFAULT_ORCH_SETTINGS,
  DEFAULT_SPEND_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_UI_SETTINGS,
  DEFAULT_VISION_SETTINGS,
  SETTINGS_CHANNELS,
  audioSettingsPatchSchema,
  audioSettingsSchema,
  integrationsSettingsSchema,
  mergeOrchSettingsPatch,
  orchSettingsSchema,
  spendSettingsPatchSchema,
  spendSettingsSchema,
  terminalSettingsPatchSchema,
  terminalSettingsSchema,
  uiSettingsPatchSchema,
  uiSettingsSchema,
  visionSettingsSchema,
  type AudioSettings,
  type IntegrationsSettings,
  type OrchSettings,
  type SpendSettings,
  type TerminalSettings,
  type UiSettings,
  type VisionSettings,
} from '../../shared/settings-types';
import {
  listAvailableShells,
  resolveConfiguredShell,
} from './shell-catalog';
import { setRuntimeOutputDeviceId } from '../voice/audio-output-runtime';
import { writeJsonFileAtomic } from './atomic-json-file';
import { planRetiredOrchestratorSettingsMigration } from './settings-retired-adapter-migration';
import {
  applyVibeNoSandboxFloor,
  type VibeProductMigrations,
} from './vibe-product-floor';
import { applyPinkCityDefaultTheme } from './pink-city-default-migration';
import { bumpDecisionCredentialRevision } from '../decision-models/decision-revision';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';
import {
  accountSwitchProjection,
  currentDecisionAccountId,
  decisionAccountBookFile,
  onDecisionAccountChanged,
  readDecisionAccountBook,
  withAccountSettings,
  writeDecisionAccountBook,
} from '../decision-models/decision-accounts';

/**
 * Terminal settings store: ~/.nexus/settings.json (same user-dir convention
 * as the voice config). Invalid or missing files fall back to defaults —
 * settings must never block the terminal from opening.
 */

/**
 * F-932: sob vitest o arquivo NUNCA é o do operador. Um teste que chama
 * `replaceOrchSettings` sem ter carregado nada grava os PADRÕES por cima do
 * `~/.nexus/settings.json` real — o Clef voltava para "Somente Jev" com o
 * Account ID vazio toda vez que um agente rodava a suíte.
 */
export function resolveSettingsFile(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.VITEST
    ? path.join(os.tmpdir(), `nexus-vitest-settings-${process.pid}`, 'settings.json')
    : path.join(os.homedir(), '.nexus', 'settings.json');
}

const SETTINGS_FILE = resolveSettingsFile();
// Separate authority: old Nexus copies rewrite settings.json without knowing
// decisionModels, and an unrelated invalid orch field must not erase it.
const DECISION_SETTINGS_FILE = path.join(path.dirname(SETTINGS_FILE), 'decision-models.json');

function loadDecisionPreferences(legacy: unknown): DecisionSettings | null {
  let missing = false;
  try {
    const raw = JSON.parse(fs.readFileSync(DECISION_SETTINGS_FILE, 'utf8'));
    const complete = raw && typeof raw === 'object' &&
      ['mode', 'clefModel', 'cloudflareAccountId', 'visionEnabled'].every(key => Object.hasOwn(raw, key));
    const saved = complete ? decisionSettingsSchema.safeParse(raw) : null;
    if (saved?.success) return saved.data;
  } catch (error) {
    missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (legacy === undefined) return null;
  const parsed = decisionSettingsSchema.safeParse(legacy);
  if (!parsed.success) return null;
  // An existing but invalid authority cannot restore older egress consent.
  // Keep a validated Account ID available for repair, with Cloudflare off.
  if (!missing) return { ...parsed.data, mode: 'jev', visionEnabled: false };
  // Only migrate an absent file. Preserve a corrupt/unreadable file for
  // recovery; an explicit successful user save may replace it later.
  if (missing) {
    try { writeJsonFileAtomic(DECISION_SETTINGS_FILE, parsed.data); }
    catch { console.warn('[settings] could not migrate decision preferences'); }
  }
  return parsed.data;
}

type ProductMigrations = VibeProductMigrations;

let current: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;
let orchSettings: OrchSettings = DEFAULT_ORCH_SETTINGS;
let audioSettings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
let visionSettings: VisionSettings = DEFAULT_VISION_SETTINGS;
let uiSettings: UiSettings = DEFAULT_UI_SETTINGS;
let integrationsSettings: IntegrationsSettings = DEFAULT_INTEGRATIONS_SETTINGS;
let spendSettings: SpendSettings = DEFAULT_SPEND_SETTINGS;
let productMigrations: ProductMigrations = {};
const listeners = new Set<WebContents>();
const audioListeners = new Set<WebContents>();
const uiListeners = new Set<WebContents>();
const spendListeners = new Set<WebContents>();

function load(): void {
  let floorChanged = false;
  let legacyDecisionSettings: unknown;

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    legacyDecisionSettings = raw?.orch?.decisionModels;
    const parsed = terminalSettingsSchema.safeParse(raw?.terminal ?? raw);
    if (parsed.success) {
      try {
        if (parsed.data.shell) {
          resolveConfiguredShell(
            parsed.data.shell,
            parsed.data.shell,
            listAvailableShells(),
          );
        }
        current = parsed.data;
      } catch {
        current = { ...parsed.data, shell: '' };
      }
    }
    const orchParsed = orchSettingsSchema.safeParse(raw?.orch ?? {});
    if (orchParsed.success) orchSettings = orchParsed.data;
    const audioParsed = audioSettingsSchema.safeParse(raw?.audio ?? {});
    if (audioParsed.success) {
      audioSettings = audioParsed.data;
      setRuntimeOutputDeviceId(audioSettings.outputDeviceId);
    }
    const visionParsed = visionSettingsSchema.safeParse(raw?.vision ?? {});
    if (visionParsed.success) visionSettings = visionParsed.data;
    const uiParsed = uiSettingsSchema.safeParse(raw?.ui ?? {});
    if (uiParsed.success) uiSettings = uiParsed.data;
    const integrationsParsed = integrationsSettingsSchema.safeParse(
      raw?.integrations ?? {},
    );
    if (integrationsParsed.success) integrationsSettings = integrationsParsed.data;
    const spendParsed = spendSettingsSchema.safeParse(raw?.spend ?? {});
    if (spendParsed.success) spendSettings = spendParsed.data;
    if (
      raw?.productMigrations &&
      typeof raw.productMigrations === 'object' &&
      !Array.isArray(raw.productMigrations)
    ) {
      productMigrations = {
        ...productMigrations,
        ...(raw.productMigrations as ProductMigrations),
      };
    }
    // Product floor: no process sandbox + no handoff crypto for everyone
    // unless they later opt into Hardened in Settings. One-shot stamp.
    const floor = applyVibeNoSandboxFloor({
      orch: orchSettings,
      productMigrations,
    });
    if (floor.changed) {
      orchSettings = floor.orch;
      productMigrations = floor.productMigrations;
      floorChanged = true;
    }
  } catch {
    // Missing/corrupt file — keep defaults.
  }

  const decisionPreferences = loadDecisionPreferences(legacyDecisionSettings);
  if (decisionPreferences) orchSettings = { ...orchSettings, decisionModels: decisionPreferences };

  const pinkCity = applyPinkCityDefaultTheme({
    terminal: current,
    productMigrations,
  });
  if (pinkCity.changed) {
    current = pinkCity.terminal;
    productMigrations = pinkCity.productMigrations;
  }

  if (floorChanged || pinkCity.changed) {
    try {
      persist();
      if (floorChanged) {
        console.info(
          '[settings] Autopilot floor: sem sandbox de processo e sem ' +
            'atestação crypto no handoff (Hardened só se o operador mudar).',
        );
      }
    } catch {
      // Keep in-memory migrations even if disk is read-only this boot.
    }
  }
}

interface SettingsSnapshot {
  terminal: TerminalSettings;
  orch: OrchSettings;
  audio: AudioSettings;
  vision: VisionSettings;
  ui: UiSettings;
  integrations: IntegrationsSettings;
  spend: SpendSettings;
  productMigrations: ProductMigrations;
}

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    terminal: current,
    orch: orchSettings,
    audio: audioSettings,
    vision: visionSettings,
    ui: uiSettings,
    integrations: integrationsSettings,
    spend: spendSettings,
    productMigrations,
    ...overrides,
  };
}

function persist(next = snapshot(), saveDecisionPreferences = false): void {
  try {
    writeJsonFileAtomic(SETTINGS_FILE, next);
    if (saveDecisionPreferences) {
      writeJsonFileAtomic(DECISION_SETTINGS_FILE, next.orch.decisionModels);
      const accountId = currentDecisionAccountId();
      if (accountId) {
        const bookFile = decisionAccountBookFile(SETTINGS_FILE);
        writeDecisionAccountBook(bookFile, withAccountSettings(readDecisionAccountBook(bookFile), accountId, next.orch.decisionModels));
      }
    }
    if (next.productMigrations) {
      productMigrations = next.productMigrations;
    }
  } catch (error) {
    console.error('[settings] failed to persist settings atomically:', error);
    throw new Error('Não foi possível salvar as configurações do Nexus.', {
      cause: error,
    });
  }
}

function broadcast(): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.changed, current);
  }
}

function broadcastUi(): void {
  for (const wc of uiListeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.uiChanged, uiSettings);
  }
}

function broadcastSpend(): void {
  for (const wc of spendListeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.spendChanged, spendSettings);
  }
}

function broadcastAudio(): void {
  for (const wc of audioListeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.audioChanged, audioSettings);
  }
}

export function getTerminalSettings(): TerminalSettings {
  return current;
}

export function getOrchSettings(): OrchSettings {
  return orchSettings;
}

/**
 * Main-process patch of orch settings (BYOH catalog, transport, probe
 * results). Validates through the same Zod schema as the IPC orchSet path.
 */
export function replaceOrchSettings(patch: Partial<OrchSettings>): OrchSettings {
  const parsed = orchSettingsSchema.safeParse(mergeOrchSettingsPatch(orchSettings, patch));
  if (!parsed.success) return orchSettings;
  persist(snapshot({ orch: parsed.data }), patch.decisionModels !== undefined);
  const changedDecisionModels = JSON.stringify(orchSettings.decisionModels) !== JSON.stringify(parsed.data.decisionModels);
  orchSettings = parsed.data;
  if (changedDecisionModels) bumpDecisionCredentialRevision();
  return orchSettings;
}

function scheduleAcpHarnessProbe(request: {
  readonly id: string;
  readonly requestId: string;
}): void {
  void import('../acp/harness-store')
    .then(({ probeAcpHarness }) => probeAcpHarness(request.id))
    .then((result) => {
      replaceOrchSettings({
        acpHarnessProbeRequest: null,
        acpHarnessLastProbe: {
          requestId: request.requestId,
          harnessId: result.harnessId,
          ok: result.ok,
          detail: result.detail,
          at: Date.now(),
        },
      });
    })
    .catch((error: unknown) => {
      replaceOrchSettings({
        acpHarnessProbeRequest: null,
        acpHarnessLastProbe: {
          requestId: request.requestId,
          harnessId: request.id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        },
      });
    });
}

/**
 * One-way boot migration for defaults that reference a provider removed from
 * the live catalog. The complete settings snapshot is replaced atomically
 * before the in-memory value changes, so a failed disk write keeps the prior
 * state intact and visible instead of creating a split-brain launch default.
 */
export function migrateRetiredOrchestratorSettings(input: {
  readonly adapters: readonly AdapterInfo[];
  readonly enabledAdapterIds: ReadonlySet<string>;
}): OrchSettings {
  const migration = planRetiredOrchestratorSettingsMigration({
    settings: orchSettings,
    adapters: input.adapters,
    enabledAdapterIds: input.enabledAdapterIds,
  });
  if (!migration.changed) return orchSettings;
  persist(snapshot({ orch: migration.settings }));
  orchSettings = migration.settings;
  console.info(
    `[settings] migrated retired orchestrator default ` +
      `${migration.previousAdapterId} -> ${migration.fallbackAdapterId}` +
      (migration.fallbackInstalled ? '' : ' (install/login required)'),
  );
  return orchSettings;
}

export function getAudioSettings(): AudioSettings {
  return audioSettings;
}

export function getVisionSettings(): VisionSettings {
  return visionSettings;
}

export function getUiSettings(): UiSettings {
  return uiSettings;
}

export function getIntegrationsSettings(): IntegrationsSettings {
  return integrationsSettings;
}

export function setVisionSettingsPatch(
  patch: Partial<VisionSettings>,
): VisionSettings {
  const parsed = visionSettingsSchema.safeParse({
    ...visionSettings,
    ...patch,
  });
  if (parsed.success) {
    persist(snapshot({ vision: parsed.data }));
    visionSettings = parsed.data;
  }
  return visionSettings;
}

export function registerSettingsListener(wc: WebContents): void {
  listeners.add(wc);
  audioListeners.add(wc);
  uiListeners.add(wc);
  spendListeners.add(wc);
}

export function unregisterSettingsListener(wc: WebContents): void {
  listeners.delete(wc);
  audioListeners.delete(wc);
  uiListeners.delete(wc);
  spendListeners.delete(wc);
}

/** A preferência de julgamento segue a conta logada. Logout não apaga as outras linhas. */
export function applyDecisionAccount(accountId: string | null): void {
  const bookFile = decisionAccountBookFile(SETTINGS_FILE);
  const book = readDecisionAccountBook(bookFile);
  const projection = decisionSettingsSchema.parse(orchSettings.decisionModels ?? {});
  const next = accountSwitchProjection(book, accountId, projection);
  if (next.book !== book) {
    try { writeDecisionAccountBook(bookFile, next.book); }
    catch { console.warn('[settings] could not claim decision preferences'); }
  }
  const changed = JSON.stringify(orchSettings.decisionModels) !== JSON.stringify(next.settings);
  if (changed || accountId === null) {
    orchSettings = { ...orchSettings, decisionModels: next.settings };
    try { writeJsonFileAtomic(DECISION_SETTINGS_FILE, next.settings); }
    catch { console.warn('[settings] could not project decision preferences'); }
  }
  if (changed) bumpDecisionCredentialRevision();
}

export function registerSettingsIpc(): void {
  load();
  onDecisionAccountChanged(applyDecisionAccount);
  try {
    const { getAuthenticatedAccountId } = require('../auth-client') as typeof import('../auth-client');
    const id = getAuthenticatedAccountId();
    if (id) applyDecisionAccount(id);
  } catch { /* sem sessão, a projeção legada continua valendo */ }

  ipcMain.handle(SETTINGS_CHANNELS.get, () => current);

  handleTrusted(SETTINGS_CHANNELS.set, (_event, raw) => {
    const parsed = terminalSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return current;
    const next = { ...current, ...parsed.data };
    if (next.shell) {
      try {
        resolveConfiguredShell(next.shell, next.shell, listAvailableShells());
      } catch {
        return current;
      }
    }
    persist(snapshot({ terminal: next }));
    current = next;
    broadcast();
    return current;
  });

  ipcMain.handle(SETTINGS_CHANNELS.orchGet, () => orchSettings);

  handleTrusted(SETTINGS_CHANNELS.orchSet, (_event, raw) => {
    const previousProbeRequestId = orchSettings.acpHarnessProbeRequest?.requestId;
    // F-1167: `jevSurfaces` parcial é mesclado ao atual (sem corrida entre telas).
    const parsed = orchSettingsSchema.safeParse(mergeOrchSettingsPatch(orchSettings, raw));
    if (parsed.success) {
      const next = {
        ...parsed.data,
        // Probe request is a one-shot trigger — never leave it sticky on disk.
        acpHarnessProbeRequest: null,
      };
      persist(snapshot({ orch: next }), raw != null && Object.hasOwn(raw, 'decisionModels'));
      const changedDecisionModels = JSON.stringify(orchSettings.decisionModels) !== JSON.stringify(next.decisionModels);
      orchSettings = next;
      if (changedDecisionModels) bumpDecisionCredentialRevision();
      const probe = parsed.data.acpHarnessProbeRequest;
      if (
        probe &&
        probe.requestId.length > 0 &&
        probe.requestId !== previousProbeRequestId
      ) {
        scheduleAcpHarnessProbe(probe);
      }
    }
    return orchSettings;
  });

  ipcMain.handle(SETTINGS_CHANNELS.audioGet, () => audioSettings);

  handleTrusted(SETTINGS_CHANNELS.audioSet, (_event, raw) => {
    const parsed = audioSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return audioSettings;
    const next = { ...audioSettings, ...parsed.data };
    persist(snapshot({ audio: next }));
    audioSettings = next;
    setRuntimeOutputDeviceId(next.outputDeviceId);
    broadcastAudio();
    return audioSettings;
  });

  ipcMain.handle(SETTINGS_CHANNELS.shellsList, () => listAvailableShells());

  ipcMain.handle(SETTINGS_CHANNELS.uiGet, () => uiSettings);

  handleTrusted(SETTINGS_CHANNELS.uiSet, (_event, raw) => {
    const parsed = uiSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return uiSettings;
    const next = { ...uiSettings, ...parsed.data };
    persist(snapshot({ ui: next }));
    uiSettings = next;
    broadcastUi();
    return uiSettings;
  });

  handleTrusted(SETTINGS_CHANNELS.spendGet, () => spendSettings);

  // A lista vem inteira (o cartão é a única tela que edita): substitui, não mescla.
  handleTrusted(SETTINGS_CHANNELS.spendSet, (_event, raw) => {
    const parsed = spendSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return spendSettings;
    const next = spendSettingsSchema.parse({ ...spendSettings, ...parsed.data });
    persist(snapshot({ spend: next }));
    spendSettings = next;
    broadcastSpend();
    return spendSettings;
  });
}
