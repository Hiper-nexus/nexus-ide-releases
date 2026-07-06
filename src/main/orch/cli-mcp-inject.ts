import fs from 'node:fs';
import path from 'node:path';

/**
 * Injeção REAL do servidor MCP embutido do Nexus nos CLIs não-Claude, para que
 * um worker Codex/Gemini/Antigravity chame as tools `nexus_*` e submeta handoff
 * — não só receba env vars de consciência (gap da auditoria 2026-07-06 §4).
 *
 * - Codex: overrides `-c mcp_servers.nexus.*` no argv (streamable HTTP).
 * - Gemini/Antigravity: `<cwd>/.gemini/settings.json` com `mcpServers.nexus`
 *   (merge atômico e idempotente; JSON inválido é preservado como backup).
 *
 * Claude e família (mcpAutoload) continuam pelo `--mcp-config` existente.
 */

export type McpInjectionKind = 'codex' | 'gemini';

/** Retorna o "sabor" de injeção do CLI, ou null quando não se aplica. */
export function supportsMcpInjection(adapterId: string): McpInjectionKind | null {
  switch (adapterId) {
    case 'codex':
      return 'codex';
    case 'gemini':
    case 'agy': // Antigravity usa o mesmo formato de settings do Gemini
      return 'gemini';
    default:
      return null;
  }
}

/** Overrides de config do Codex para um servidor MCP streamable-HTTP. */
export function codexMcpArgs(url: string, token: string): string[] {
  return [
    '-c',
    `mcp_servers.nexus.url=${JSON.stringify(url)}`,
    '-c',
    `mcp_servers.nexus.http_headers.Authorization=${JSON.stringify(`Bearer ${token}`)}`,
  ];
}

export interface GeminiMcpFragment {
  mcpServers: {
    nexus: {
      httpUrl: string;
      headers: { Authorization: string };
      trust: true;
    };
  };
}

export function geminiMcpFragment(url: string, token: string): GeminiMcpFragment {
  return {
    mcpServers: {
      nexus: {
        httpUrl: url,
        headers: { Authorization: `Bearer ${token}` },
        trust: true,
      },
    },
  };
}

/** Merge puro: preserva o settings existente e injeta/atualiza mcpServers.nexus. */
export function mergeGeminiSettings(
  existing: unknown,
  fragment: GeminiMcpFragment,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object'
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const prevServers =
    base.mcpServers && typeof base.mcpServers === 'object'
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  base.mcpServers = { ...prevServers, nexus: fragment.mcpServers.nexus };
  return base;
}

/**
 * Edge: escreve `<cwd>/.gemini/settings.json` com o servidor nexus mesclado.
 * Atômico (tmp+rename); JSON ilegível é preservado como `.invalid-<ts>`.
 * Nunca lança — falha de injeção não impede o spawn.
 */
export function writeGeminiMcpConfig(
  cwd: string,
  url: string,
  token: string,
  now: () => number = Date.now,
): void {
  try {
    const dir = path.join(cwd, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    let existing: unknown = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      try {
        existing = JSON.parse(raw);
      } catch {
        fs.writeFileSync(`${file}.invalid-${now()}`, raw);
        existing = {};
      }
    } catch {
      existing = {};
    }
    const merged = mergeGeminiSettings(existing, geminiMcpFragment(url, token));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[orch] falha ao injetar MCP no Gemini/Antigravity:', err);
  }
}
