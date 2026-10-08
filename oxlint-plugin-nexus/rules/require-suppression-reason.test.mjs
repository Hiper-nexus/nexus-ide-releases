// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: os mesmos casos do
// upstream rodando no `RuleTester` do próprio oxlint (`oxlint/plugins-dev`) em
// vez do harness Effect que gravava fixture e chamava o binário; mais o
// plugin carregado como o `.oxlintrc.json` carrega.

import { describe, expect, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from '../index.mjs';
import rule, { LINT_REASON_MESSAGE, TS_REASON_MESSAGE } from './require-suppression-reason.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const tsx = (name, code) => ({ name, code, filename: 'fixture.tsx' });

describe('plugin nexus', () => {
  it('registra a regra com o nome que o .oxlintrc.json liga', () => {
    expect(plugin.meta.name).toBe('nexus');
    expect(plugin.rules['require-suppression-reason']).toBe(rule);
  });
});

new RuleTester().run('nexus/require-suppression-reason', rule, {
  valid: [
    tsx(
      'aceita diretiva com -- motivo',
      `
      // oxlint-disable-next-line no-control-regex -- ANSI começa com ESC.
      const ansi = /\\x1b\\[/;
      /* eslint-disable no-console -- este script reporta no terminal */
    `,
    ),
    tsx(
      'aceita diretiva explicada pelo comentário de cima',
      `
      // As posições são estáveis para uma mesma string.
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
    ),
    tsx(
      'aceita diretivas empilhadas sob uma explicação',
      `
      // A fixture é inválida de propósito.
      // @ts-expect-error
      // oxlint-disable-next-line no-unused-vars
      const value: number = "text";
    `,
    ),
    tsx(
      'aceita diretiva do TypeScript seguida do motivo',
      `
      // @ts-expect-error a fixture passa string de propósito
      const count: number = "text";
    `,
    ),
    tsx(
      'aceita diretiva em comentário JSX com motivo',
      `const el = <div>{/* oxlint-disable-next-line react/no-danger -- sanitizado acima */}</div>;`,
    ),
    tsx('ignora diretivas enable', `/* oxlint-enable no-console */`),
    tsx(
      'aceita linha de comentário vazia entre o motivo e a diretiva',
      `
      // As posições são estáveis para uma mesma string.
      //
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
    ),
  ],
  invalid: [
    {
      ...tsx(
        'acusa diretiva de lint sem motivo',
        `
      // oxlint-disable-next-line no-control-regex
      const ansi = /\\x1b\\[/;
    `,
      ),
      errors: [{ message: LINT_REASON_MESSAGE, line: 2 }],
    },
    {
      ...tsx('acusa diretiva de arquivo sem motivo', `/* oxlint-disable eslint/no-useless-escape */`),
      errors: [{ message: LINT_REASON_MESSAGE, line: 1 }],
    },
    {
      ...tsx(
        'acusa eslint-disable-next-line sem motivo (o caso do PaneLeaf)',
        `
      useLayoutEffect(() => {}, []);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    `,
      ),
      errors: [{ message: LINT_REASON_MESSAGE, line: 3 }],
    },
    {
      ...tsx(
        'acusa diretiva do TypeScript sem motivo',
        `
      // @ts-expect-error
      const count: number = "text";
    `,
      ),
      errors: [{ message: TS_REASON_MESSAGE, line: 2 }],
    },
    {
      ...tsx(
        'acusa @ts-ignore só com pontuação depois',
        `
      // @ts-ignore: --
      const count: number = "text";
    `,
      ),
      errors: [{ message: TS_REASON_MESSAGE, line: 2 }],
    },
    {
      ...tsx(
        'não conta comentário separado por linha em branco',
        `
      // As posições são estáveis para uma mesma string.

      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
      ),
      errors: [{ message: LINT_REASON_MESSAGE, line: 4 }],
    },
    {
      ...tsx(
        'não conta comentário vazio acima',
        `
      //
      /* */
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
      ),
      errors: [{ message: LINT_REASON_MESSAGE, line: 4 }],
    },
    {
      ...tsx(
        'não conta comentário no fim da linha de código de cima',
        `
      const first = 1; // o primeiro valor
      const second = 2; // oxlint-disable-line no-unused-vars
    `,
      ),
      errors: [{ message: LINT_REASON_MESSAGE, line: 3 }],
    },
  ],
});
