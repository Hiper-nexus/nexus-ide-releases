import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  managedHomePath,
  materializeManagedHome,
  readBackFresherAuth,
  shouldWriteAuthFile,
} from './managed-credentials';

/**
 * Regressão de campo (21/09): "fiz login na conta Grok e não fica operacional".
 *
 * O motor de frescor só entendia o formato do Codex. O blob do Grok guarda a
 * sessão num mapa com chave composta (`<issuer>::<uuid>`) e o instante dentro
 * de `create_time` / do JWT — invisível para ele. Com os dois lados "sem
 * frescor":
 *
 *   - `shouldWriteAuthFile` recusava escrever  → o managed home ficava preso
 *     no token velho, e todo pane daquela conta nascia deslogado;
 *   - `readBackFresherAuth` preferia o disco   → o token velho ainda era
 *     PROMOVIDO para dentro do cofre, apagando o login novo.
 *
 * Os dois ramos juntos tornavam a conta irrecuperável por login.
 */

const HOMES: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-relogin-'));
  HOMES.push(home);
  return home;
}

afterEach(() => {
  while (HOMES.length > 0) {
    const home = HOMES.pop();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

function jwt(claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url');
  return `${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

/** Formato real de ~/.grok/auth.json (verificado na máquina de campo). */
function grokAuth(createdMs: number, userId: string): string {
  const seconds = Math.floor(createdMs / 1000);
  return JSON.stringify({
    [`https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`]: {
      key: jwt({ iss: 'https://auth.x.ai', sub: userId, iat: seconds, exp: seconds + 21_600 }),
      auth_mode: 'oidc',
      create_time: new Date(createdMs).toISOString(),
      user_id: userId,
      email: 'retornoja@gmail.com',
      principal_id: userId,
      refresh_token: `refresh-${seconds}`,
      expires_at: new Date(createdMs + 21_600_000).toISOString(),
      oidc_issuer: 'https://auth.x.ai',
    },
  });
}

const USER = 'ee04b1dc-c313-4a70-9e36-efde42419178';
const SEP_03 = Date.UTC(2026, 8, 3, 14, 43, 37);
const SEP_21 = Date.UTC(2026, 8, 21, 12, 16, 46);

describe('Grok re-login lands on the account (field regression)', () => {
  it('writes the fresh login over the stale managed session', () => {
    const home = tempHome();
    const accountId = 'acct-grok-1';
    const stale = grokAuth(SEP_03, USER);
    const fresh = grokAuth(SEP_21, USER);

    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(home, '.grok', 'auth.json'), fresh);
    materializeManagedHome('grok', accountId, stale, { home });

    const authPath = path.join(
      managedHomePath('grok', accountId, home),
      'auth.json',
    );
    expect(fs.readFileSync(authPath, 'utf8')).toBe(stale);

    // O login novo do usuário chega ao cofre e deve vencer o arquivo velho.
    expect(shouldWriteAuthFile(authPath, fresh, 'grok')).toBe(true);
    materializeManagedHome('grok', accountId, fresh, { home });
    expect(fs.readFileSync(authPath, 'utf8')).toBe(fresh);
  });

  it('never promotes the stale managed file back into the vault', () => {
    const home = tempHome();
    const accountId = 'acct-grok-1';
    const stale = grokAuth(SEP_03, USER);
    const fresh = grokAuth(SEP_21, USER);

    materializeManagedHome('grok', accountId, stale, { home, systemHome: null });
    // Cofre com o login novo, disco com o velho: nada volta.
    expect(readBackFresherAuth('grok', accountId, fresh, { home })).toBeNull();
  });

  it('still reads back a token the CLI refreshed in place', () => {
    const home = tempHome();
    const accountId = 'acct-grok-1';
    const vault = grokAuth(SEP_03, USER);
    const rotated = grokAuth(SEP_21, USER);

    materializeManagedHome('grok', accountId, vault, { home, systemHome: null });
    fs.writeFileSync(
      path.join(managedHomePath('grok', accountId, home), 'auth.json'),
      rotated,
    );
    expect(readBackFresherAuth('grok', accountId, vault, { home })).toBe(rotated);
  });

  it('never lets one account\'s session overwrite another account\'s vault', () => {
    const home = tempHome();
    const accountId = 'acct-grok-1';
    const mine = grokAuth(SEP_03, USER);
    const somebodyElse = grokAuth(SEP_21, 'ffffffff-0000-4000-8000-000000000000');

    materializeManagedHome('grok', accountId, mine, { home, systemHome: null });
    fs.writeFileSync(
      path.join(managedHomePath('grok', accountId, home), 'auth.json'),
      somebodyElse,
    );
    // Mais fresco, porém de OUTRA identidade: o cofre desta conta não muda.
    expect(readBackFresherAuth('grok', accountId, mine, { home })).toBeNull();
  });
});
