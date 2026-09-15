/**
 * Contrato de entrega por pane (paridade Overclock 1.3.23 — `pane_spawn.expect`).
 *
 * Declarado no NASCIMENTO do worker (registro, não pergunta), como o
 * autoCloseOnHandoff: `{schema, retries}`. No `nexus_handoff_submit` com status
 * success, os `artifacts` que o worker mandou são validados contra o schema.
 * Divergência devolve ao worker EXATAMENTE o que falta — até `retries` vezes;
 * depois o handoff entra como `blocked` com as violações registradas, para o
 * orquestrador decidir com evidência em vez de confiar na palavra do worker.
 *
 * Registro em memória por sessão física: o contrato morre com o processo — um
 * pane sobrevivente de crash nunca é cobrado por um contrato fantasma.
 */
import {
  jsonSchemaLiteProblems,
  validateJsonSchemaLite,
  type JsonSchemaLite,
} from '../../shared/json-schema-lite';

export interface DeliveryContract {
  readonly schema: JsonSchemaLite | boolean;
  /** Quantas devoluções o worker recebe antes de o handoff cair como blocked. */
  readonly retries: number;
}

export const DELIVERY_CONTRACT_DEFAULT_RETRIES = 1;
export const DELIVERY_CONTRACT_MAX_RETRIES = 5;

export type DeliveryVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'retry';
      readonly violations: readonly string[];
      readonly attempt: number;
      readonly retries: number;
    }
  | {
      readonly kind: 'exhausted';
      readonly violations: readonly string[];
      readonly attempts: number;
      readonly retries: number;
    };

interface ArmedContract {
  readonly contract: DeliveryContract;
  attempts: number;
}

const armedBySession = new Map<string, ArmedContract>();

/**
 * Lê o argumento `expect` do spawn. Inválido = erro VISÍVEL para quem
 * declarou (o orquestrador), antes de qualquer pane existir — nunca uma
 * cobrança impossível de cumprir no handoff do worker.
 */
export function parseExpectArg(raw: unknown): DeliveryContract | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('expect inválido: precisa ser um objeto {schema, retries?}');
  }
  const input = raw as Record<string, unknown>;
  if (input.schema === undefined) {
    throw new Error('expect inválido: campo `schema` (JSON Schema) é obrigatório');
  }
  const problems = jsonSchemaLiteProblems(input.schema);
  if (problems.length > 0) {
    throw new Error(`expect.schema inválido: ${problems.join('; ')}`);
  }
  let retries = DELIVERY_CONTRACT_DEFAULT_RETRIES;
  if (input.retries !== undefined) {
    if (
      typeof input.retries !== 'number' ||
      !Number.isInteger(input.retries) ||
      input.retries < 0 ||
      input.retries > DELIVERY_CONTRACT_MAX_RETRIES
    ) {
      throw new Error(
        `expect.retries inválido: inteiro entre 0 e ${DELIVERY_CONTRACT_MAX_RETRIES}`,
      );
    }
    retries = input.retries;
  }
  return Object.freeze({
    schema: input.schema as JsonSchemaLite | boolean,
    retries,
  });
}

export function armDeliveryContract(
  sessionId: string,
  contract: DeliveryContract,
): void {
  armedBySession.set(sessionId, { contract, attempts: 0 });
}

export function disarmDeliveryContract(sessionId: string): void {
  armedBySession.delete(sessionId);
}

export function armedDeliveryContract(
  sessionId: string,
): DeliveryContract | null {
  return armedBySession.get(sessionId)?.contract ?? null;
}

/**
 * Julga os artifacts de um handoff success contra o contrato da sessão.
 * Cada divergência CONSOME uma tentativa: com retries=1 o worker recebe uma
 * devolução e, na segunda divergência, o handoff cai como blocked.
 */
export function evaluateDeliveryContract(
  sessionId: string | undefined,
  artifacts: unknown,
): DeliveryVerdict {
  if (!sessionId) return { kind: 'none' };
  const armed = armedBySession.get(sessionId);
  if (!armed) return { kind: 'none' };
  const violations = validateJsonSchemaLite(
    armed.contract.schema,
    artifacts === undefined ? [] : artifacts,
  );
  if (violations.length === 0) return { kind: 'ok' };
  armed.attempts += 1;
  if (armed.attempts <= armed.contract.retries) {
    return {
      kind: 'retry',
      violations,
      attempt: armed.attempts,
      retries: armed.contract.retries,
    };
  }
  return {
    kind: 'exhausted',
    violations,
    attempts: armed.attempts,
    retries: armed.contract.retries,
  };
}

/** Texto que o worker recebe como erro da tool: o que falta e o que fazer. */
export function deliveryContractRetryMessage(
  verdict: Extract<DeliveryVerdict, { kind: 'retry' }>,
): string {
  return (
    `contrato de entrega não cumprido (devolução ${verdict.attempt}/${verdict.retries}): ` +
    `${verdict.violations.join('; ')}. ` +
    'Complete os `artifacts` exigidos e reenvie o nexus_handoff_submit com ' +
    'status success. Se não conseguir cumprir, envie status blocked ' +
    'explicando o impedimento em vez de repetir o mesmo payload.'
  );
}

/** Artifact registrado no handoff quando as devoluções se esgotaram. */
export function deliveryContractExhaustedArtifact(
  verdict: Extract<DeliveryVerdict, { kind: 'exhausted' }>,
  declaredStatus: string,
): { readonly kind: 'nexus.deliveryContract'; readonly payload: unknown } {
  return {
    kind: 'nexus.deliveryContract',
    payload: {
      outcome: 'unmet',
      declaredStatus,
      attempts: verdict.attempts,
      retries: verdict.retries,
      violations: [...verdict.violations],
    },
  };
}

export function resetDeliveryContractsForTesting(): void {
  armedBySession.clear();
}
