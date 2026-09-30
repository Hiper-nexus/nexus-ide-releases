/**
 * Devin CLI recebe o MCP do Nexus pelo escopo de usuário (F-698).
 *
 * Medido no Devin 3000.11.1 (Windows, 30/09) com `devin -p`: a entrada stdio
 * registrada por `devin mcp add --scope user` (`~/.config/devin/
 * mcp_config.json`) herda o ambiente do processo — a ponte do Nexus fez
 * `initialize`, `tools/list` e `tools/call` com o bearer da sessão e o Devin
 * devolveu o resultado. O escopo padrão da CLI é `local` (arquivo dentro do
 * repositório): o Nexus usa sempre `--scope user` para nunca gravar no
 * projeto de ninguém. Sem ENV (Devin fora do Nexus) a ponte fica muda.
 *
 * Registro pela PRÓPRIA CLI, idempotente (confere `devin mcp list`) e
 * memorizado por processo. URL e bearer só por ENV.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { resolveCliBinary } from '../path-resolver';
import { ensureNexusMcpBridgeScript } from './cli-mcp-session-minimax';

export const DEVIN_NEXUS_MCP_SERVER = 'nexus';

export type DevinCliExec = (bin: string, args: readonly string[]) => string;

const defaultExec: DevinCliExec = (bin, args) =>
  execFileSync(bin, [...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 20_000,
    windowsHide: true,
  });

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/**
 * O servidor `nexus` do `devin mcp list` aponta para esta ponte e não está
 * desabilitado. Formato medido no 3000.11.1:
 * `  • nexus` seguido de `    Command: <node> <ponte>`.
 */
export function devinListHasNexusBridge(listOutput: string, bridgePath: string): boolean {
  const bridge = normalizeForMatch(bridgePath);
  const lines = listOutput.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*[•*-]\s*(\S+)(.*)$/u.exec(lines[index]!);
    if (!header || header[1] !== DEVIN_NEXUS_MCP_SERVER) continue;
    if (/disabled/iu.test(header[2] ?? '')) return false;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      if (/^\s*[•*-]\s*\S/u.test(line)) break;
      if (/disabled/iu.test(line)) return false;
      if (/^\s*Command:/iu.test(line)) return normalizeForMatch(line).includes(bridge);
    }
    return false;
  }
  return false;
}

let registeredSignature: string | null = null;

export function resetDevinMcpRegistrationForTests(): void {
  registeredSignature = null;
}

export interface DevinMcpRegistrationOptions {
  readonly home?: string;
  readonly devinBin?: string;
  readonly nodePath?: string;
  readonly exec?: DevinCliExec;
}

export function ensureDevinNexusMcpRegistration(
  options: DevinMcpRegistrationOptions = {},
): { registered: boolean; reason?: string } {
  const bridge = ensureNexusMcpBridgeScript(options.home ?? os.homedir());
  const node = options.nodePath ?? resolveCliBinary('node')?.binPath ?? 'node';
  const devin = options.devinBin ?? resolveCliBinary('devin')?.binPath ?? 'devin';
  const signature = `${devin}\u0000${node}\u0000${bridge}`;
  if (registeredSignature === signature) return { registered: true };
  const exec = options.exec ?? defaultExec;
  try {
    if (!devinListHasNexusBridge(exec(devin, ['mcp', 'list']), bridge)) {
      // Entrada antiga/desabilitada é substituída: remove (ignora ausência) e adiciona.
      try {
        exec(devin, ['mcp', 'remove', '--scope', 'user', DEVIN_NEXUS_MCP_SERVER]);
      } catch {
        // Não havia entrada no escopo de usuário.
      }
      exec(devin, ['mcp', 'add', '--scope', 'user', DEVIN_NEXUS_MCP_SERVER, '--', node, bridge]);
      if (!devinListHasNexusBridge(exec(devin, ['mcp', 'list']), bridge)) {
        return { registered: false, reason: '`devin mcp add` não registrou a ponte do Nexus' };
      }
    }
  } catch (error) {
    return {
      registered: false,
      reason: `devin mcp falhou: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
  registeredSignature = signature;
  return { registered: true };
}
