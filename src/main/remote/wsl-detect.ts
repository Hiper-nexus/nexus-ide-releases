// Adapted from stablyai/orca WSL detection patterns @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure detect helpers;
// real WSL runtime validation pending on Windows hosts.

export type WslPresence = {
  readonly available: boolean;
  readonly reason: string;
};

export function detectWslFromEnv(env: NodeJS.ProcessEnv = process.env): WslPresence {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return { available: true, reason: 'wsl-env' };
  }
  if ((env.OS ?? '').toLowerCase().includes('windows') || env.SystemRoot) {
    return { available: false, reason: 'windows-host-wsl-unverified' };
  }
  return { available: false, reason: 'not-windows' };
}
