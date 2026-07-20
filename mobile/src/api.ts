import type { CompanionStatus } from './types';

/**
 * Client for the Nexus desktop companion relay. The desktop app (see
 * CompanionRelaySection in Settings) exposes a small HTTP endpoint on the
 * local network; the companion polls it for mission status so the operator
 * can monitor agents away from the desk.
 */
export class CompanionClient {
  constructor(private readonly baseUrl: string) {}

  async status(): Promise<CompanionStatus> {
    const res = await fetch(`${this.baseUrl}/status`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`relay respondeu ${res.status}`);
    return (await res.json()) as CompanionStatus;
  }
}

export function createClient(relayUrl: string): CompanionClient {
  return new CompanionClient(relayUrl.replace(/\/$/, ''));
}
