import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import {
  DEFAULT_ONBOARDING,
  ONBOARDING_CHANNELS,
  onboardingPatchSchema,
  onboardingStateSchema,
  type OnboardingState,
} from '../../shared/onboarding-types';

/**
 * Estado do onboarding de primeira execução: ~/.nexus/onboarding.json (mesma
 * convenção do settings/voice). Arquivo ausente/corrompido cai no default —
 * o onboarding nunca pode bloquear o app de abrir.
 */

const FILE = path.join(os.homedir(), '.nexus', 'onboarding.json');
let current: OnboardingState = DEFAULT_ONBOARDING;

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const parsed = onboardingStateSchema.safeParse(raw);
    if (parsed.success) current = parsed.data;
  } catch {
    // Primeiro boot ou arquivo corrompido — mantém o default (não concluído).
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[onboarding] failed to persist:', err);
  }
}

export function registerOnboardingIpc(): void {
  load();

  ipcMain.handle(ONBOARDING_CHANNELS.get, (): OnboardingState => current);

  ipcMain.handle(ONBOARDING_CHANNELS.set, (_e, raw): OnboardingState => {
    const parsed = onboardingPatchSchema.safeParse(raw);
    if (!parsed.success) return current;
    const patch = parsed.data;
    const victories = { ...current.victories };
    // Uma vitória só é registrada UMA vez (o primeiro momento é o que importa).
    if (patch.victory && victories[patch.victory] === undefined) {
      victories[patch.victory] = Date.now();
    }
    current = {
      completed: patch.completed ?? current.completed,
      skipped: patch.skipped ?? current.skipped,
      victories,
    };
    persist();
    return current;
  });
}
