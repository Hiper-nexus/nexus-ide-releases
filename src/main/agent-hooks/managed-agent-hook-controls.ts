// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: installers injected via
// registry instead of ORCA per-agent hook-service modules; settings pick uses a
// local shape (no GlobalSettings monolith). Install is optional until Nexus
// provider hook scripts land.

import type {
  AgentHookInstallStatus,
  AgentHookTarget,
} from '../../shared/agent-hook-types';

export type HookInstallAgent = AgentHookTarget;

export type ManagedAgentHookService = {
  install: () => void;
  remove: () => AgentHookInstallStatus;
  getStatus: () => AgentHookInstallStatus;
};

export type ManagedAgentHookInstaller = readonly [HookInstallAgent, () => void];

type ManagedHookRemover = readonly [HookInstallAgent, () => AgentHookInstallStatus];
type ManagedHookStatusReader = readonly [
  HookInstallAgent,
  () => AgentHookInstallStatus,
];

/** Empty until Nexus registers provider-specific managed hook installers. */
let registeredServices = new Map<HookInstallAgent, ManagedAgentHookService>();

export function registerManagedAgentHookService(
  agent: HookInstallAgent,
  service: ManagedAgentHookService,
): void {
  registeredServices = new Map(registeredServices).set(agent, service);
}

export function clearManagedAgentHookServices(): void {
  registeredServices = new Map();
}

function installers(): readonly ManagedAgentHookInstaller[] {
  return [...registeredServices.entries()].map(([agent, service]) => [
    agent,
    () => service.install(),
  ]);
}

function removers(): readonly ManagedHookRemover[] {
  return [...registeredServices.entries()].map(([agent, service]) => [
    agent,
    () => service.remove(),
  ]);
}

function statusReaders(): readonly ManagedHookStatusReader[] {
  return [...registeredServices.entries()].map(([agent, service]) => [
    agent,
    () => service.getStatus(),
  ]);
}

/** @deprecated Prefer installers() from registry — kept for ORCA call-site shape. */
export const MANAGED_AGENT_HOOK_INSTALLERS: readonly ManagedAgentHookInstaller[] =
  [];

export function isAgentStatusHooksEnabled(
  settings: { agentStatusHooksEnabled?: boolean } | null | undefined,
): boolean {
  return settings?.agentStatusHooksEnabled !== false;
}

export function installManagedAgentHooks(): void {
  for (const [agent, install] of installers()) {
    try {
      install();
    } catch (error) {
      console.warn(`[agent-hooks] Failed to install ${agent} managed hooks:`, error);
    }
  }
}

function errorStatus(agent: HookInstallAgent, error: unknown): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error),
  };
}

export function removeManagedAgentHooks(): AgentHookInstallStatus[] {
  return removers().map(([agent, remove]) => {
    try {
      return remove();
    } catch (error) {
      return errorStatus(agent, error);
    }
  });
}

export function getManagedAgentHookStatuses(): AgentHookInstallStatus[] {
  return statusReaders().map(([agent, getStatus]) => {
    try {
      return getStatus();
    } catch (error) {
      return errorStatus(agent, error);
    }
  });
}

export function applyAgentStatusHooksEnabled(
  enabled: boolean,
): AgentHookInstallStatus[] {
  if (enabled) {
    installManagedAgentHooks();
    return getManagedAgentHookStatuses();
  }
  return removeManagedAgentHooks();
}
