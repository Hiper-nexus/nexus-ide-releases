/**
 * AGY (Antigravity CLI) recebe o MCP do Nexus pelo perfil nativo (F-697).
 *
 * O AGY ignora a projeção de HOME privado para MCP (por isso o overlay com o
 * bearer no `mcp_config.json` nunca teve efeito e `canUseNexusMcp` mentia
 * `false`). Medido no AGY 1.2.14 (Windows, 30/09) com `agy -p`: a entrada
 * stdio registrada por `agy mcp add` no perfil real herda o ambiente do
 * processo — a ponte do Nexus fez `server/discover`, `initialize`,
 * `tools/list` e `tools/call` com o bearer da sessão e o AGY devolveu o
 * resultado. Sem ENV (AGY fora do Nexus) a ponte fica muda e o AGY responde
 * normal.
 *
 * O registro passa pela PRÓPRIA CLI (`agy mcp add nexus <node> <ponte>`): ela
 * grava onde ela mesma lê, em qualquer plataforma. Idempotente (confere
 * `agy mcp list`) e memorizado por processo. URL e bearer só por ENV.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { resolveCliBinary } from '../path-resolver';
import { ensureNexusMcpBridgeScript } from './cli-mcp-session-minimax';

export const AGY_NEXUS_MCP_SERVER = 'nexus';

export type AgyCliExec = (bin: string, args: readonly string[]) => string;

const defaultExec: AgyCliExec = (bin, args) =>
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
 * A linha do `agy mcp list` para o servidor `nexus`, quando ele aponta para
 * esta ponte e está habilitado. Formato medido no 1.2.14:
 * `NAME TYPE STATUS COMMAND/URL` → `nexus stdio enabled <node> <ponte>`.
 */
export function agyListHasNexusBridge(listOutput: string, bridgePath: string): boolean {
  const bridge = normalizeForMatch(bridgePath);
  return listOutput.split(/\r?\n/u).some((line) => {
    const cells = line.trim().split(/\s+/u);
    return (
      cells[0] === AGY_NEXUS_MCP_SERVER &&
      cells[1]?.toLowerCase() === 'stdio' &&
      cells[2]?.toLowerCase() === 'enabled' &&
      normalizeForMatch(line).includes(bridge)
    );
  });
}

let registeredSignature: string | null = null;

export function resetAgyMcpRegistrationForTests(): void {
  registeredSignature = null;
}

export interface AgyMcpRegistrationOptions {
  readonly home?: string;
  readonly agyBin?: string;
  readonly nodePath?: string;
  readonly exec?: AgyCliExec;
}

export function ensureAgyNexusMcpRegistration(
  options: AgyMcpRegistrationOptions = {},
): { registered: boolean; reason?: string } {
  const bridge = ensureNexusMcpBridgeScript(options.home ?? os.homedir());
  const node = options.nodePath ?? resolveCliBinary('node')?.binPath ?? 'node';
  const agy = options.agyBin ?? resolveCliBinary('agy')?.binPath ?? 'agy';
  const signature = `${agy}\u0000${node}\u0000${bridge}`;
  if (registeredSignature === signature) return { registered: true };
  const exec = options.exec ?? defaultExec;
  try {
    if (!agyListHasNexusBridge(exec(agy, ['mcp', 'list']), bridge)) {
      // "Add or update": substitui uma entrada `nexus` antiga ou desabilitada.
      exec(agy, ['mcp', 'add', AGY_NEXUS_MCP_SERVER, node, bridge]);
      if (!agyListHasNexusBridge(exec(agy, ['mcp', 'list']), bridge)) {
        return { registered: false, reason: '`agy mcp add` não registrou a ponte do Nexus' };
      }
    }
  } catch (error) {
    return {
      registered: false,
      reason: `agy mcp falhou: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
  registeredSignature = signature;
  return { registered: true };
}
