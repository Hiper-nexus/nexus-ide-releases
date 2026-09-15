import { describe, expect, it } from 'vitest';
import {
  JSON_SCHEMA_LITE_MAX_VIOLATIONS,
  jsonSchemaLiteProblems,
  validateJsonSchemaLite,
} from './json-schema-lite';

describe('validateJsonSchemaLite — contrato de entrega', () => {
  it('aceita um valor conforme e devolve lista vazia', () => {
    const schema = {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['kind', 'path'],
        properties: {
          kind: { type: 'string', enum: ['file', 'test'] },
          path: { type: 'string', minLength: 1 },
        },
      },
    };

    const violations = validateJsonSchemaLite(schema, [
      { kind: 'file', path: 'src/a.ts' },
    ]);

    expect(violations).toEqual([]);
  });

  it('nomeia o que falta com o caminho JSON (o worker lê isso)', () => {
    const schema = {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['kind', 'path'],
        properties: { kind: { type: 'string' } },
      },
    };

    const violations = validateJsonSchemaLite(schema, [{ kind: 7 }]);

    expect(violations).toContain('$: mínimo 2 itens (tem 1)');
    expect(violations).toContain('$[0].path: obrigatório e ausente');
    expect(violations).toContain('$[0].kind: esperado string, recebido number(7)');
  });

  it('trata tipo errado na raiz como violação única e para de descer', () => {
    const violations = validateJsonSchemaLite(
      { type: 'array', items: { type: 'object', required: ['x'] } },
      'não sou lista',
    );

    expect(violations).toEqual(['$: esperado array, recebido string(13)']);
  });

  it('cobre enum, const, pattern, limites numéricos e de tamanho', () => {
    const schema = {
      type: 'object',
      properties: {
        status: { enum: ['ok', 'skip'] },
        version: { const: 2 },
        sha: { type: 'string', pattern: '^[0-9a-f]{7,}$' },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        name: { type: 'string', maxLength: 3 },
      },
    };

    const violations = validateJsonSchemaLite(schema, {
      status: 'nope',
      version: 3,
      sha: 'xyz',
      count: 2.5,
      name: 'longo',
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('$.status: valor fora do enum'),
        '$.version: esperado exatamente 2',
        '$.sha: não casa com o padrão /^[0-9a-f]{7,}$/',
        '$.count: esperado integer, recebido number(2.5)',
        '$.name: máximo 3 caracteres (tem 5)',
      ]),
    );
  });

  it('additionalProperties:false denuncia chave fora do contrato', () => {
    const violations = validateJsonSchemaLite(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      { a: 'x', b: 1 },
    );

    expect(violations).toEqual(['$.b: propriedade não prevista no contrato']);
  });

  it('anyOf/oneOf/allOf e nullable', () => {
    const either = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateJsonSchemaLite(either, 'a')).toEqual([]);
    expect(validateJsonSchemaLite(either, true)).toHaveLength(1);

    const exactlyOne = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    expect(validateJsonSchemaLite(exactlyOne, 1)[0]).toMatch(/satisfaz 2/);
    expect(validateJsonSchemaLite(exactlyOne, 1.5)).toEqual([]);

    const both = {
      allOf: [{ type: 'string' }, { type: 'string', minLength: 2 }],
    };
    expect(validateJsonSchemaLite(both, 'a')).toHaveLength(1);

    expect(
      validateJsonSchemaLite({ type: 'string', nullable: true }, null),
    ).toEqual([]);
  });

  it('respeita o teto de violações para não afogar o worker', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const value = new Array(100).fill(0);

    const violations = validateJsonSchemaLite(schema, value);

    expect(violations).toHaveLength(JSON_SCHEMA_LITE_MAX_VIOLATIONS);
  });

  it('schema true aceita tudo; false recusa tudo', () => {
    expect(validateJsonSchemaLite(true, { qualquer: 1 })).toEqual([]);
    expect(validateJsonSchemaLite(false, 1)).toEqual([
      '$: valor não permitido pelo schema',
    ]);
  });
});

describe('jsonSchemaLiteProblems — sanidade no spawn', () => {
  it('aceita um schema bem formado', () => {
    expect(
      jsonSchemaLiteProblems({
        type: 'object',
        required: ['a'],
        properties: { a: { type: ['string', 'null'] } },
        anyOf: [{ type: 'object' }],
      }),
    ).toEqual([]);
  });

  it('recusa tipo desconhecido, required inválido, regex quebrada e não-objeto', () => {
    expect(jsonSchemaLiteProblems('x')).toEqual([
      '$: schema precisa ser um objeto (ou true/false)',
    ]);
    expect(
      jsonSchemaLiteProblems({
        type: 'strang',
        required: 'a',
        pattern: '(',
        properties: { b: { anyOf: [] } },
      }),
    ).toEqual(
      expect.arrayContaining([
        '$.type: tipo desconhecido "strang"',
        '$.required: precisa ser uma lista de nomes',
        '$.pattern: regex inválida',
        '$.properties.b.anyOf: precisa ser uma lista não vazia',
      ]),
    );
  });
});
