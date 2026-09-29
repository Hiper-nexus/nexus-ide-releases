/**
 * F-677 — conta AGY por pane no Windows.
 *
 * O AGY 1.2 do Windows autentica pela vaga única `gemini:antigravity` do
 * Gerenciador de Credenciais (ver `agy-windows-keyring.ts`). Para abrir um
 * pane numa conta escolhida (pin, rotação por limite, missão), o Nexus grava
 * a sessão dessa conta na vaga imediatamente antes do spawn:
 *
 * 1. a sessão que já está na vaga vai para o cofre (conta dona ou conta nova)
 *    — trocar nunca apaga o login de ninguém;
 * 2. a conta escolhida é gravada e relida (identidade conferida);
 * 3. spawns de contas DIFERENTES entram em fila com uma folga
 *    (`AGY_KEYRING_SETTLE_MS`) para o processo recém-aberto ler a vaga antes
 *    da próxima troca. Mesma conta passa direto.
 *
 * Cada processo AGY lê a vaga ao iniciar; panes já abertos seguem com a conta
 * com que nasceram. Fora do Windows não faz nada (macOS/Linux isolam pelo
 * GEMINI_CLI_HOME da conta).
 */
import { compareAuthBlobIdentity } from '../adapters/managed-credentials';
import {
  isAgyKeyringBlob,
  readAgyWindowsKeyringBlob,
  writeAgyWindowsKeyringBlob,
} from '../adapters/agy-windows-keyring';
import { agyAccountCredentialBlob, preserveAgyKeyringSession } from './account-store';

/** Folga para o AGY recém-aberto ler a vaga antes de outra conta ocupá-la. */
export const AGY_KEYRING_SETTLE_MS = 6_000;

export interface AgyKeyringActivationDeps {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  readSlot(): string | null;
  writeSlot(blob: string): boolean;
  accountBlob(accountId: string): string | null;
  preserve(blob: string): unknown;
}

export type AgyKeyringActivation =
  | { ok: true; switched: boolean }
  | { ok: false; error: string };

const defaultDeps: AgyKeyringActivationDeps = {
  platform: process.platform,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readSlot: () => readAgyWindowsKeyringBlob({ fresh: true }),
  writeSlot: (blob) => writeAgyWindowsKeyringBlob(blob),
  accountBlob: (accountId) => agyAccountCredentialBlob(accountId),
  preserve: (blob) => preserveAgyKeyringSession(blob),
};

let queue: Promise<unknown> = Promise.resolve();
let lastSwitch: { accountId: string; settleUntil: number } | null = null;

export function resetAgyKeyringActivationForTests(): void {
  queue = Promise.resolve();
  lastSwitch = null;
}

/** Deixa a vaga do AGY na conta `accountId` para o spawn que vem a seguir. */
export function activateAgyAccountForSpawn(
  accountId: string,
  deps: AgyKeyringActivationDeps = defaultDeps,
): Promise<AgyKeyringActivation> {
  if (deps.platform !== 'win32') return Promise.resolve({ ok: true, switched: false });
  const run = queue.then(() => activate(accountId, deps));
  queue = run.catch(() => undefined);
  return run;
}

function sameAccount(slot: string | null, target: string): boolean {
  return Boolean(slot) && compareAuthBlobIdentity('agy', slot as string, target) === 'same';
}

async function activate(
  accountId: string,
  deps: AgyKeyringActivationDeps,
): Promise<AgyKeyringActivation> {
  const target = deps.accountBlob(accountId);
  if (!target) {
    return {
      ok: false,
      error: 'A conta AGY escolhida não tem sessão salva — entre novamente em Configurações → Providers.',
    };
  }
  if (!isAgyKeyringBlob(target)) {
    return {
      ok: false,
      error:
        'A sessão salva desta conta AGY não tem o formato que o AGY do Windows lê — ' +
        'entre com ela no AGY e salve a conta de novo em Configurações → Providers.',
    };
  }

  let slot = deps.readSlot();
  if (!sameAccount(slot, target)) {
    const wait = (lastSwitch?.settleUntil ?? 0) - deps.now();
    if (wait > 0) {
      await deps.sleep(wait);
      slot = deps.readSlot();
    }
  }
  if (sameAccount(slot, target)) {
    // A vaga já é desta conta: guarda o token mais novo dela e segue.
    try {
      deps.preserve(slot as string);
    } catch {
      /* best-effort: o spawn usa a vaga, que já está certa */
    }
    return { ok: true, switched: false };
  }

  if (slot) {
    try {
      deps.preserve(slot);
    } catch {
      return {
        ok: false,
        error: 'Não consegui guardar a sessão AGY atual antes de trocar de conta — nada foi trocado.',
      };
    }
  }
  if (!deps.writeSlot(target) || !sameAccount(deps.readSlot(), target)) {
    if (slot) deps.writeSlot(slot);
    return {
      ok: false,
      error: 'Não consegui ativar a conta AGY no Gerenciador de Credenciais do Windows.',
    };
  }
  lastSwitch = { accountId, settleUntil: deps.now() + AGY_KEYRING_SETTLE_MS };
  return { ok: true, switched: true };
}
