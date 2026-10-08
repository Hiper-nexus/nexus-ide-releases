// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ESM puro em vez de TS
// (sem `@oxlint/plugins`: `defineRule` é identidade e o pacote não está instalado;
// assim o plugin carrega em qualquer Node 22 sem type-stripping), tipos em JSDoc,
// `@effect-diagnostics` fora da lista (o Nexus não usa Effect) e mensagens em pt-BR.

// Comentários que desligam ou religam um diagnóstico. Nenhum deles explica outro.
const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck))/u;
// Diretivas do próprio TypeScript; o que vem depois delas é o motivo.
const TS_DIRECTIVE_PATTERN = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const EMPTY_COMMENT_PATTERN = /^[\s*]*$/u;

export const LINT_REASON_MESSAGE =
  'Diga por quê: termine a diretiva com `-- motivo` ou ponha um comentário na linha de cima.';
export const TS_REASON_MESSAGE =
  'Diga por quê: escreva o motivo depois da diretiva ou num comentário na linha de cima.';

/**
 * Acusa diretiva que desliga uma regra de lint ou o type checker sem dizer por
 * quê. O motivo é um sufixo `-- motivo` (para `@ts-*`, o texto depois da
 * diretiva) ou um comentário na linha imediatamente acima.
 */
const requireSuppressionReason = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Toda supressão de lint ou do type checker diz por quê.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        /** @type {Map<number, any>} */
        const ownLineCommentsByEndLine = new Map();
        for (const comment of comments) {
          const { line, column } = comment.loc.start;
          if ((sourceCode.lines[line - 1] ?? '').slice(0, column).trim() === '') {
            ownLineCommentsByEndLine.set(comment.loc.end.line, comment);
          }
        }

        // Um comentário logo acima explica a diretiva, mesmo atravessando
        // diretivas empilhadas e linhas de comentário vazias.
        const explainedAbove = (directive) => {
          let above = ownLineCommentsByEndLine.get(directive.loc.start.line - 1);
          while (
            above &&
            (DIRECTIVE_PATTERN.test(above.value) || EMPTY_COMMENT_PATTERN.test(above.value))
          ) {
            above = ownLineCommentsByEndLine.get(above.loc.start.line - 1);
          }
          return above !== undefined;
        };

        for (const directive of sourceCode.getDisableDirectives().directives) {
          if (directive.type === 'enable' || directive.justification?.trim()) continue;
          if (explainedAbove(directive.node)) continue;
          context.report({ loc: directive.node.loc, message: LINT_REASON_MESSAGE });
        }

        for (const comment of comments) {
          const after = TS_DIRECTIVE_PATTERN.exec(comment.value)?.[1];
          if (after === undefined || after.replace(/^[\s:-]+/u, '').trim()) continue;
          if (explainedAbove(comment)) continue;
          context.report({ loc: comment.loc, message: TS_REASON_MESSAGE });
        }
      },
    };
  },
};

export default requireSuppressionReason;
