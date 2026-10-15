/**
 * `.claude.json` do Claude Code (o nativo `~/.claude.json` ou o de um perfil
 * `CLAUDE_CONFIG_DIR`): pode passar de dezenas de MB (histórico por projeto) e
 * é reescrito pelo CLI o tempo todo. Toda leitura passa por aqui, por um
 * descritor só (`redline-safe-read`: arquivo regular, teto, sem FIFO) e gated
 * pelo stamp `mtimeMs:tamanho` — arquivo igual não é relido nem reparseado,
 * exatamente como o AccountFileCache do Codenotch.
 *
 * O snapshot guarda só identidade/plano/uso (nenhum token). Ainda assim
 * `invalidateClaudeCredentialCache()` (troca de conta, logout) limpa tudo.
 *
 * ponytail: o JSON.parse de um arquivo que MUDOU ainda roda no Main; com o
 * arquivo típico (~200 KB) custa ~1 ms. Se um `.claude.json` de dezenas de MB
 * virar regra, o parse vai para um worker.
 */
import {
  readRegularFileCapped,
  readRegularFileCappedAsync,
  type SafeRead,
} from '../redline/redline-safe-read';

export interface ClaudeConfigSnapshot {
  email?: string;
  accountUuid?: string;
  usageAccountUuid?: string;
  organizationUuid?: string;
  usageFetchedAtMs?: number;
  usage?: unknown;
  /** `oauthAccount.organizationRateLimitTier` — 'default_claude_max_20x' etc. */
  rateLimitTier?: string;
  organizationType?: string;
  billingType?: string;
}

/** `.claude.json` pode passar de dezenas de MB (histórico por projeto). */
const CONFIG_FILE_MAX_BYTES = 64 * 1024 * 1024;

const configSnapshotCache = new Map<
  string,
  { stamp: string; snapshot: ClaudeConfigSnapshot | null }
>();

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

function parseClaudeConfig(text: string): ClaudeConfigSnapshot | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const account = raw?.oauthAccount as Record<string, unknown> | undefined;
    const cached = raw?.cachedUsageUtilization as Record<string, unknown> | undefined;
    return {
      accountUuid: typeof account?.accountUuid === 'string' ? account.accountUuid : undefined,
      usageAccountUuid: typeof cached?.accountUuid === 'string' ? cached.accountUuid : undefined,
      email: nonEmpty(account?.emailAddress),
      organizationUuid: nonEmpty(account?.organizationUuid),
      usageFetchedAtMs:
        typeof cached?.fetchedAtMs === 'number' && Number.isFinite(cached.fetchedAtMs)
          ? cached.fetchedAtMs
          : undefined,
      usage: cached?.utilization,
      rateLimitTier: nonEmpty(account?.organizationRateLimitTier),
      organizationType: nonEmpty(account?.organizationType),
      billingType: nonEmpty(account?.billingType),
    };
  } catch {
    return null;
  }
}

function settle(
  accountFile: string,
  held: { stamp: string; snapshot: ClaudeConfigSnapshot | null } | undefined,
  read: SafeRead,
): ClaudeConfigSnapshot | null {
  if (read.kind === 'unchanged') return held?.snapshot ?? null;
  if (read.kind === 'none') {
    configSnapshotCache.delete(accountFile);
    return null;
  }
  const snapshot = parseClaudeConfig(read.text);
  configSnapshotCache.set(accountFile, { stamp: read.stamp, snapshot });
  return snapshot;
}

/** Caminhos síncronos (troca de conta, sonda pré-spawn): stamp antes de ler. */
export function readClaudeConfigSnapshot(accountFile: string): ClaudeConfigSnapshot | null {
  const held = configSnapshotCache.get(accountFile);
  return settle(accountFile, held, readRegularFileCapped(accountFile, CONFIG_FILE_MAX_BYTES, held?.stamp));
}

/** Ciclos periódicos (cota, plano): nada de IO síncrono no Main. */
export async function readClaudeConfigSnapshotAsync(
  accountFile: string,
): Promise<ClaudeConfigSnapshot | null> {
  const held = configSnapshotCache.get(accountFile);
  const read = await readRegularFileCappedAsync(accountFile, CONFIG_FILE_MAX_BYTES, held?.stamp);
  return settle(accountFile, held, read);
}

export function clearClaudeConfigSnapshotCache(): void {
  configSnapshotCache.clear();
}
