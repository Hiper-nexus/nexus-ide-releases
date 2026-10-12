import path from 'node:path';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import type { CliInstallRecipe } from './cli-install-recipes';
import { selectCliUpdateRecipe } from './cli-install-recipes';

/** Providers hosted by the same CLI share update/spawn exclusion and liveness. */
export function cliUpdateKey(adapterId: string): string {
  const adapter = BUILTIN_ADAPTERS.find((raw) => (raw as { id: string }).id === adapterId) as
    { kind?: string; bin?: string } | undefined;
  return adapter?.kind === 'cli-pty' && adapter.bin ? adapter.bin : adapterId;
}

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/**
 * F-1395: o boot analisa e atualiza TODAS as CLIs. Limite de segurança contra
 * loop de reinício: a CLI checada com sucesso há menos de 30 min fica de fora.
 */
export const BOOT_RECHECK_MS = 30 * 60_000;

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
    adapterId = cliUpdateKey(adapterId);
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
    adapterId = cliUpdateKey(adapterId);
    if (this.active || this.autoConsent || (this.provisioning && owner !== 'provisioning') ||
        (this.spawning.get(adapterId) ?? 0) > 0) return false;
    this.active = adapterId;
    return true;
  }

  release(adapterId: string): void {
    adapterId = cliUpdateKey(adapterId);
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
    adapterId = cliUpdateKey(adapterId);
    if (this.active !== adapterId) return Promise.resolve(this.grantSpawnPermit(adapterId));
    return new Promise((resolve) => {
      const waiters = this.spawnWaiters.get(adapterId) ?? [];
      waiters.push(resolve);
      this.spawnWaiters.set(adapterId, waiters);
    });
  }
}

/**
 * WinGet and privileged installers require the manual flow. Remote scripts do
 * too, except a vendor's official channel the recipe table marks for the daily
 * update (F-749, operator request 02/10: keep EVERY CLI current) — never a
 * script from anywhere else, and only over HTTPS.
 */
export function isSafeAutomaticCliRecipe(recipe: CliInstallRecipe): boolean {
  if (recipe.kind === 'script' || recipe.kind === 'powershell-script') {
    return recipe.automaticUpdate === true && recipe.scriptUrl.startsWith('https://');
  }
  if (recipe.kind !== 'argv') return false;
  const command = recipe.runner.toLowerCase();
  // F-1395: só o `upgrade` de um cask, pelo brew dono do Caskroom; nunca install.
  const caskUpgrade = recipe.argv.length === 4 && recipe.argv[0] === recipe.runner &&
    /^\/.+\/bin\/brew$/u.test(recipe.runner) && recipe.argv[1] === 'upgrade' &&
    recipe.argv[2] === '--cask' && /^[a-z0-9][a-z0-9@._-]*$/u.test(recipe.argv[3]);
  return command !== 'winget' && command !== 'sudo' &&
    (caskUpgrade || !recipe.argv.includes('--cask')) &&
    !recipe.argv.some((arg) => /^(?:--global|--system)$/iu.test(arg));
}

/** Artefatos de cask que só gravam no Caskroom/prefixo do usuário (sem sudo). */
const UNPRIVILEGED_CASK_ARTIFACTS = new Set([
  'binary', 'manpage', 'zap', 'bash_completion', 'zsh_completion', 'fish_completion',
]);

export function isUnprivilegedCaskArtifact(kind: string): boolean {
  return UNPRIVILEGED_CASK_ARTIFACTS.has(kind) || /^[a-z0-9_]*_completion$/u.test(kind);
}

/** `<prefix>/Caskroom/<cask>/.metadata/INSTALL_RECEIPT.json` do binário real. */
export function caskReceiptPath(realBinPath: string): string | null {
  const match = realBinPath.replaceAll('\\', '/').match(/^(.*\/Caskroom\/[^/]+)\//u);
  return match ? `${match[1]}/.metadata/INSTALL_RECEIPT.json` : null;
}

export function caskTokenFromRealBinPath(realBinPath: string): string | null {
  const match = realBinPath.replaceAll('\\', '/').match(/^.*\/Caskroom\/([^/]+)\//u);
  return match ? match[1] : null;
}

/**
 * F-1395 B1: Extrai os tipos de artefato do manifesto da versão-alvo do cask
 * (saída de `brew info --cask --json=v2 <cask>`).
 * Falha fechado (retorna null) se o JSON for inválido, não contiver o cask
 * ou a lista de artefatos estiver vazia/ausente.
 */
export function caskManifestArtifactKinds(manifestJson: string): string[] | null {
  try {
    const data = JSON.parse(manifestJson) as {
      casks?: Array<{ artifacts?: Array<Record<string, unknown>> }>;
    };
    const cask = data?.casks?.[0];
    if (!cask || !Array.isArray(cask.artifacts) || cask.artifacts.length === 0) return null;
    const kinds: string[] = [];
    for (const artifact of cask.artifacts) {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return null;
      // Homebrew adiciona 'target' a artefatos relocáveis (binary, app). O resto são os dsl_keys.
      const dslKeys = Object.keys(artifact).filter((key) => key !== 'target');
      if (dslKeys.length === 0) return null;
      kinds.push(...dslKeys);
    }
    return kinds;
  } catch {
    return null;
  }
}

/** Tipos de artefato do recibo do cask; null quando ilegível. */
export function caskReceiptArtifactKinds(receiptText: string): string[] | null {
  try {
    const artifacts = (JSON.parse(receiptText) as { uninstall_artifacts?: unknown }).uninstall_artifacts;
    if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
    return artifacts.flatMap((artifact) =>
      artifact && typeof artifact === 'object' && !Array.isArray(artifact) ? Object.keys(artifact) : ['?']);
  } catch { return null; }
}

/**
 * F-1395: instalação versionada — o update grava o binário novo noutro
 * diretório e só troca o link. O pane vivo segue no binário velho e o próximo
 * nasce no novo; atualizar com pane aberto é seguro. npm/brew/uv trocam no
 * lugar e continuam esperando o último pane fechar.
 */
export function isVersionedCliInstall(adapterId: string, binPath: string, realBinPath: string): boolean {
  const real = realBinPath.replaceAll('\\', '/');
  if (real === binPath.replaceAll('\\', '/')) return false;
  if (adapterId === 'claude') return /\/claude\/versions\/[^/]+$/u.test(real);
  if (adapterId === 'devin') return /\/devin\/cli\/_versions\/[^/]+\//u.test(real);
  if (adapterId === 'grok') return /\/\.grok\/(?:bin|downloads)\/grok-[^/]+$/u.test(real);
  return false;
}

type AutoUpdateInput = Parameters<typeof selectCliUpdateRecipe>[0] & {
  readonly isTargetWritable: (targetPath: string) => boolean;
  /** F-1395: artefatos do recibo do cask instalado (null/ausente = manual). */
  readonly caskArtifactKinds?: readonly string[] | null;
  /** F-1395 B1: artefatos do manifesto da VERSÃO-ALVO (brew info --cask --json=v2). */
  readonly caskTargetArtifactKinds?: readonly string[] | null;
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
  if (selection.recipe.kind === 'argv' && selection.recipe.argv.includes('--cask')) {
    // F-1395 B1: falhar fechado sem prova completa dos artefatos da VERSÃO-ALVO.
    // Cask com .pkg/instalador/hooks/uninstall privilegiado continua manual.
    const targetKinds = input.caskTargetArtifactKinds !== undefined
      ? input.caskTargetArtifactKinds
      : input.caskArtifactKinds;
    if (!targetKinds?.length || !targetKinds.every((kind) => isUnprivilegedCaskArtifact(kind))) return null;
    const receiptKinds = input.caskArtifactKinds;
    if (receiptKinds && (!receiptKinds.length || !receiptKinds.every((kind) => isUnprivilegedCaskArtifact(kind)))) {
      return null;
    }
    // Sem TTY e sem sudo: HOMEBREW_NO_SUDO=1 barra sudo mesmo com NOPASSWD;
    // SUDO_ASKPASS=/usr/bin/false garante que um prompt falha na hora em vez de pendurar.
    return {
      ...selection.recipe,
      env: {
        ...selection.recipe.env,
        SUDO_ASKPASS: '/usr/bin/false',
        HOMEBREW_NO_SUDO: '1',
      },
    };
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

  next(
    ids: readonly string[],
    now: number,
    hasLivePane: (adapterId: string) => boolean,
    intervalMs = CHECK_INTERVAL_MS,
  ): string | null {
    return ids.find((id) =>
      now >= (this.retryAfter[id] ?? 0) && now - (this.checkedAt[id] ?? 0) >= intervalMs &&
      !hasLivePane(id),
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
    intervalMs = CHECK_INTERVAL_MS,
  ): Promise<string | null> {
    if (this.running) return null;
    const id = this.next(ids, now, hasLivePane, intervalMs);
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

  /** F-1395: passe de boot — cada CLI devida uma vez, em série, até não sobrar nenhuma. */
  async runAll(
    ids: readonly string[],
    now: number,
    hasLivePane: (adapterId: string) => boolean,
    run: (adapterId: string) => Promise<boolean>,
    intervalMs = BOOT_RECHECK_MS,
  ): Promise<string[]> {
    const attempted: string[] = [];
    // Cada volta consome uma CLI (marcada ou em retentativa): no máximo ids.length.
    for (let turn = 0; turn < ids.length; turn++) {
      let id: string | null;
      // Erro numa CLI já a põe em retentativa; as demais seguem no passe.
      try { id = await this.runOne(ids, now, hasLivePane, run, intervalMs); }
      catch { continue; }
      if (!id) break;
      attempted.push(id);
    }
    return attempted;
  }
}
