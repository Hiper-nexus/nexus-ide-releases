import fs from 'node:fs';
import path from 'node:path';

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * Persist auth/session files a CLI wrote into an ephemeral overlay HOME back
 * into its real provider home before the overlay is purged.
 *
 * The overlay symlinks every file that already existed in the real home, so
 * writes to those went straight through and are already persisted. Only entries
 * that are REAL (non-symlink) in the overlay are new — most importantly a
 * first-time `/login` whose auth artifact did not exist when the overlay was
 * built. Without this sync-back that login is lost when the overlay is removed,
 * so the provider stays "login-needed" forever even though the user just
 * authenticated in the pane.
 *
 * `excludeTop` skips top-level entries — the token-bearing config the overlay
 * injected at its root (e.g. kimi's mcp.json / grok's config.toml).
 * `excludeAnywhere` skips entries by name at ANY depth — for overlays whose
 * token config is nested (e.g. AGY's .gemini/config/mcp_config.json). Neither
 * must ever leak into the user's real profile.
 *
 * Best-effort: never throws. Teardown must not be blocked by a copy failure.
 */
export function syncBackOverlayAuth(
  overlayDir: string,
  realHome: string,
  excludeTop: ReadonlySet<string>,
  excludeAnywhere: ReadonlySet<string> = NO_NAMES,
): void {
  copyNewEntries(overlayDir, realHome, excludeTop, excludeAnywhere, true);
}

/**
 * Chaves de ~/.claude.json que carregam a IDENTIDADE de login do CLI Claude.
 * O segredo OAuth vive no Keychain (macOS) ou em ~/.claude/.credentials.json
 * (Linux/Windows), mas o CLI decide "logado" pela presença de oauthAccount no
 * arquivo — sem ela, pede /login mesmo com o segredo disponível.
 */
export const CLAUDE_AUTH_IDENTITY_KEYS = ['oauthAccount', 'userID'] as const;

/**
 * Contraparte Claude-nativa de syncBackOverlayAuth. O HOME efêmero do Claude
 * NÃO é um overlay de symlinks — o Nexus escreve ali um .claude.json stub,
 * hooks e o config MCP — então o sync-back genérico de copiar-tudo destruiria
 * o perfil real (stub sobre o ~/.claude.json de verdade) e vazaria os
 * artefatos nexus-*. Persistimos apenas os dois artefatos que um /login fresco
 * dentro do pane pode produzir:
 *  - .claude/.credentials.json quando o CLI o materializou como ARQUIVO real
 *    (um rename atômico substitui o symlink projetado no spawn);
 *  - oauthAccount/userID do .claude.json do overlay, e somente quando o
 *    .claude.json REAL ainda não tem oauthAccount — resgate de login fresco;
 *    um login nativo existente nunca é sobrescrito.
 * Best-effort: nunca lança. Teardown não pode ser bloqueado por cópia.
 */
export function syncBackClaudeEphemeralAuth(
  overlayDir: string,
  realHome: string,
): void {
  syncBackClaudeCredentialsFile(overlayDir, realHome);
  syncBackClaudeAuthIdentity(overlayDir, realHome);
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function syncBackClaudeCredentialsFile(
  overlayDir: string,
  realHome: string,
): void {
  const src = path.join(overlayDir, '.claude', '.credentials.json');
  try {
    // Symlink já escreve direto no perfil real — só arquivo real é novidade.
    if (!fs.lstatSync(src).isFile()) return;
    const dst = path.join(realHome, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o600);
  } catch {
    // Best effort per file.
  }
}

function syncBackClaudeAuthIdentity(
  overlayDir: string,
  realHome: string,
): void {
  try {
    const overlay = readJsonObject(path.join(overlayDir, '.claude.json'));
    if (!overlay || overlay.oauthAccount === undefined) return;
    const realPath = path.join(realHome, '.claude.json');
    const real = readJsonObject(realPath) ?? {};
    if (real.oauthAccount !== undefined) return;
    const merged: Record<string, unknown> = { ...real };
    for (const key of CLAUDE_AUTH_IDENTITY_KEYS) {
      if (overlay[key] !== undefined) merged[key] = overlay[key];
    }
    fs.writeFileSync(realPath, JSON.stringify(merged, null, 2), {
      mode: 0o600,
    });
  } catch {
    // Best effort.
  }
}

function copyNewEntries(
  srcDir: string,
  dstDir: string,
  excludeTop: ReadonlySet<string>,
  excludeAnywhere: ReadonlySet<string>,
  atTop: boolean,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (excludeAnywhere.has(entry.name)) continue;
    if (atTop && excludeTop.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue;
    }
    // Symlinks point back at the real home already — nothing new to copy.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      try {
        fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      } catch {
        // Individual file copies below will surface any real failure.
      }
      copyNewEntries(src, dst, excludeTop, excludeAnywhere, false);
      continue;
    }
    if (stat.isFile()) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o600);
      } catch {
        // Best effort per file — a partial sync still beats losing the login.
      }
    }
  }
}
