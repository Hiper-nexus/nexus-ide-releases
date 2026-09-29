/**
 * F-684: devolve ao perfil de origem, DURANTE a vida do pane, o auth.json que
 * uma CLI de refresh rotativo renovou dentro do overlay.
 *
 * O overlay liga o auth.json de origem (symlink no POSIX, hardlink ou cópia no
 * Windows). CLIs como o Grok regravam o arquivo por temporário + rename: o
 * vínculo se desfaz e o token renovado passa a existir só no overlay. Como o
 * refresh token ROTACIONA, a origem fica com um token que o servidor já
 * invalidou — no Windows o ~/.grok/auth.json parou em 22/09 e o operador
 * precisava logar todo dia (29/09). A devolução do fechamento só rodava em
 * pane direto, perdia-se em reinício do app e copiava sem olhar validade
 * (o último a fechar sobrescrevia um token mais novo).
 *
 * Regra: grava na origem só o blob da MESMA conta (ou origem vazia/vencida) e
 * mais novo que o da origem — nunca um mais velho, nunca por cima do login
 * válido de outra conta. A gravação é NO PRÓPRIO arquivo (sem rename) para os
 * outros panes que ainda compartilham o hardlink enxergarem o token novo.
 */
import fs from 'node:fs';

export interface AuthWriteThroughPolicy {
  /** Maior validade (epoch ms) do blob; null quando ilegível/sem data. */
  expiry(blob: string): number | null;
  /** Identidades estáveis da conta (sujeito/e-mail), minúsculas. */
  identities(blob: string): readonly string[];
}

export type AuthWriteThroughDecision = 'write' | 'skip';

export function decideAuthWriteThrough(
  overlayBlob: string,
  sourceBlob: string | null,
  policy: AuthWriteThroughPolicy,
  now = Date.now(),
): AuthWriteThroughDecision {
  if (overlayBlob === sourceBlob) return 'skip';
  const overlayExpiry = policy.expiry(overlayBlob);
  const overlayIds = policy.identities(overlayBlob);
  if (overlayExpiry === null || overlayIds.length === 0) return 'skip';
  if (!sourceBlob) return 'write';
  const sourceIds = policy.identities(sourceBlob);
  const sourceExpiry = policy.expiry(sourceBlob);
  if (sourceIds.length === 0 || sourceExpiry === null) return 'write';
  const sameAccount = overlayIds.some((id) => sourceIds.includes(id));
  if (!sameAccount) {
    // Login de outra conta no pane só substitui uma origem já vencida.
    return sourceExpiry <= now && overlayExpiry > now ? 'write' : 'skip';
  }
  return overlayExpiry > sourceExpiry ? 'write' : 'skip';
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.ino === b.ino && a.dev === b.dev && a.ino !== 0;
  } catch {
    return false;
  }
}

/** Uma passada: devolve o blob do overlay à origem quando a regra manda. */
export function writeThroughOnce(
  overlayFile: string,
  sourceFile: string,
  policy: AuthWriteThroughPolicy,
  now = Date.now(),
): boolean {
  if (sameFile(overlayFile, sourceFile)) return false;
  const overlayBlob = readText(overlayFile);
  if (!overlayBlob) return false;
  const sourceBlob = readText(sourceFile);
  if (decideAuthWriteThrough(overlayBlob, sourceBlob, policy, now) !== 'write') {
    return false;
  }
  try {
    fs.writeFileSync(sourceFile, overlayBlob, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Vigia o auth.json do overlay e devolve cada renovação. O disposer faz a
 * última passada (fechamento do pane) antes de parar de vigiar.
 */
export function startAuthWriteThrough(input: {
  readonly overlayFile: string;
  readonly sourceFile: string;
  readonly policy: AuthWriteThroughPolicy;
  readonly intervalMs?: number;
}): () => void {
  const tick = (): void => {
    try {
      writeThroughOnce(input.overlayFile, input.sourceFile, input.policy);
    } catch {
      // Best effort: nunca derruba o pane por uma devolução falha.
    }
  };
  const listener = (current: fs.Stats, previous: fs.Stats): void => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) tick();
  };
  fs.watchFile(
    input.overlayFile,
    { interval: input.intervalMs ?? 2_000, persistent: false },
    listener,
  );
  return () => {
    fs.unwatchFile(input.overlayFile, listener);
    tick();
  };
}
