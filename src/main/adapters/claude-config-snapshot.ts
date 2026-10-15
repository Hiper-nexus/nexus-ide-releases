/**
 * `.claude.json` do Claude Code (o nativo `~/.claude.json` ou o de um perfil
 * `CLAUDE_CONFIG_DIR`): pode passar de dezenas de MB (histórico por projeto) e
 * é reescrito pelo CLI o tempo todo. Toda leitura passa por aqui, por um
 * descritor só (`redline-safe-read`: arquivo regular, teto, sem FIFO). Exibição
 * e ciclos usam o cache pelo stamp forte (inode, tamanho, mtime e ctime em ns):
 * arquivo igual não é relido nem reparseado. Decisão de autorização relê
 * sempre ({@link readClaudeConfigForDecision}).
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

/**
 * `known: false` = o arquivo existe mas não deu para ler agora (teto, FIFO,
 * instável durante a leitura, ilegível, JSON pela metade). Só ausência é
 * "sem login nativo"; decisão de autorização sobre o desconhecido fecha.
 */
interface SettledRead {
  readonly snapshot: ClaudeConfigSnapshot | null;
  readonly known: boolean;
}

/** Sobe a cada limpeza: leitura assíncrona de antes não republica no cache. */
let cacheGeneration = 0;

const STRONG_STAMP = { strongStamp: true } as const;

function settle(
  accountFile: string,
  held: { stamp: string; snapshot: ClaudeConfigSnapshot | null } | undefined,
  read: SafeRead,
  generation: number,
): SettledRead {
  if (read.kind === 'unchanged') {
    const snapshot = held?.snapshot ?? null;
    return { snapshot, known: snapshot !== null };
  }
  if (read.kind === 'none') {
    if (generation === cacheGeneration) configSnapshotCache.delete(accountFile);
    return { snapshot: null, known: read.stamp === 'missing' };
  }
  const snapshot = parseClaudeConfig(read.text);
  if (generation === cacheGeneration) {
    configSnapshotCache.set(accountFile, { stamp: read.stamp, snapshot });
  }
  return { snapshot, known: snapshot !== null };
}

/** Caminhos síncronos de exibição (sonda pré-spawn, status): stamp antes de ler. */
export function readClaudeConfigSnapshot(accountFile: string): ClaudeConfigSnapshot | null {
  const held = configSnapshotCache.get(accountFile);
  return settle(
    accountFile,
    held,
    readRegularFileCapped(accountFile, CONFIG_FILE_MAX_BYTES, held?.stamp, STRONG_STAMP),
    cacheGeneration,
  ).snapshot;
}

/**
 * DECISÕES de autorização (renovar grant, fixar pane no store nativo,
 * failover): sempre relê, sem confiar em stamp. `null` = arquivo ausente;
 * `undefined` = presente mas ilegível agora — o chamador fecha.
 */
export function readClaudeConfigForDecision(
  accountFile: string,
): ClaudeConfigSnapshot | null | undefined {
  const read = settle(
    accountFile,
    undefined,
    readRegularFileCapped(accountFile, CONFIG_FILE_MAX_BYTES, undefined, STRONG_STAMP),
    cacheGeneration,
  );
  return read.known ? read.snapshot : undefined;
}

/** Ciclos periódicos (cota, plano): nada de IO síncrono no Main. */
export async function readClaudeConfigSnapshotAsync(
  accountFile: string,
): Promise<ClaudeConfigSnapshot | null> {
  const held = configSnapshotCache.get(accountFile);
  const generation = cacheGeneration;
  const read = await readRegularFileCappedAsync(
    accountFile,
    CONFIG_FILE_MAX_BYTES,
    held?.stamp,
    STRONG_STAMP,
  );
  return settle(accountFile, held, read, generation).snapshot;
}

export function clearClaudeConfigSnapshotCache(): void {
  configSnapshotCache.clear();
  cacheGeneration += 1;
}
