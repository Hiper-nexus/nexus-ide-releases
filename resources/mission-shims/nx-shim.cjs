#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "nexus.mission-shim-request/v1";
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 25;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = LOCK_TIMEOUT_MS;

// O teto do Main (30 s de relógio) é o limite: o env só ENCURTA a espera.
function responseTimeoutMs(env) {
  const value = Number(env.NEXUS_SHIM_RESPONSE_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RESPONSE_TIMEOUT_MS;
  return Math.min(DEFAULT_RESPONSE_TIMEOUT_MS, Math.max(50, Math.floor(value)));
}

// F-795: spool de handoff em disco quando o Main não responde. Mesmo formato
// e assinatura do hook e da ponte stdio (src/main/orch/handoff-spool-entry.ts);
// o Main valida, deduplica e ingere no boot ou quando volta a responder.
const NEXUS_SPOOL_SCHEMA = "nexus.handoff-spool-entry/v1";
const NEXUS_SPOOL_MAX_PAYLOAD_BYTES = 400 * 1024;
const NEXUS_SPOOL_MESSAGE =
  "Nexus sem resposta: handoff guardado em disco. Ele será entregue ao orquestrador " +
  "assim que o Nexus responder — não reenvie.";

function nexusSpoolHandoff(env, transport, payload, requestId) {
  try {
    const dir = String(env.NEXUS_HANDOFF_SPOOL_DIR || "");
    const spoolId = String(env.NEXUS_HANDOFF_SPOOL_ID || "");
    const key = String(env.NEXUS_HANDOFF_SPOOL_KEY || "");
    if (!dir || !path.isAbsolute(dir) || !spoolId || !/^[a-f0-9]{64}$/.test(key)) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > NEXUS_SPOOL_MAX_PAYLOAD_BYTES) return null;
    const entry = {
      schema: NEXUS_SPOOL_SCHEMA,
      spoolId,
      entryId: crypto.randomUUID(),
      createdAt: Date.now(),
      transport,
      toolName: "nexus_handoff_submit",
    };
    if (typeof requestId === "string" && requestId) entry.requestId = requestId;
    entry.payload = body;
    entry.mac = crypto
      .createHmac("sha256", key)
      .update(
        JSON.stringify([
          entry.schema,
          entry.spoolId,
          entry.entryId,
          entry.createdAt,
          entry.transport,
          entry.toolName,
          entry.requestId === undefined ? null : entry.requestId,
          entry.payload,
        ]),
      )
      .digest("hex");
    const name = `${String(entry.createdAt).padStart(13, "0")}-${entry.entryId}.json`;
    const temporary = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.renameSync(temporary, path.join(dir, name));
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Nada a limpar.
      }
      throw error;
    }
    return { entryId: entry.entryId };
  } catch {
    return null;
  }
}

// F-988: `--help`/`-h`/`help` responde aqui, na hora, sem tocar o canal do
// Main. Nenhuma execução pode passar deste teto total (lock + resposta + folga).
const HARD_DEADLINE_MS = LOCK_TIMEOUT_MS + DEFAULT_RESPONSE_TIMEOUT_MS + 10_000;
const COMMAND_BY_EXECUTABLE = {
  "nx-mail": "mail",
  "nx-task": "task",
  "nx-notify": "notify",
  nexus_handoff_submit: "handoff-submit",
};
const USAGE = {
  "handoff-submit": [
    'uso: nexus_handoff_submit --status success|partial|blocked|failed --summary "<resumo objetivo>"',
    "                          [--artifact <caminho ou JSON>]... [--evidence <id>]...",
    '  ou: nexus_handoff_submit \'{"status":"success","summary":"<resumo>","artifacts":["<caminho>"]}\'',
  ],
  mail: [
    'uso: nx-mail send --status success|partial|blocked|failed --summary "<resumo objetivo>"',
    "                  [--artifact <caminho ou JSON>]... [--evidence <id>]...",
    "     nx-mail list [--all]",
  ],
  task: ["uso: nx-task list"],
  notify: ["uso: nx-notify heartbeat"],
};

function executableName() {
  return path.basename(process.argv[1] || "").replace(/\.cmd$/i, "");
}

/** Pedido de ajuda? Devolve o comando (ou null = todos); undefined = não é ajuda. */
function requestedHelp(argv) {
  let command = COMMAND_BY_EXECUTABLE[executableName()];
  let rest = argv;
  if (!command) {
    if (argv.length === 0) return undefined;
    if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return null;
    command = argv[0];
    rest = argv.slice(1);
  }
  // A forma JSON (estilo tool-call) nunca é ajuda.
  if (typeof rest[0] === "string" && rest[0].trimStart().startsWith("{")) return undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") return command;
    if (index === 0 && token === "help") return command;
    // Valor de uma opção (`--summary -h`) não é pedido de ajuda.
    if (token.startsWith("--") && token !== "--all") index += 1;
  }
  return undefined;
}

function helpText(command) {
  const sections = command && USAGE[command]
    ? [USAGE[command]]
    : [USAGE["handoff-submit"], USAGE.mail, USAGE.task, USAGE.notify];
  return [
    ...sections.flat(),
    "",
    "Ajuda local: nada foi enviado ao Nexus. Entregue o handoff uma única vez, ao terminar.",
    "",
  ].join("\n");
}

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function signingInput(request) {
  return JSON.stringify([
    request.schema,
    request.capabilityId,
    request.requestId,
    request.sequence,
    request.issuedAt,
    request.command,
    request.operation,
    canonicalize(request.args),
  ]);
}

function parseFlags(tokens) {
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`argumento inesperado: ${token}`);
    }
    const name = token.slice(2);
    if (name === "all") {
      values.set(name, true);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`valor ausente para --${name}`);
    }
    index += 1;
    const previous = values.get(name);
    values.set(
      name,
      previous === undefined ? value : [].concat(previous, value),
    );
  }
  return values;
}

function repeated(values, name) {
  const value = values.get(name);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseArtifact(value) {
  const first = value.trimStart()[0];
  if (first !== "{" && first !== "[") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

function assertAllowedFlags(values, allowed) {
  for (const name of values.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`opção não suportada: --${name}`);
    }
  }
}

/**
 * Alias canônico (padrão invokta; voo real 19/08): worker sem rota MCP chuta
 * o NOME DA TOOL no shell. `nexus_handoff_submit` aceita flags OU um único
 * argumento JSON {status, summary, artifacts?, evidenceIds?} e roteia para
 * mail/send — mesmo dispatcher, mesma cadeia de receipts.
 */
function parseHandoffSubmitAlias(argv) {
  const first = argv[0];
  if (typeof first === "string" && first.trimStart().startsWith("{")) {
    let payload;
    try {
      payload = JSON.parse(argv.join(" "));
    } catch {
      throw new Error("JSON inválido para nexus_handoff_submit");
    }
    const status = payload && payload.status;
    const summary = payload && payload.summary;
    if (typeof status !== "string" || typeof summary !== "string") {
      throw new Error("nexus_handoff_submit exige status e summary");
    }
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    const evidenceIds = Array.isArray(payload.evidenceIds)
      ? payload.evidenceIds.filter((value) => typeof value === "string")
      : [];
    return {
      command: "mail",
      operation: "send",
      args: {
        status,
        summary,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
      },
    };
  }
  const flags = parseFlags(argv);
  assertAllowedFlags(
    flags,
    new Set(["status", "summary", "artifact", "evidence"]),
  );
  const status = flags.get("status");
  const summary = flags.get("summary");
  if (typeof status !== "string" || typeof summary !== "string") {
    throw new Error(
      'uso: nexus_handoff_submit --status success|partial|blocked|failed ' +
        '--summary "<resumo objetivo>"',
    );
  }
  const artifacts = repeated(flags, "artifact").map(parseArtifact);
  const evidenceIds = repeated(flags, "evidence");
  return {
    command: "mail",
    operation: "send",
    args: {
      status,
      summary,
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
    },
  };
}

function parseCommand(argv) {
  const executable = executableName();
  const commandFromName = {
    "nx-mail": "mail",
    "nx-task": "task",
    "nx-notify": "notify",
  }[executable];
  if (executable === "nexus_handoff_submit") {
    return parseHandoffSubmitAlias(argv);
  }
  const command = commandFromName || argv.shift();
  // `nexus handoff-submit …` e o passthrough `nx-shim.cjs handoff-submit …`.
  if (!commandFromName && command === "handoff-submit") {
    return parseHandoffSubmitAlias(argv);
  }
  const operation = argv.shift();
  if (!command || !operation) {
    throw new Error(
      "uso: nexus_handoff_submit --status … --summary …, nx-mail send|list, " +
        "nx-task list, ou nx-notify heartbeat",
    );
  }
  const flags = parseFlags(argv);
  if (command === "mail" && operation === "send") {
    assertAllowedFlags(
      flags,
      new Set(["status", "summary", "artifact", "evidence"]),
    );
    const status = flags.get("status");
    const summary = flags.get("summary");
    if (typeof status !== "string" || typeof summary !== "string") {
      throw new Error("nx-mail send exige --status e --summary");
    }
    const artifacts = repeated(flags, "artifact").map(parseArtifact);
    const evidenceIds = repeated(flags, "evidence");
    return {
      command,
      operation,
      args: {
        status,
        summary,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
      },
    };
  }
  if (command === "mail" && operation === "list") {
    assertAllowedFlags(flags, new Set(["all"]));
    return {
      command,
      operation,
      args: { includeDelivered: flags.get("all") === true },
    };
  }
  if (command === "task" && operation === "list") {
    assertAllowedFlags(flags, new Set());
    return { command, operation, args: { action: "list" } };
  }
  if (command === "notify" && operation === "heartbeat") {
    assertAllowedFlags(flags, new Set());
    return { command, operation, args: {} };
  }
  throw new Error(`operação não suportada: ${command} ${operation}`);
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function removeStaleLock(lockPath) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return true;
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error("lock de sequência nx não é um arquivo");
  }
  if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return true;
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        if (removeStaleLock(lockPath)) continue;
        await wait(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error("nx shim ocupado: não foi possível reservar a sequência");
}

function readLastSequence(sequencePath) {
  try {
    const value = Number(fs.readFileSync(sequencePath, "utf8"));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
}

function writeAtomic(
  filePath,
  content,
  mode = 0o600,
  temporaryDir = path.dirname(filePath),
) {
  const temporary = path.join(
    temporaryDir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

async function submitRequest(parsed, env) {
  const rootDir = env.NEXUS_SHIM_ROOT;
  const capabilityId = env.NEXUS_SHIM_CAPABILITY_ID;
  const secret = env.NEXUS_SHIM_SECRET;
  if (!rootDir || !capabilityId || !secret) {
    throw new Error(
      "canal nx indisponível: abra este comando dentro de um worker Nexus",
    );
  }
  const requestsDir = path.join(rootDir, "requests");
  const responsesDir = path.join(rootDir, "responses");
  const stateDir = path.join(rootDir, "state");
  const lockPath = path.join(stateDir, "sequence.lock");
  const sequencePath = path.join(stateDir, "sequence");
  const lock = await acquireLock(lockPath);
  let request;
  let requestName;
  try {
    const prior = readLastSequence(sequencePath);
    const sequence = Math.max(Date.now() * 1_000, prior + 1);
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("sequência nx excedeu o limite seguro");
    }
    request = {
      schema: SCHEMA,
      capabilityId,
      requestId: crypto.randomUUID(),
      sequence,
      issuedAt: Date.now(),
      command: parsed.command,
      operation: parsed.operation,
      args: parsed.args,
      mac: "",
    };
    request.mac = crypto
      .createHmac("sha256", secret)
      .update(signingInput(request))
      .digest("hex");
    writeAtomic(sequencePath, `${sequence}\n`);
    requestName = `${String(sequence).padStart(16, "0")}-${request.requestId}.json`;
    writeAtomic(
      path.join(requestsDir, requestName),
      `${JSON.stringify(request)}\n`,
      0o600,
      stateDir,
    );
  } finally {
    fs.closeSync(lock);
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }

  const responsePath = path.join(responsesDir, `${request.requestId}.json`);
  const deadline = Date.now() + responseTimeoutMs(env);
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
      try {
        fs.unlinkSync(responsePath);
      } catch {
        // Main may already be cleaning a revoked runtime.
      }
      return response;
    } catch (error) {
      if (
        !error ||
        (error.code !== "ENOENT" && !(error instanceof SyntaxError))
      ) {
        throw error;
      }
    }
    await wait(POLL_INTERVAL_MS);
  }
  if (parsed.command === "mail" && parsed.operation === "send") {
    // F-795: o Main não respondeu ao handoff. Tira o pedido da fila (se o
    // Main ainda não o pegou, ele nunca vai processá-lo) e guarda o payload
    // no spool da sessão; o Main ingere uma única vez quando voltar.
    try {
      fs.unlinkSync(path.join(requestsDir, requestName));
    } catch {
      // O Main já reivindicou o pedido: a ingestão deduplica pelo payload.
    }
    const spooled = nexusSpoolHandoff(env, "mission-shim", parsed.args, request.requestId);
    if (spooled) {
      return {
        ok: true,
        tool: "mission-shim",
        spooled: true,
        spoolEntryId: spooled.entryId,
        message: NEXUS_SPOOL_MESSAGE,
      };
    }
  }
  return {
    ok: false,
    tool: "mission-shim",
    error: "shim_response_timeout",
    effectMayHaveCommitted: true,
  };
}

async function main() {
  const help = requestedHelp(process.argv.slice(2));
  if (help !== undefined) {
    process.stdout.write(helpText(help));
    process.exitCode = 0;
    return;
  }
  // Teto total: lock e espera já têm prazo; isto cobre qualquer outra espera.
  const deadline = setTimeout(() => {
    process.stderr.write(
      `nx shim: sem resposta em ${Math.round(HARD_DEADLINE_MS / 1000)} s; encerrado.\n`,
    );
    process.exit(1);
  }, HARD_DEADLINE_MS);
  if (typeof deadline.unref === "function") deadline.unref();
  let parsed;
  try {
    parsed = parseCommand(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    const response = await submitRequest(parsed, process.env);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (!response || response.ok !== true) process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1);
  }
}

void main();
