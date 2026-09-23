/**
 * `describe:true` sob demanda (paridade Overclock 1.4 / OVKA-527.1).
 *
 * Schemas carregam nome/tipo/enum — nunca manual dentro do parâmetro. Ops que
 * têm schema por variante (`op`/`kind`) devolvem o schema completo do op na
 * 1ª chamada com `describe: true`, e só então aceitam os argumentos.
 */

export interface DescribeRequest {
  readonly describe?: boolean | undefined;
}

export interface DescribeEnvelope {
  readonly describe: true;
  readonly op: string;
  readonly inputSchema: Record<string, unknown>;
  readonly note: string;
}

/**
 * Se o chamador pediu `describe`, embrulha o schema do op e sinaliza que a
 * chamada real vem depois. Retorna `null` quando não é pedido de descrição.
 */
export function describeEnvelope(
  describe: boolean | undefined,
  op: string,
  inputSchema: Record<string, unknown>,
): DescribeEnvelope | null {
  if (!describe) return null;
  return {
    describe: true,
    op,
    inputSchema,
    note: 'schema do op sob demanda — repita a chamada com os argumentos (sem prose nos parâmetros)',
  };
}

/** Propriedade padrão a injetar em tools com `op`/`kind` variáveis. */
export const DESCRIBE_PROPERTY = {
  describe: {
    type: 'boolean',
    description: 'Return this op full inputSchema and stop (schema-on-demand).',
  },
} as const;
