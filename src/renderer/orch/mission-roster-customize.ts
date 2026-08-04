/**
 * Pure helpers for operator-driven roster growth/shrink on Mission REVISAR.
 * Keeps MissionWizard free of more imperative bulk; unit-testable without React.
 */
import type { AdapterInfo } from '../../shared/types';
import type { SquadAgent } from '../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { adapterCapabilityMatrixOf } from '../../shared/adapter-types';

export type CustomizableWorkerCategory = Extract<
  SquadAgent['category'],
  'executor' | 'reviewer' | 'scout'
>;

export const MISSION_ROSTER_MAX_AGENTS = 12;

export function listCustomAgentCliCandidates(
  adapters: readonly AdapterInfo[],
  providers: readonly ProviderSettingsInfo[],
  orchestratorCli: string | undefined,
): AdapterInfo[] {
  return adapters.filter((adapter) => {
    const capabilities = adapterCapabilityMatrixOf(adapter);
    return (
      adapter.kind === 'cli-pty' &&
      adapter.installed &&
      capabilities.launchable &&
      (adapter.id !== 'claude' || orchestratorCli !== 'claude') &&
      providers.find((provider) => provider.adapterId === adapter.id)
        ?.enabled !== false
    );
  });
}

export function buildCustomRosterAgent(input: {
  readonly category: CustomizableWorkerCategory;
  readonly roster: readonly SquadAgent[];
  readonly adapters: readonly AdapterInfo[];
  readonly providers: readonly ProviderSettingsInfo[];
  readonly now?: number;
}):
  | { readonly ok: true; readonly agent: SquadAgent }
  | { readonly ok: false; readonly error: string } {
  if (input.roster.length >= MISSION_ROSTER_MAX_AGENTS) {
    return { ok: false, error: 'Limite de 12 integrantes por missão.' };
  }
  const orchCli = input.roster.find((a) => a.category === 'orchestrator')?.cli;
  const candidates = listCustomAgentCliCandidates(
    input.adapters,
    input.providers,
    orchCli,
  );
  const used = new Set(input.roster.map((a) => a.cli));
  const adapter =
    candidates.find((c) => !used.has(c.id)) ?? candidates[0] ?? null;
  if (!adapter) {
    return {
      ok: false,
      error:
        'Nenhuma CLI instalada disponível para um novo integrante. Conecte um provider em Configurações.',
    };
  }
  const model =
    adapter.models.default?.trim() ||
    adapter.models.list.find((m) => m.trim()) ||
    '';
  if (!model) {
    return {
      ok: false,
      error: `A CLI ${adapter.label} não expõe modelos utilizáveis.`,
    };
  }
  const ordinal =
    input.roster.filter((a) => a.category === input.category).length + 1;
  const labels: Record<CustomizableWorkerCategory, string> = {
    executor: ordinal === 1 ? 'Executor' : `Executor ${ordinal}`,
    reviewer: ordinal === 1 ? 'Revisor / QA' : `Revisor ${ordinal}`,
    scout: ordinal === 1 ? 'Scout' : `Scout ${ordinal}`,
  };
  const stamp = (input.now ?? Date.now()).toString(36);
  return {
    ok: true,
    agent: {
      id: `custom-${input.category}-${stamp}`,
      agentName: labels[input.category],
      category: input.category,
      cli: adapter.id,
      model,
      effort: 'medium',
      allowedTools:
        input.category === 'executor'
          ? ['Bash', 'Read', 'Edit']
          : ['Bash', 'Read'],
      allowedSkills: [],
    },
  };
}

export function planRemoveRosterAgent(
  roster: readonly SquadAgent[],
  id: string,
):
  | { readonly ok: true; readonly next: SquadAgent[] }
  | { readonly ok: false; readonly error: string } {
  const target = roster.find((a) => a.id === id);
  if (!target) {
    return { ok: false, error: 'Integrante não encontrado na equipe.' };
  }
  if (target.category === 'orchestrator') {
    return { ok: false, error: 'O Maestro não pode ser removido.' };
  }
  const workers = roster.filter((a) => a.category !== 'orchestrator');
  if (workers.length <= 1) {
    return {
      ok: false,
      error: 'Mantenha ao menos um worker além do Maestro.',
    };
  }
  return {
    ok: true,
    next: roster.filter((a) => a.id !== id),
  };
}
