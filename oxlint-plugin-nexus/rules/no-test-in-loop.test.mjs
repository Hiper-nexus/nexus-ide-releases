// QLT-06: casos rodando no `RuleTester` do próprio oxlint, como a
// require-suppression-reason.

import { describe, expect, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from '../index.mjs';
import rule, { NO_TEST_IN_LOOP_MESSAGE } from './no-test-in-loop.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const spec = (name, code, filename = 'fixture.test.ts') => ({ name, code, filename });
const flagged = (name, code, lines) => ({
  ...spec(name, code),
  errors: lines.map((line) => ({ message: NO_TEST_IN_LOOP_MESSAGE, line })),
});

describe('plugin nexus', () => {
  it('registra no-test-in-loop com o nome que o .oxlintrc.json liga', () => {
    expect(plugin.rules['no-test-in-loop']).toBe(rule);
  });
});

new RuleTester().run('nexus/no-test-in-loop', rule, {
  valid: [
    spec(
      'aceita it.each e describe.each',
      `
      it.each([1, 2])('caso %s', (value) => { expect(value).toBeGreaterThan(0); });
      describe.each([{ mode: 'a' }])('modo $mode', ({ mode }) => { it('roda', () => {}); });
    `,
    ),
    spec(
      'aceita it.for (contexto do teste no segundo argumento)',
      `it.for(['a', 'b'])('modo %s', (mode, { skip }) => { if (!mode) skip(); });`,
    ),
    spec(
      'aceita laço dentro do corpo do teste',
      `
      it('confere todos', () => {
        for (const item of [1, 2]) expect(item).toBeTruthy();
        [1, 2].forEach((item) => expect(item).toBeTruthy());
      });
    `,
    ),
    spec(
      'ignora variável local chamada suite e métodos .test()',
      `
      it('x', () => {
        for (const id of ids) {
          expect(suite.handoffs.get(id)).toBeTruthy();
          expect(/a/.test(id)).toBe(true);
        }
      });
    `,
    ),
    spec(
      'fora de arquivo de teste não vale (describe/test são helpers do produto)',
      `for (const error of errors) describe(error); items.map((item) => test(item));`,
      'src/main/orch/delegation-supervisor.ts',
    ),
  ],
  invalid: [
    flagged(
      'acusa it dentro de for...of',
      `
      describe('tabela', () => {
        for (const value of [1, 2]) {
          it(\`caso \${value}\`, () => {});
        }
      });
    `,
      [4],
    ),
    flagged(
      'acusa describe dentro de forEach uma vez só (não os its de dentro)',
      `
      ['a', 'b'].forEach((mode) => {
        describe(mode, () => {
          it('um', () => {});
          it('dois', () => {});
        });
      });
    `,
      [3],
    ),
    flagged(
      'acusa it.only, test.skip e laço sem chaves',
      `
      for (let index = 0; index < 2; index += 1) it.only('x', () => {});
      while (pending()) test.skip('y', () => {});
    `,
      [2, 3],
    ),
    flagged(
      'acusa laços aninhados com continue (casos somem sem aviso)',
      `
      for (const adapter of adapters) {
        for (const mode of modes) {
          if (!adapter[mode]) continue;
          it(\`\${adapter.id} (\${mode})\`, () => {});
        }
      }
    `,
      [5],
    ),
    flagged(
      'acusa it.runIf(cond)(...) num laço, uma vez',
      `for (const mode of modes) { it.runIf(native)(\`roda \${mode}\`, () => {}); }`,
      [1],
    ),
    flagged(
      'acusa .map que gera casos',
      `cases.map((caso) => it(caso.name, () => {}));`,
      [1],
    ),
  ],
});
