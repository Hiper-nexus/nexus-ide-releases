import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * F-694: o Kimi Code 2.x guarda o OAuth com chave por ambiente —
 * `kimi provider list --json` → `oauth.key: "oauth/kimi-code-env-<hash>"`,
 * arquivo `credentials/kimi-code-env-<hash>.json`. Procurar só
 * `kimi-code.json` marcava a sessão viva como login-needed (rota) e deixava a
 * cota sem credencial. Aceita o nome fixo (primeiro) e as variantes
 * `kimi-code-<sufixo>.json`.
 */
export function kimiCredentialFilesIn(credentialsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(credentialsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^kimi-code(?:-[A-Za-z0-9_.-]+)?\.json$/u.test(name))
    .sort((a, b) => (a === 'kimi-code.json' ? -1 : b === 'kimi-code.json' ? 1 : a.localeCompare(b)))
    .map((name) => path.join(credentialsDir, name));
}

/** Arquivos de credencial OAuth do Kimi nativo, na ordem de preferência. */
export function kimiNativeCredentialFiles(home = os.homedir()): string[] {
  const homes = [path.join(home, '.kimi-code'), path.join(home, '.kimi')];
  const customHome = process.env.KIMI_CODE_HOME?.trim();
  if (customHome) homes.unshift(customHome);
  return homes.flatMap((dir) => kimiCredentialFilesIn(path.join(dir, 'credentials')));
}
