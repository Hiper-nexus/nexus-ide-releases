import { beforeEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_CONTRACT_DEFAULT_RETRIES,
  armDeliveryContract,
  armedDeliveryContract,
  deliveryContractExhaustedArtifact,
  deliveryContractRetryMessage,
  disarmDeliveryContract,
  evaluateDeliveryContract,
  parseExpectArg,
  resetDeliveryContractsForTesting,
} from './delivery-contract';

const FILE_LIST_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    required: ['kind', 'path'],
    properties: {
      kind: { type: 'string', enum: ['file'] },
      path: { type: 'string', minLength: 1 },
    },
  },
};

describe('parseExpectArg', () => {
  it('ausente = sem contrato', () => {
    expect(parseExpectArg(undefined)).toBeNull();
    expect(parseExpectArg(null)).toBeNull();
  });

  it('aplica o default de retries e congela o contrato', () => {
    const contract = parseExpectArg({ schema: FILE_LIST_SCHEMA });

    expect(contract?.retries).toBe(DELIVERY_CONTRACT_DEFAULT_RETRIES);
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it('recusa no spawn: sem schema, schema malformado, retries fora da faixa', () => {
    expect(() => parseExpectArg('x')).toThrow(/precisa ser um objeto/);
    expect(() => parseExpectArg({})).toThrow(/`schema`.*obrigatório/);
    expect(() => parseExpectArg({ schema: { type: 'lista' } })).toThrow(
      /tipo desconhecido/,
    );
    expect(() => parseExpectArg({ schema: true, retries: 9 })).toThrow(
      /retries inválido/,
    );
    expect(() => parseExpectArg({ schema: true, retries: 1.5 })).toThrow(
      /retries inválido/,
    );
  });
});

describe('evaluateDeliveryContract', () => {
  beforeEach(() => resetDeliveryContractsForTesting());

  it('sessão sem contrato ou sem id não é cobrada', () => {
    expect(evaluateDeliveryContract(undefined, [])).toEqual({ kind: 'none' });
    expect(evaluateDeliveryContract('s-livre', [])).toEqual({ kind: 'none' });
  });

  it('entrega conforme passa e o contrato continua armado até ser desarmado', () => {
    armDeliveryContract('s1', parseExpectArg({ schema: FILE_LIST_SCHEMA })!);

    expect(
      evaluateDeliveryContract('s1', [{ kind: 'file', path: 'a.ts' }]),
    ).toEqual({ kind: 'ok' });
    expect(armedDeliveryContract('s1')).not.toBeNull();

    disarmDeliveryContract('s1');
    expect(armedDeliveryContract('s1')).toBeNull();
  });

  it('com retries=1: primeira divergência devolve, segunda esgota', () => {
    armDeliveryContract(
      's2',
      parseExpectArg({ schema: FILE_LIST_SCHEMA, retries: 1 })!,
    );

    const first = evaluateDeliveryContract('s2', []);
    const second = evaluateDeliveryContract('s2', [{ kind: 'file' }]);

    expect(first).toMatchObject({
      kind: 'retry',
      attempt: 1,
      retries: 1,
      violations: ['$: mínimo 1 itens (tem 0)'],
    });
    expect(second).toMatchObject({
      kind: 'exhausted',
      attempts: 2,
      retries: 1,
      violations: ['$[0].path: obrigatório e ausente'],
    });
  });

  it('retries=0 esgota na primeira divergência', () => {
    armDeliveryContract(
      's3',
      parseExpectArg({ schema: FILE_LIST_SCHEMA, retries: 0 })!,
    );

    expect(evaluateDeliveryContract('s3', undefined)).toMatchObject({
      kind: 'exhausted',
      attempts: 1,
    });
  });

  it('a mensagem de devolução diz o que falta e o que fazer', () => {
    armDeliveryContract('s4', parseExpectArg({ schema: FILE_LIST_SCHEMA })!);
    const verdict = evaluateDeliveryContract('s4', []);
    if (verdict.kind !== 'retry') throw new Error('esperava retry');

    const message = deliveryContractRetryMessage(verdict);

    expect(message).toContain('devolução 1/1');
    expect(message).toContain('$: mínimo 1 itens (tem 0)');
    expect(message).toMatch(/reenvie o nexus_handoff_submit/);
    expect(message).toMatch(/status blocked/);
  });

  it('o artifact de esgotamento carrega violações e o status declarado', () => {
    armDeliveryContract(
      's5',
      parseExpectArg({ schema: FILE_LIST_SCHEMA, retries: 0 })!,
    );
    const verdict = evaluateDeliveryContract('s5', []);
    if (verdict.kind !== 'exhausted') throw new Error('esperava exhausted');

    expect(deliveryContractExhaustedArtifact(verdict, 'success')).toEqual({
      kind: 'nexus.deliveryContract',
      payload: {
        outcome: 'unmet',
        declaredStatus: 'success',
        attempts: 1,
        retries: 0,
        violations: ['$: mínimo 1 itens (tem 0)'],
      },
    });
  });
});
