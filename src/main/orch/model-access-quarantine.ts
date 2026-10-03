/**
 * F-683: modelo que o provider RECUSOU (acesso desligado, modelo inexistente
 * para a conta) sai do roteamento automático por algumas horas.
 *
 * O failover já troca o modelo do pane recusado (F-520), mas o roteador não
 * sabia disso e mandava o próximo helper para o mesmo modelo — em 29/09 um
 * worker OpenCode caiu em `opencode/deepseek-v4-flash` ("Upstream request
 * failed: Model access is disabled", 5 tentativas e exit 1).
 * F-765: acesso pertence à conta; incompatibilidade pertence à instalação.
 * Memória do Main, sem persistir ou expor identidades em IPC/MCP.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MODEL_ACCESS_QUARANTINE_MS = 12 * 60 * 60_000;

interface QuarantineEntry {
  readonly until: number;
  readonly reason: string;
}

const quarantined = new Map<string, QuarantineEntry>();

export interface ModelQuarantineScope {
  /** Identidade interna Main; null representa o login nativo sem conta gerenciada. */
  readonly accountId?: string | null;
  /** Executável efetivo + versão/assinatura da instalação, nunca vem de MCP. */
  readonly installationId?: string | null;
}

let scopeResolver: ((adapterId: string) => ModelQuarantineScope) | undefined;

/**
 * Main configura a identidade viva; o roteador puro continua sem imports
 * Electron. O resolver é síncrono e não faz I/O: devolve valores já resolvidos.
 */
export function setModelQuarantineScopeResolver(
  resolver: ((adapterId: string) => ModelQuarantineScope) | null,
): void {
  scopeResolver = resolver ?? undefined;
}

export function currentModelQuarantineScope(
  adapterId: string,
  overrides: ModelQuarantineScope = {},
): ModelQuarantineScope {
  return { ...scopeResolver?.(adapterId), ...overrides };
}

/**
 * Identidade da instalação sem executar a CLI nem ler credenciais: o alvo
 * real do executável e o package.json do wrapper npm mudam no update.
 * Assíncrona de propósito (F-764): disco nunca no caminho quente do Main —
 * quem consulta a quarentena usa o valor já resolvido pelo Main.
 */
export async function resolveModelQuarantineInstallationId(
  executablePath: string | null | undefined,
  version?: string,
): Promise<string | null> {
  if (!executablePath || !path.isAbsolute(executablePath)) return null;
  try {
    const real = await fs.promises.realpath(executablePath);
    const stamp = async (file: string): Promise<string> => {
      const stat = await fs.promises.stat(file);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    };
    let packageStamp: string | null = null;
    // ponytail: procura no máximo quatro pais; cobre wrappers npm sem varrer HOME.
    let directory = path.dirname(real);
    for (let depth = 0; depth < 4 && packageStamp === null; depth += 1) {
      const manifest = path.join(directory, 'package.json');
      packageStamp = await stamp(manifest).then(
        (value) => `${manifest}:${value}`,
        () => null,
      );
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return JSON.stringify([real, await stamp(real), version ?? null, packageStamp]);
  } catch {
    return null;
  }
}

function key(adapterId: string, model: string, kind: 'access' | 'installation', identity: string): string {
  return JSON.stringify([adapterId, model.trim().toLowerCase(), kind, identity]);
}

function activeReason(entryKey: string, now: number): string | null {
  const entry = quarantined.get(entryKey);
  if (!entry) return null;
  if (now >= entry.until) {
    quarantined.delete(entryKey);
    return null;
  }
  return entry.reason;
}

export function quarantineRejectedModel(
  adapterId: string,
  model: string | undefined,
  reason: string,
  now = Date.now(),
  durationMs = MODEL_ACCESS_QUARANTINE_MS,
  scope: ModelQuarantineScope & { readonly kind?: 'access' | 'installation' } = {},
): void {
  if (!model?.trim()) return;
  const resolved = currentModelQuarantineScope(adapterId, scope);
  const kind = scope.kind ?? 'access';
  const identity = kind === 'installation' ? resolved.installationId : (resolved.accountId ?? '');
  // Sem instalação provada, não transforme incompatibilidade em punição global.
  if (identity == null) return;
  for (const [entryKey, entry] of quarantined) {
    if (now >= entry.until) quarantined.delete(entryKey);
  }
  quarantined.set(key(adapterId, model, kind, identity), { until: now + durationMs, reason });
}

/** Motivo da quarentena ativa, ou null. */
export function modelAccessQuarantine(
  adapterId: string,
  model: string | undefined,
  now = Date.now(),
  scope: ModelQuarantineScope = {},
): string | null {
  if (!model?.trim()) return null;
  const resolved = currentModelQuarantineScope(adapterId, scope);
  return activeReason(key(adapterId, model, 'access', resolved.accountId ?? ''), now) ??
    (resolved.installationId
      ? activeReason(key(adapterId, model, 'installation', resolved.installationId), now)
      : null);
}

export function resetModelAccessQuarantineForTests(): void {
  quarantined.clear();
  scopeResolver = undefined;
}
