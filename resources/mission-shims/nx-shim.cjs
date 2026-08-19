#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "nexus.mission-shim-request/v1";
const RESPONSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 25;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = LOCK_TIMEOUT_MS;

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
  const executable = path.basename(process.argv[1]).replace(/\.cmd$/i, "");
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
    const requestName = `${String(sequence).padStart(16, "0")}-${request.requestId}.json`;
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
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
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
  return {
    ok: false,
    tool: "mission-shim",
    error: "shim_response_timeout",
    effectMayHaveCommitted: true,
  };
}

async function main() {
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
