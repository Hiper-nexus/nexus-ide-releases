#!/usr/bin/env node
/**
 * Nexus Arms — conector MCP stdio para orquestradores externos
 * (paridade Overclock Arms 1.3.9–1.3.11; Grok Bot, Cursor, qualquer cliente
 * MCP que fale JSON-RPC em stdio).
 *
 * Uso na config MCP do cliente externo:
 *   {
 *     "mcpServers": {
 *       "nexus-arms": {
 *         "command": "node",
 *         "args": ["/Applications/NexusIDE.app/Contents/Resources/nexus-arms.mjs"],
 *         "env": { "NEXUS_ARMS_TOKEN": "nxarms_..." }
 *       }
 *     }
 *   }
 *
 * Contrato de transporte (stdout = SÓ JSON-RPC; logs vão para stderr):
 *  - App fechado / porta ausente / token inválido respondem estado MCP de
 *    erro LIMPO por tool call — o conector nunca morre, nunca despeja lixo
 *    no stdout, nunca trava a sessão do cliente (a doutrina Arms deles).
 *  - Prazo de fetch: 8s por request, 1 retry — mesma janela do proxy deles.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const FETCH_TIMEOUT_MS = 8_000;
const RETRIES = 1;

function defaultDescriptorPath(homedir) {
  return path.join(homedir, '.nexus', 'arms-runtime.json');
}

function validateDescriptorPath(file) {
  if (!path.isAbsolute(file)) {
    throw new Error(`caminho do descritor Arms deve ser absoluto: ${file}`);
  }
  return file;
}

/** OVKA-529 — a casa deste pane, quando o processo nasceu dentro de um. */
export function paneHomeDescriptor(env = process.env) {
  const raw = env.NEXUS_PANE_ARMS_DESCRIPTOR?.trim();
  return raw ? raw : null;
}

/**
 * OVKA-529 — este processo é um pane do Nexus agindo no PRÓPRIO app?
 * Exige id do pane, memória da casa, e destino não desviado.
 */
export function isPaneHome(env = process.env) {
  if (!env.NEXUS_PANE_ID?.trim()) return false;
  const home = paneHomeDescriptor(env);
  if (!home) return false;
  const target = env.NEXUS_ARMS_DESCRIPTOR?.trim();
  return !target || target === home;
}

/**
 * Id do pane que esta sessão representa — só em casa. Destino desviado
 * (`--descriptor` para outra instância) não carrega identidade.
 */
export function callerPaneIdOf(env = process.env) {
  if (!isPaneHome(env)) return null;
  const id = env.NEXUS_PANE_ID?.trim();
  return id ? id : null;
}

/**
 * URL da sessão: com `callerPaneId` quando o pane está em casa (o gate aplica
 * orçamento/papel daquele pane); anônima quando não está (conector externo).
 */
export function sessionUrl(baseUrl, env = process.env) {
  const paneId = callerPaneIdOf(env);
  if (!paneId) return baseUrl;
  const url = new URL(baseUrl);
  if (!url.searchParams.has('callerPaneId')) {
    url.searchParams.set('callerPaneId', paneId);
  }
  return url.toString();
}

export function resolveDescriptorPath(argv, env, homedir) {
  const index = argv.indexOf('--descriptor');
  const argvValue =
    index >= 0 && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')
      ? argv[index + 1].trim()
      : '';
  // OVKA-529: `--descriptor` explícito vence; depois a CASA do pane (nunca
  // `--dev`/env herdado que desvie para outra instância); depois env/default.
  if (argvValue) return validateDescriptorPath(argvValue);
  const home = paneHomeDescriptor(env);
  if (home && isPaneHome(env)) return validateDescriptorPath(home);
  const envValue =
    typeof env.NEXUS_ARMS_DESCRIPTOR === 'string'
      ? env.NEXUS_ARMS_DESCRIPTOR.trim()
      : '';
  return validateDescriptorPath(envValue || defaultDescriptorPath(homedir));
}

let descriptorPath = defaultDescriptorPath(os.homedir());
let descriptorPathError = null;
try {
  descriptorPath = resolveDescriptorPath(process.argv, process.env, os.homedir());
} catch (error) {
  descriptorPathError = error;
}

function runtimeDescriptor() {
  if (descriptorPathError) {
    const error = new Error(
      `${descriptorPathError.message}; usando fallback ${descriptorPath}`,
    );
    error.code = 'BAD_DESCRIPTOR_PATH';
    throw error;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    if (parsed?.schemaVersion === 1 && Number.isInteger(parsed.port) && parsed.port > 0) {
      return { port: parsed.port, at: parsed.at ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

function log(message) {
  process.stderr.write(`[nexus-arms] ${message}\n`);
}

async function callApp(method, params) {
  const descriptor = runtimeDescriptor();
  if (!descriptor) {
    const error = new Error(`Nexus não está aberto (nenhum runtime em ${descriptorPath})`);
    error.code = 'APP_CLOSED';
    throw error;
  }
  const token = process.env.NEXUS_ARMS_TOKEN?.trim();
  if (!token) {
    const error = new Error('NEXUS_ARMS_TOKEN ausente — gere um token em Nexus › Configurações › Conectores');
    error.code = 'NO_TOKEN';
    throw error;
  }
  // OVKA-529: a chamada chega como o pane que ela é (orçamento/papel do
  // chamador), nunca como "bootstrap do humano".
  const url = sessionUrl(
    `http://127.0.0.1:${descriptor.port}/arms/mcp`,
    process.env,
  );
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        const error = new Error('token Arms inválido ou revogado — rotacione em Nexus › Configurações › Conectores');
        error.code = 'BAD_TOKEN';
        throw error;
      }
      if (!response.ok) throw new Error(`app respondeu ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error.code === 'BAD_TOKEN' || error.code === 'NO_TOKEN') throw error;
      if (attempt === RETRIES) {
        if (error.name === 'AbortError') {
          const timeoutError = new Error(`Nexus não respondeu em ${FETCH_TIMEOUT_MS / 1000}s (porta ${descriptor.port})`);
          timeoutError.code = 'TIMEOUT';
          throw timeoutError;
        }
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('unreachable');
}

const LOCAL_TOOLS = [
  {
    name: 'nexus_app_observe',
    description:
      'Snapshot JSON do estado do Nexus: versão, missões, panes, handoffs ' +
      'pendentes. Só metadado — sem conteúdo de terminal, prompts ou segredos.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nexus_app_events',
    description:
      'Fila de eventos do app com cursor (pane.spawned/exited, ' +
      'handoff.submitted/delivered/consumed, mission.state). Passe `after` ' +
      'com o nextCursor da leitura anterior.',
    inputSchema: {
      type: 'object',
      properties: { after: { type: 'integer', minimum: 0 } },
    },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatchCall(id, params) {
  const name = params?.name;
  if (name !== 'nexus_app_observe' && name !== 'nexus_app_events') {
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `unknown tool: ${String(name ?? '').slice(0, 64)}` },
    });
    return;
  }
  try {
    const appReply = await callApp('tools/call', params);
    // O endpoint responde em lote e com id próprio; stdio MCP espera UM
    // objeto por request com o id do chamador de volta.
    const single = Array.isArray(appReply) ? appReply[0] : appReply;
    write({ ...single, id });
  } catch (error) {
    // App fechado/token ruim: estado de erro MCP limpo, sessão viva.
    write({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `nexus-arms: ${error.message}` }],
        isError: true,
      },
    });
  }
}

async function main() {
  log(`conector Arms iniciado (stdout = JSON-RPC apenas; descriptor=${descriptorPath})`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      log(`linha não-JSON ignorada (${trimmed.length} bytes)`);
      return;
    }
    if (message?.jsonrpc !== '2.0' || typeof message?.method !== 'string') return;
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize':
        write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'nexus-arms', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        });
        return;
      case 'notifications/initialized':
        return;
      case 'ping':
        write({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        write({ jsonrpc: '2.0', id, result: { tools: LOCAL_TOOLS } });
        return;
      case 'tools/call':
        void dispatchCall(id, params);
        return;
      default:
        if (!isNotification) {
          write({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${method.slice(0, 64)}` },
          });
        }
    }
  });
  rl.on('close', () => {
    log('stdin fechado — encerrando');
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(`falha fatal: ${error.message}`);
    process.exit(1);
  });
}
