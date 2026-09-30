import { assertLicenseAccess } from '../license-enforcement';
import { licenseFailure, type LicenseErrorCode, type LicenseDenialReason } from '../../shared/license-errors';
/**
 * BYOH (Bring Your Own Harness) catalog — backed by OrchSettings so the
 * existing settings IPC (orchGet/orchSet) is the real save path used at spawn.
 *
 * Presets come from `harness-catalog.ts`. Custom definitions live in
 * `orch.acpCustomHarnesses`; selection in `orch.acpHarnessId`.
 */
import {
  PRESET_HARNESSES,
  parseHarnessDefinition,
  type HarnessDefinition,
} from '../../shared/harness-catalog';
import {
  getOrchSettings,
  replaceOrchSettings,
} from '../persistence/settings-store';
import type { AcpClient } from './acp-client';

export interface AcpHarnessCatalogState {
  readonly customs: readonly HarnessDefinition[];
  /** Selected harness id used when orch.agentTransport === 'acp'. */
  readonly selectedId: string | null;
}

export interface AcpHarnessProbeResult {
  readonly ok: boolean;
  readonly harnessId: string;
  readonly detail: string;
  readonly pid?: number;
  readonly code?: LicenseErrorCode;
  readonly blockedReason?: LicenseDenialReason;
}

function freezeState(state: AcpHarnessCatalogState): AcpHarnessCatalogState {
  return Object.freeze({
    customs: Object.freeze([...state.customs]),
    selectedId: state.selectedId,
  });
}

function parseCustoms(raw: readonly Record<string, unknown>[]): HarnessDefinition[] {
  const customs: HarnessDefinition[] = [];
  for (const entry of raw) {
    const parsed = parseHarnessDefinition(entry, 'custom');
    if (parsed.ok) customs.push(parsed.harness);
  }
  return customs;
}

export function loadAcpHarnessCatalog(): AcpHarnessCatalogState {
  const orch = getOrchSettings();
  const customs = parseCustoms(orch.acpCustomHarnesses);
  const selectedId =
    orch.acpHarnessId.trim().length > 0 ? orch.acpHarnessId.trim() : null;
  return freezeState({ customs, selectedId });
}

export function listAcpHarnesses(): readonly HarnessDefinition[] {
  const state = loadAcpHarnessCatalog();
  return Object.freeze([...PRESET_HARNESSES, ...state.customs]);
}

export function getAcpHarness(id: string): HarnessDefinition | null {
  return listAcpHarnesses().find((harness) => harness.id === id) ?? null;
}

export function getSelectedAcpHarnessId(): string | null {
  return loadAcpHarnessCatalog().selectedId;
}

function writeCatalog(state: AcpHarnessCatalogState): void {
  replaceOrchSettings({
    acpCustomHarnesses: state.customs.map((h) => ({
      id: h.id,
      label: h.label,
      command: h.command,
      args: [...h.args],
      env: { ...h.env },
      ...(h.installInstructionsUrl
        ? { installInstructionsUrl: h.installInstructionsUrl }
        : {}),
      ...(h.installHint ? { installHint: h.installHint } : {}),
    })),
    acpHarnessId: state.selectedId ?? '',
  });
}

export function saveCustomAcpHarness(
  input: unknown,
):
  | { ok: true; harness: HarnessDefinition; state: AcpHarnessCatalogState }
  | { ok: false; errors: readonly string[] } {
  const parsed = parseHarnessDefinition(input, 'custom');
  if (!parsed.ok) return parsed;
  const state = loadAcpHarnessCatalog();
  const customs = state.customs.filter((h) => h.id !== parsed.harness.id);
  customs.push(parsed.harness);
  const next = freezeState({
    customs,
    selectedId: state.selectedId ?? parsed.harness.id,
  });
  writeCatalog(next);
  return { ok: true, harness: parsed.harness, state: next };
}

export function deleteCustomAcpHarness(
  id: string,
):
  | { ok: true; state: AcpHarnessCatalogState }
  | { ok: false; error: string } {
  const state = loadAcpHarnessCatalog();
  if (!state.customs.some((h) => h.id === id)) {
    return { ok: false, error: `custom harness not found: ${id}` };
  }
  const customs = state.customs.filter((h) => h.id !== id);
  const selectedId =
    state.selectedId === id
      ? (PRESET_HARNESSES[0]?.id ?? null)
      : state.selectedId;
  const next = freezeState({ customs, selectedId });
  writeCatalog(next);
  return { ok: true, state: next };
}

export function selectAcpHarness(
  id: string,
):
  | { ok: true; state: AcpHarnessCatalogState }
  | { ok: false; error: string } {
  if (!getAcpHarness(id)) {
    return { ok: false, error: `unknown harness id: ${id}` };
  }
  const state = loadAcpHarnessCatalog();
  const next = freezeState({ customs: state.customs, selectedId: id });
  writeCatalog(next);
  return { ok: true, state: next };
}

/**
 * Probe: spawn → initialize → shutdown. Does not open a durable session and
 * never falls back to PTY. Used by the Settings "Testar conexão" action.
 */
export async function probeAcpHarness(
  id: string,
  options: { cwd?: string; requestTimeoutMs?: number } = {},
): Promise<AcpHarnessProbeResult> {
  try { assertLicenseAccess(); } catch (error) {
    const failure = licenseFailure(error);
    if (failure) return { ...failure, harnessId: id, detail: failure.error };
    throw error;
  }
  const harness = getAcpHarness(id);
  if (!harness) {
    return {
      ok: false,
      harnessId: id,
      detail: `harness "${id}" não encontrado no catálogo`,
    };
  }
  const { AcpClient, AcpClientError } = await import('./acp-client');
  let client: AcpClient | null = null;
  try {
    client = AcpClient.spawn({
      command: harness.command,
      args: harness.args,
      cwd: options.cwd ?? process.cwd(),
      env: harness.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    });
    const init = await client.initialize();
    const pid = client.pid;
    await client.shutdown();
    return {
      ok: true,
      harnessId: id,
      detail: `ACP ok — ${init.agentInfo?.name ?? harness.label} v${
        init.agentInfo?.version ?? '?'
      }`,
      pid,
    };
  } catch (error) {
    if (client) {
      try {
        await client.shutdown();
      } catch {
        /* already dead */
      }
    }
    const detail =
      error instanceof AcpClientError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, harnessId: id, detail, ...licenseFailure(error) };
  }
}
