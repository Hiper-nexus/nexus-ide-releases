import path from 'node:path';
import type { CliInstallRecipe } from './cli-install-recipes';
import { selectCliUpdateRecipe } from './cli-install-recipes';

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export function shouldOfferAutoCliConsent(
  preferences: { readonly enabled: boolean; readonly askAgainAt?: number } | null,
  now: number,
): boolean {
  return !preferences || (!preferences.enabled && now >= (preferences.askAgainAt ?? 0));
}

/** Prevent the manual button and background runner from updating one CLI together. */
export class CliUpdateLease {
  private active: string | null = null;
  private provisioning = false;
  private autoConsent = false;
  private readonly spawning = new Map<string, number>();
  private readonly spawnWaiters = new Map<string, Array<(release: () => void) => void>>();

  isHeld(adapterId: string): boolean {
    return this.active === adapterId;
  }

  isProvisioning(): boolean {
    return this.provisioning;
  }

  beginProvisioning(): boolean {
    if (this.provisioning || this.active || this.autoConsent) return false;
    this.provisioning = true;
    return true;
  }

  endProvisioning(): void {
    this.provisioning = false;
  }

  beginAutoConsent(): boolean {
    if (this.provisioning || this.autoConsent || this.active) return false;
    this.autoConsent = true;
    return true;
  }

  endAutoConsent(): void {
    this.autoConsent = false;
  }

  acquire(adapterId: string, owner: 'manual' | 'provisioning' = 'manual'): boolean {
    if (this.active || this.autoConsent || (this.provisioning && owner !== 'provisioning') ||
        (this.spawning.get(adapterId) ?? 0) > 0) return false;
    this.active = adapterId;
    return true;
  }

  release(adapterId: string): void {
    if (this.active !== adapterId) return;
    this.active = null;
    const waiters = this.spawnWaiters.get(adapterId) ?? [];
    this.spawnWaiters.delete(adapterId);
    for (const grant of waiters) grant(this.grantSpawnPermit(adapterId));
  }

  private grantSpawnPermit(adapterId: string): () => void {
    this.spawning.set(adapterId, (this.spawning.get(adapterId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.spawning.get(adapterId) ?? 1) - 1;
      if (count > 0) this.spawning.set(adapterId, count);
      else this.spawning.delete(adapterId);
    };
  }

  acquireSpawnPermit(adapterId: string): Promise<() => void> {
    if (this.active !== adapterId) return Promise.resolve(this.grantSpawnPermit(adapterId));
    return new Promise((resolve) => {
      const waiters = this.spawnWaiters.get(adapterId) ?? [];
      waiters.push(resolve);
      this.spawnWaiters.set(adapterId, waiters);
    });
  }
}

/** Remote scripts, WinGet and privileged installers require the manual flow. */
export function isSafeAutomaticCliRecipe(recipe: CliInstallRecipe): boolean {
  if (recipe.kind !== 'argv') return false;
  const command = recipe.runner.toLowerCase();
  return command !== 'winget' && command !== 'sudo' &&
    !recipe.argv.includes('--cask') &&
    !recipe.argv.some((arg) => /^(?:--global|--system)$/iu.test(arg));
}

type AutoUpdateInput = Parameters<typeof selectCliUpdateRecipe>[0] & {
  readonly isTargetWritable: (targetPath: string) => boolean;
};

/** A background update may only touch a recognized, writable user install. */
export function selectAutomaticCliUpdateRecipe(input: AutoUpdateInput): CliInstallRecipe | null {
  const selection = selectCliUpdateRecipe(input);
  if (!selection?.ok || !isSafeAutomaticCliRecipe(selection.recipe)) return null;
  if (!input.isTargetWritable(input.binPath) || !input.isTargetWritable(input.realBinPath)) {
    return null;
  }
  if (selection.recipe.kind === 'argv' && selection.recipe.runner === input.binPath) {
    const hostPath = input.platform === 'win32' ? path.win32 : path.posix;
    const home = input.userHome;
    if (!home) return null;
    const relative = hostPath.relative(home, input.realBinPath);
    if (!relative || relative === '..' || relative.startsWith(`..${hostPath.sep}`) ||
        hostPath.isAbsolute(relative)) return null;
  }
  return selection.recipe;
}

/** Serialize background updates and remember successful checks by adapter. */
export class CliAutoUpdateQueue {
  private readonly checkedAt: Record<string, number>;
  private readonly retryAfter: Record<string, number> = {};
  private running = false;

  constructor(checkedAt: Readonly<Record<string, number>> = {}) {
    this.checkedAt = { ...checkedAt };
  }

  next(ids: readonly string[], now: number, hasLivePane: (adapterId: string) => boolean): string | null {
    return ids.find((id) =>
      !hasLivePane(id) && now >= (this.retryAfter[id] ?? 0) &&
      now - (this.checkedAt[id] ?? 0) >= CHECK_INTERVAL_MS,
    ) ?? null;
  }

  markAttempt(id: string, now: number): void {
    this.checkedAt[id] = now;
  }

  snapshot(): Readonly<Record<string, number>> {
    return { ...this.checkedAt };
  }

  async runOne(
    ids: readonly string[],
    now: number,
    hasLivePane: (adapterId: string) => boolean,
    run: (adapterId: string) => Promise<boolean>,
  ): Promise<string | null> {
    if (this.running) return null;
    const id = this.next(ids, now, hasLivePane);
    if (!id) return null;
    this.running = true;
    try {
      if (await run(id)) this.markAttempt(id, now);
      else this.retryAfter[id] = now + RETRY_AFTER_FAILURE_MS;
      return id;
    } catch (error) {
      this.retryAfter[id] = now + RETRY_AFTER_FAILURE_MS;
      throw error;
    } finally {
      this.running = false;
    }
  }
}
