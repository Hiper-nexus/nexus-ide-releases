/**
 * F-795 — contrato da entrada do spool de handoffs (lado do agente ↔ Main).
 *
 * O agente (hook `nexus-gate.mjs`, ponte stdio `nexus-mcp-bridge.cjs` e o shim
 * `nx-shim.cjs`) grava UMA entrada por handoff que o Main não respondeu, no
 * diretório privado da própria sessão (`NEXUS_HANDOFF_SPOOL_DIR`, 0700). A
 * entrada é assinada com a chave da sessão (`NEXUS_HANDOFF_SPOOL_KEY`, HMAC
 * SHA-256) sobre um array fixo — o payload viaja como TEXTO JSON, então a
 * assinatura não depende de canonicalização igual nos três scripts.
 *
 * O snippet abaixo é embutido nos scripts gerados (hook e ponte). O shim é um
 * recurso estático e carrega uma cópia idêntica; os testes de ida e volta
 * provam que as três escritas passam pela validação do Main.
 */

export const HANDOFF_SPOOL_ENTRY_SCHEMA = 'nexus.handoff-spool-entry/v1';
/** Payload acima disso nem vira entrada (o MCP já recusa acima de 256 KiB). */
export const HANDOFF_SPOOL_MAX_PAYLOAD_BYTES = 400 * 1024;
/** Teto do arquivo da entrada no Main (payload escapado em JSON + envelope). */
export const HANDOFF_SPOOL_MAX_ENTRY_BYTES = 1024 * 1024;
export const HANDOFF_SPOOL_TRANSPORTS = ['mission-shim', 'mcp-bridge', 'gate-hook'] as const;
export type HandoffSpoolTransport = (typeof HANDOFF_SPOOL_TRANSPORTS)[number];

export const HANDOFF_SPOOL_ENV_DIR = 'NEXUS_HANDOFF_SPOOL_DIR';
export const HANDOFF_SPOOL_ENV_ID = 'NEXUS_HANDOFF_SPOOL_ID';
export const HANDOFF_SPOOL_ENV_KEY = 'NEXUS_HANDOFF_SPOOL_KEY';

/** Resposta que o agente recebe quando o handoff foi para o spool. */
export const HANDOFF_SPOOL_AGENT_MESSAGE =
  'Nexus sem resposta: handoff guardado em disco. Ele será entregue ao orquestrador ' +
  'assim que o Nexus responder — não reenvie.';

export interface HandoffSpoolEntryFields {
  readonly schema: string;
  readonly spoolId: string;
  readonly entryId: string;
  readonly createdAt: number;
  readonly transport: string;
  readonly toolName: string;
  readonly requestId?: string;
  readonly payload: string;
}

/** Entrada assinada: mesma ordem nos scripts (`nexusSpoolHandoff`). */
export function handoffSpoolSigningInput(entry: HandoffSpoolEntryFields): string {
  return JSON.stringify([
    entry.schema,
    entry.spoolId,
    entry.entryId,
    entry.createdAt,
    entry.transport,
    entry.toolName,
    entry.requestId ?? null,
    entry.payload,
  ]);
}

/**
 * Snippet JavaScript (sem crase nem interpolação) que os scripts gerados
 * embutem. Espera `crypto`, `fs` e `path` do Node no escopo. Nunca lança:
 * sem spool (env ausente, disco cheio, payload grande) devolve null e o
 * chamador mantém o comportamento anterior.
 */
export const HANDOFF_SPOOL_WRITER_JS = String.raw`
// F-795 (gerado pelo Nexus): spool de handoff em disco quando o Main não responde.
const NEXUS_SPOOL_SCHEMA = ${JSON.stringify(HANDOFF_SPOOL_ENTRY_SCHEMA)};
const NEXUS_SPOOL_MAX_PAYLOAD_BYTES = ${HANDOFF_SPOOL_MAX_PAYLOAD_BYTES};
const NEXUS_SPOOL_MESSAGE = ${JSON.stringify(HANDOFF_SPOOL_AGENT_MESSAGE)};
function nexusSpoolHandoff(env, transport, payload, requestId) {
  try {
    const dir = String(env.${HANDOFF_SPOOL_ENV_DIR} || '');
    const spoolId = String(env.${HANDOFF_SPOOL_ENV_ID} || '');
    const key = String(env.${HANDOFF_SPOOL_ENV_KEY} || '');
    if (!dir || !path.isAbsolute(dir) || !spoolId || !/^[a-f0-9]{64}$/.test(key)) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > NEXUS_SPOOL_MAX_PAYLOAD_BYTES) return null;
    const entry = {
      schema: NEXUS_SPOOL_SCHEMA,
      spoolId: spoolId,
      entryId: crypto.randomUUID(),
      createdAt: Date.now(),
      transport: transport,
      toolName: 'nexus_handoff_submit',
    };
    if (typeof requestId === 'string' && requestId) entry.requestId = requestId;
    entry.payload = body;
    entry.mac = crypto.createHmac('sha256', key).update(JSON.stringify([
      entry.schema, entry.spoolId, entry.entryId, entry.createdAt, entry.transport,
      entry.toolName, entry.requestId === undefined ? null : entry.requestId, entry.payload,
    ])).digest('hex');
    const name = String(entry.createdAt).padStart(13, '0') + '-' + entry.entryId + '.json';
    const temporary = path.join(dir, '.' + name + '.' + process.pid + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, path.join(dir, name));
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) {}
      throw error;
    }
    return { entryId: entry.entryId };
  } catch (_) {
    return null;
  }
}
`;
