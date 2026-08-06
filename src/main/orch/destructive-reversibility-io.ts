/**
 * Metade EXECUTORA da reversibilidade destrutiva (N1).
 *
 * O planejador (`destructive-reversibility.ts`) decide o caminho de volta; este
 * módulo o constrói ANTES de a ação acontecer. A ordem é o produto inteiro:
 * remover a pergunta sem ter construído o desfazer trocaria uma fricção por uma
 * perda de dados.
 *
 * Os dois preparos PRECEDEM o comando, que sempre roda inteiro:
 *  - `trash` manda os caminhos para a lixeira do SO. O `rm -rf` seguinte vira
 *    no-op de exit 0 — é por isso que o planejador exige `-f` e comando simples:
 *    sem `-f` o rm falharia com "No such file", um erro que nós teríamos criado.
 *  - `backup-ref` guarda o tip anterior numa ref do git.
 *
 * Nenhum dos dois pula o comando. Um preparo que exigisse "não rode isto" seria
 * uma flag que, esquecida por quem chama, apaga o arquivo da lixeira E do disco.
 *
 * IO injetado: o caminho de volta precisa ser testável sem apagar arquivo de
 * ninguém, e é justamente o código em que um teste que "quase" exercita a coisa
 * certa não vale nada.
 */
import type { DestructiveReversibilityPlan } from './destructive-reversibility';

export interface ReversibilityIo {
  /** Lixeira do SO (Electron `shell.trashItem`). Deve rejeitar se falhar. */
  trash(absolutePath: string): Promise<void>;
  /** Resolve uma revisão para SHA, ou `null` se ela não existe. */
  revParse(cwd: string, revision: string): Promise<string | null>;
  /** Cria/atualiza uma ref apontando para `sha`. */
  updateRef(cwd: string, ref: string, sha: string): Promise<void>;
  /** Caminho relativo → absoluto dentro do checkout. */
  resolvePath(cwd: string, target: string): string;
}

export interface ReversibilityReceipt {
  readonly command: string;
  /**
   * A frase que o operador lê depois. Não é decorativa: é a única coisa que
   * transforma "aconteceu sem me perguntar" em "aconteceu e eu sei desfazer".
   */
  readonly revertPath: string;
  /** `false` quando não existe volta — registrado, nunca perguntado. */
  readonly reversible: boolean;
}

/** Namespace próprio: não polui refs/heads nem aparece em `git branch`. */
const BACKUP_REF_PREFIX = 'refs/nexus-undo';

const SUBJECT_REVISION: Record<'remote-tip' | 'head', string> = {
  // Antes de um force-push, o que se perde é o tip REMOTO — não o local.
  // Guardar HEAD aqui daria uma ref inútil: ela já é o que estamos empurrando.
  'remote-tip': '@{upstream}',
  head: 'HEAD',
};

function backupRefName(subject: 'remote-tip' | 'head', stamp: number): string {
  return `${BACKUP_REF_PREFIX}/${subject}-${stamp}`;
}

export async function prepareDestructiveReversibility(
  plan: DestructiveReversibilityPlan,
  options: {
    readonly cwd: string;
    readonly io: ReversibilityIo;
    readonly now: number;
  },
): Promise<ReversibilityReceipt> {
  const { cwd, io, now } = options;

  if (plan.kind === 'not-destructive') {
    return {
      command: plan.command,
      revertPath: '',
      reversible: true,
    };
  }

  if (plan.kind === 'record-irreversible') {
    return {
      command: plan.command,
      revertPath: `Sem desfazer: ${plan.reason}.`,
      reversible: false,
    };
  }

  if (plan.kind === 'trash') {
    const trashed: string[] = [];
    for (const target of plan.paths) {
      const absolute = io.resolvePath(cwd, target);
      await io.trash(absolute);
      trashed.push(absolute);
    }
    return {
      command: plan.command,
      revertPath: `Na Lixeira: ${trashed.join(', ')}. Restaurar de lá desfaz.`,
      reversible: true,
    };
  }

  const revision = SUBJECT_REVISION[plan.subject];
  const sha = await io.revParse(cwd, revision);
  if (!sha) {
    // Sem tip anterior não há o que guardar (branch novo, sem upstream). Não é
    // falha: é ausência de coisa a perder. Degrada para registro, nunca para
    // pergunta — ver mission-degradation.ts.
    return {
      command: plan.command,
      revertPath: `Sem ${revision} para guardar: nada anterior a perder.`,
      reversible: true,
    };
  }
  const ref = backupRefName(plan.subject, now);
  await io.updateRef(cwd, ref, sha);
  return {
    command: plan.command,
    revertPath: `Tip anterior (${sha.slice(0, 12)}) guardado em ${ref}. Desfazer: git reset --hard ${ref}`,
    reversible: true,
  };
}
