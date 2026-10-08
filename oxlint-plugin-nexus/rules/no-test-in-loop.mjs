// QLT-06 (harvest T3 Code @ 26285ab, ideia da regra `no-test-in-loop`; código
// escrito aqui, sem copiar o upstream).
//
// Caso de teste registrado dentro de laço (`for`, `while`, `.forEach`, `.map`)
// some do relatório como caso nomeado: o vitest não sabe que é uma tabela, o
// `--testNamePattern` não acha o caso, e um `break`/`return`/`continue` ou uma
// tabela vazia apaga casos sem nenhum aviso. `it.each`/`describe.each` declaram
// a tabela e dão nome a cada linha.

// `suite`/`bench` ficam de fora: nenhum teste do Nexus os importa, e `suite` é
// nome comum de variável local nos testes (`suite.handoffs.get(...)`).
const TEST_FUNCTIONS = new Set(['it', 'test', 'describe']);
// Só arquivos de teste: no código do produto `describe`/`test` são helpers
// locais (`describe(error)`, `regex.test(...)`), não registro de caso.
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);
const TABLE_METHODS = new Set(['each', 'for']);
const ITERATION_METHODS = new Set(['forEach', 'map', 'flatMap']);

export const NO_TEST_IN_LOOP_MESSAGE =
  'Teste registrado em laço: use `it.each`/`describe.each` (cada caso com nome no relatório e no filtro).';

/**
 * `it(...)`, `it.only(...)`, `describe.skip(...)`, `test.concurrent.only(...)`
 * e as formas com condição `it.runIf(cond)(...)`/`describe.skipIf(cond)(...)`.
 */
function isTestCall(node) {
  if (node?.type !== 'CallExpression') return false;
  let callee = node.callee;
  if (callee.type === 'CallExpression') return isTestCall(callee);
  while (callee.type === 'MemberExpression' && !callee.computed) {
    // `it.each(tabela)(...)`/`it.for(tabela)(...)` são a forma certa.
    if (TABLE_METHODS.has(callee.property.name)) return false;
    callee = callee.object;
  }
  return callee.type === 'Identifier' && TEST_FUNCTIONS.has(callee.name);
}

/** Callback de `lista.forEach(...)`/`.map(...)`/`.flatMap(...)`. */
function isIterationCallback(node) {
  const call = node.parent;
  return (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    call?.type === 'CallExpression' &&
    call.arguments[0] === node &&
    call.callee.type === 'MemberExpression' &&
    !call.callee.computed &&
    ITERATION_METHODS.has(call.callee.property.name)
  );
}

const noTestInLoop = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Casos de teste não são registrados dentro de laços; use `it.each`/`describe.each`.',
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};
    return {
      CallExpression(node) {
        if (!isTestCall(node)) return;
        // `it.runIf(cond)` é a cabeça de `it.runIf(cond)(nome, fn)`: conta uma vez, na de fora.
        if (node.parent?.type === 'CallExpression' && node.parent.callee === node) return;
        // Sobe até achar um laço. Parar no primeiro teste de fora: dentro do
        // callback de um `describe`/`it`, quem responde pelo laço de fora é ele.
        for (let current = node; current.parent; current = current.parent) {
          const parent = current.parent;
          if (isTestCall(parent)) return;
          if (LOOP_TYPES.has(parent.type) && parent.body === current) {
            context.report({ node, message: NO_TEST_IN_LOOP_MESSAGE });
            return;
          }
          if (isIterationCallback(current)) {
            context.report({ node, message: NO_TEST_IN_LOOP_MESSAGE });
            return;
          }
        }
      },
    };
  },
};

export default noTestInLoop;
