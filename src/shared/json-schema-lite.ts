/**
 * Validador MÍNIMO de JSON Schema para contratos de entrega (`expect.schema`
 * no spawn de worker — paridade Overclock 1.3.23).
 *
 * Subconjunto deliberado e suficiente para descrever "o que o worker precisa
 * entregar": type, required, properties, additionalProperties:false, items,
 * minItems/maxItems, enum, const, minLength/maxLength, pattern,
 * minimum/maximum, anyOf/oneOf/allOf e nullable. Nada de $ref, formats ou
 * dependências.
 *
 * Sem dependência externa de propósito: o `ajv` presente em node_modules é
 * transitivo de devDependencies e não é empacotado no asar. O que este módulo
 * devolve é uma lista de violações LEGÍVEIS, com caminho — é o texto que o
 * worker recebe para saber exatamente o que faltou na entrega.
 */

export type JsonSchemaLite = Readonly<Record<string, unknown>>;

/** Teto de violações reportadas: o worker lê, não faz auditoria. */
export const JSON_SCHEMA_LITE_MAX_VIOLATIONS = 25;

const VALID_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'integer') {
    return actual === 'number' && Number.isInteger(value as number);
  }
  if (expected === 'number') return actual === 'number';
  return actual === expected;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function describe(value: unknown): string {
  const kind = typeOf(value);
  if (kind === 'string') {
    const text = value as string;
    return `string(${text.length})`;
  }
  if (kind === 'array') return `array(${(value as unknown[]).length})`;
  if (kind === 'object') {
    return `object{${Object.keys(value as object).slice(0, 6).join(',')}}`;
  }
  if (kind === 'null' || kind === 'undefined') return kind;
  return `${kind}(${String(value)})`;
}

/**
 * Sanidade estrutural do schema ANTES de armar um contrato: um schema
 * malformado precisa falhar no spawn (visível para quem declarou), nunca no
 * handoff (onde o worker pagaria por um erro do orquestrador).
 */
export function jsonSchemaLiteProblems(schema: unknown, path = '$'): string[] {
  if (schema === true || schema === false) return [];
  if (!isPlainObject(schema)) {
    return [`${path}: schema precisa ser um objeto (ou true/false)`];
  }
  const problems: string[] = [];
  const type = schema.type;
  if (type !== undefined) {
    const list = Array.isArray(type) ? type : [type];
    for (const entry of list) {
      if (typeof entry !== 'string' || !VALID_TYPES.has(entry)) {
        problems.push(`${path}.type: tipo desconhecido ${JSON.stringify(entry)}`);
      }
    }
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      problems.push(`${path}.properties: precisa ser um objeto`);
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        problems.push(...jsonSchemaLiteProblems(child, `${path}.properties.${key}`));
      }
    }
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((entry) => typeof entry !== 'string')
    ) {
      problems.push(`${path}.required: precisa ser uma lista de nomes`);
    }
  }
  if (schema.items !== undefined) {
    problems.push(...jsonSchemaLiteProblems(schema.items, `${path}.items`));
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[combinator];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) {
      problems.push(`${path}.${combinator}: precisa ser uma lista não vazia`);
      continue;
    }
    branches.forEach((branch, index) => {
      problems.push(
        ...jsonSchemaLiteProblems(branch, `${path}.${combinator}[${index}]`),
      );
    });
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') {
      problems.push(`${path}.pattern: precisa ser string`);
    } else {
      try {
        new RegExp(schema.pattern, 'u');
      } catch {
        problems.push(`${path}.pattern: regex inválida`);
      }
    }
  }
  return problems;
}

/**
 * Valida `value` contra `schema`. Devolve [] quando conforme; senão, uma
 * violação por linha, com o caminho JSON do ponto que falhou.
 */
export function validateJsonSchemaLite(
  schema: unknown,
  value: unknown,
  path = '$',
): string[] {
  const violations: string[] = [];
  validateInto(schema, value, path, violations);
  return violations.slice(0, JSON_SCHEMA_LITE_MAX_VIOLATIONS);
}

function validateInto(
  schema: unknown,
  value: unknown,
  path: string,
  out: string[],
): void {
  if (out.length >= JSON_SCHEMA_LITE_MAX_VIOLATIONS) return;
  if (schema === true) return;
  if (schema === false) {
    out.push(`${path}: valor não permitido pelo schema`);
    return;
  }
  if (!isPlainObject(schema)) return;

  if (value === null && schema.nullable === true) return;

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type)
      ? (schema.type as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [schema.type as string];
    if (!expected.some((entry) => matchesType(entry, value))) {
      out.push(
        `${path}: esperado ${expected.join('|')}, recebido ${describe(value)}`,
      );
      return;
    }
  }

  if (schema.const !== undefined) {
    if (stableStringify(schema.const) !== stableStringify(value)) {
      out.push(`${path}: esperado exatamente ${JSON.stringify(schema.const)}`);
    }
  }
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    const hit = allowed.some(
      (candidate) => stableStringify(candidate) === stableStringify(value),
    );
    if (!hit) {
      out.push(
        `${path}: valor fora do enum ${JSON.stringify(allowed.slice(0, 8))}`,
      );
    }
  }

  if (typeof value === 'string') {
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      out.push(`${path}: mínimo ${schema.minLength} caracteres (tem ${value.length})`);
    }
    if (
      typeof schema.maxLength === 'number' &&
      value.length > schema.maxLength
    ) {
      out.push(`${path}: máximo ${schema.maxLength} caracteres (tem ${value.length})`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) {
          out.push(`${path}: não casa com o padrão /${schema.pattern}/`);
        }
      } catch {
        // schema malformado já é recusado no spawn; aqui não bloqueia.
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push(`${path}: mínimo ${schema.minimum} (tem ${value})`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push(`${path}: máximo ${schema.maximum} (tem ${value})`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${path}: mínimo ${schema.minItems} itens (tem ${value.length})`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push(`${path}: máximo ${schema.maxItems} itens (tem ${value.length})`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        validateInto(schema.items, entry, `${path}[${index}]`, out);
      });
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as unknown[]) {
        if (typeof key === 'string' && !(key in value)) {
          out.push(`${path}.${key}: obrigatório e ausente`);
        }
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in value) {
          validateInto(child, value[key], `${path}.${key}`, out);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) {
            out.push(`${path}.${key}: propriedade não prevista no contrato`);
          }
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    (schema.allOf as unknown[]).forEach((branch, index) => {
      validateInto(branch, value, `${path}<allOf[${index}]>`, out);
    });
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as unknown[];
    const passes = branches.some(
      (branch) => validateJsonSchemaLite(branch, value, path).length === 0,
    );
    if (!passes) {
      out.push(`${path}: não satisfaz nenhuma das ${branches.length} alternativas (anyOf)`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as unknown[];
    const passing = branches.filter(
      (branch) => validateJsonSchemaLite(branch, value, path).length === 0,
    ).length;
    if (passing !== 1) {
      out.push(
        `${path}: precisa satisfazer exatamente uma alternativa (oneOf), satisfaz ${passing}`,
      );
    }
  }
}
