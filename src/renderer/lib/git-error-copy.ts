/**
 * Erro de Git em linguagem de gente.
 *
 * O painel jogava `err.message` cru na tela: mensagens do próprio git, em
 * inglês, com `exit code`, caminho absoluto e às vezes o comando inteiro. Para
 * quem não programa isso não é diagnóstico — é ruído que culpa sem ensinar.
 *
 * Regra: nomear a CAUSA e dizer o próximo passo. Causa desconhecida vira uma
 * frase honesta, e o texto original fica disponível para quem quiser (o
 * chamador decide mostrar em "detalhes técnicos").
 */

export interface GitErrorCopy {
  /** O que aconteceu + o que fazer, numa frase. */
  readonly message: string;
  /** Texto original do git, para disclosure técnico. Nunca vazio. */
  readonly detail: string;
}

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /not a git repository|não é um repositório/iu,
    'Esta pasta não é um repositório Git. Abra um projeto versionado ou rode `git init` nele.',
  ],
  [
    /nothing to commit|nada a submeter/iu,
    'Não há mudanças para salvar — tudo já está registrado.',
  ],
  [
    /no changes added to commit/iu,
    'Nenhuma mudança foi marcada para salvar. Use "Adicionar tudo" antes.',
  ],
  [
    /please tell me who you are|empty ident|user\.email/iu,
    'O Git ainda não sabe quem é você. Configure nome e e-mail com `git config --global user.email`.',
  ],
  [
    /could not read from remote|repository not found|permission denied \(publickey\)|authentication failed/iu,
    'Sem acesso ao repositório remoto. Confira a credencial ou a permissão da conta.',
  ],
  [
    /no such remote|does not appear to be a git repository|no configured push destination/iu,
    'Este projeto não tem um destino remoto configurado.',
  ],
  [
    /conflict|merge failed|unmerged/iu,
    'Há conflitos que precisam da sua decisão antes de continuar.',
  ],
  [
    /would be overwritten by|local changes/iu,
    'Há mudanças locais que seriam perdidas. Salve ou descarte antes de continuar.',
  ],
  [
    /detached head/iu,
    'O projeto está fora de uma branch. Volte para uma branch antes de salvar.',
  ],
  [
    /lock file|index\.lock/iu,
    'Outra operação de Git está em andamento nesta pasta. Aguarde e tente de novo.',
  ],
];

/** Frase honesta quando a causa não é reconhecida — nunca o texto cru. */
const FALLBACK_BY_ACTION: Readonly<Record<string, string>> = {
  status: 'Não foi possível ler o estado do projeto. Tente novamente.',
  diff: 'Não foi possível mostrar as diferenças deste arquivo.',
  stage: 'Não foi possível marcar esta mudança. Tente novamente.',
  unstage: 'Não foi possível desmarcar esta mudança. Tente novamente.',
  commit: 'Não foi possível salvar as mudanças. Veja os detalhes técnicos.',
  comment: 'Não foi possível enviar o comentário.',
};

export function gitErrorCopy(
  error: unknown,
  action: keyof typeof FALLBACK_BY_ACTION | string = 'status',
): GitErrorCopy {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  for (const [pattern, message] of RULES) {
    if (pattern.test(detail)) return { message, detail };
  }
  return {
    message:
      FALLBACK_BY_ACTION[action] ??
      'Não foi possível concluir esta operação de Git.',
    detail,
  };
}
