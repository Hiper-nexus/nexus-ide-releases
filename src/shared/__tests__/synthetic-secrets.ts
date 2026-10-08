/**
 * F-999 (só testes): segredos SINTÉTICOS de alta entropia, determinísticos, e
 * o eco de terminal que os parte. Nenhum valor aqui é credencial real.
 */
import { expect } from 'vitest';

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = `${B62}+/`;
const B64URL = `${B62}-_`;

/** Gerador congruencial: o mesmo seed dá sempre o mesmo "segredo". */
export function synthetic(seed: number, length: number, alphabet = B62): string {
  let state = seed >>> 0;
  let out = '';
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    out += alphabet[(state >>> 8) % alphabet.length];
  }
  return out;
}

export const SECRETS = {
  openai: `sk-proj-${synthetic(11, 156, `${B62}-_`)}`,
  github: `ghp_${synthetic(12, 36)}`,
  anthropic: `sk-ant-api03-${synthetic(13, 93, `${B62}-_`)}`,
  awsSecret: synthetic(14, 40, B64),
  jwt: `eyJ${synthetic(15, 33, B64URL)}.eyJ${synthetic(16, 61, B64URL)}.${synthetic(17, 43, B64URL)}`,
  dbPassword: synthetic(18, 24),
} as const;

/** Corpo de uma chave PEM (linhas de 64 chars base64). */
export const PEM_BODY: readonly string[] = Array.from({ length: 12 }, (_, index) =>
  synthetic(40 + index, 64, B64),
);

/** Saída de `cat .env` + chave SSH + curl autenticado, como no terminal. */
export function dotenvDump(): string {
  return [
    '$ cat .env',
    `OPENAI_API_KEY=${SECRETS.openai}`,
    `GITHUB_TOKEN=${SECRETS.github}`,
    `ANTHROPIC_API_KEY=${SECRETS.anthropic}`,
    `AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}`,
    `DATABASE_URL=postgres://app:${SECRETS.dbPassword}@db:5432/app`,
    '$ cat ~/.ssh/id_ed25519',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    ...PEM_BODY,
    '-----END OPENSSH PRIVATE KEY-----',
    `$ curl -H "Authorization: Bearer ${SECRETS.jwt}" https://api.example.com/v1/me`,
    'ok',
  ].join('\n');
}

/** Quebra dura a cada `width` colunas (o eco de uma TUI que parte o token). */
export function hardWrap(text: string, width: number): string {
  return text
    .split('\n')
    .flatMap((line) => (line.length <= width ? [line] : line.match(new RegExp(`.{1,${width}}`, 'g')) ?? []))
    .join('\n');
}

/**
 * Quebra de TUI Ink: por palavra na largura, palavra maior que a linha partida
 * na largura; `gutter` abre a 1ª linha e `indent` as continuações (a moldura
 * "  ⎿  " da saída de ferramenta do Claude Code).
 */
export function inkWrap(text: string, width: number, gutter = '', indent = ''): string {
  return text
    .split('\n')
    .flatMap((line) => {
      const out: string[] = [];
      let current = gutter;
      let fresh = true;
      for (const word of line.split(' ')) {
        let rest = word;
        while (rest.length > 0 || fresh) {
          const room = width - current.length - (fresh ? 0 : 1);
          if (rest.length <= room) {
            current = fresh ? `${current}${rest}` : `${current} ${rest}`;
            rest = '';
            fresh = false;
            break;
          }
          if (fresh) {
            current = `${current}${rest.slice(0, room)}`;
            rest = rest.slice(room);
          }
          out.push(current);
          current = indent;
          fresh = true;
        }
      }
      out.push(current);
      return out;
    })
    .join('\n');
}

/** Nenhum pedaço de 8+ chars de nenhum segredo aparece no texto. */
export function expectNoSecretFragment(
  text: string,
  secrets: readonly string[] = [...Object.values(SECRETS), ...PEM_BODY],
): void {
  const flat = text.replace(/\s+/g, '');
  for (const secret of [...secrets, ...PEM_BODY]) {
    for (let at = 0; at + 8 <= secret.length; at += 1) {
      const fragment = secret.slice(at, at + 8);
      if (text.includes(fragment) || flat.includes(fragment)) {
        expect.fail(`vazou "${fragment}" (posição ${at} de ${secret.slice(0, 12)}…)`);
      }
    }
  }
}
