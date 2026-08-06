/**
 * Reversibilidade antes da ação — o preço honesto do "zero fricção" (0.27.1).
 *
 * O piso de consentimento existia porque `rm -rf`, `push --force` e
 * `reset --hard` eram tidos como irreversíveis. Só que eles só são
 * irreversíveis se nada for feito ANTES: mandar para a lixeira em vez de
 * desligar o inode, e guardar um ref do tip anterior, transformam os três em
 * operações com desfazer. O dono escolheu não ser perguntado; a implementação
 * honesta dessa escolha é transparência DEPOIS, não pergunta ANTES.
 *
 * Módulo puro: decide o plano, não executa. Quem executa é o caminho de shell,
 * que primeiro cumpre o preparo e registra na auditoria.
 */
import { isDestructive } from '../jarvis/guardrails';

export type DestructiveReversibilityPlan =
  | { readonly kind: 'not-destructive'; readonly command: string }
  | {
      readonly kind: 'trash';
      readonly command: string;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'backup-ref';
      readonly command: string;
      readonly subject: 'remote-tip' | 'head';
    }
  | {
      readonly kind: 'record-irreversible';
      readonly command: string;
      readonly reason: string;
    };

/** Raiz, home ou volume montado: lixeira ali não é desfazer, é outro desastre. */
const UNTRASHABLE_TARGET = /^(\/|~|\/Volumes\/|\/mnt\/|\/media\/|[A-Za-z]:\\?$)/;

const RM_RF = /\brm\s+(?:-[a-zA-Z]*\s+)*-?[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(.+)$/;

function parseRemovalTargets(command: string): readonly string[] {
  const match = RM_RF.exec(command);
  if (!match?.[1]) return [];
  return match[1]
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !token.startsWith('-'));
}

export function planDestructiveReversibility(
  command: string,
): DestructiveReversibilityPlan {
  const trimmed = command.trim();
  if (!isDestructive(trimmed)) {
    return { kind: 'not-destructive', command: trimmed };
  }
  if (/\brm\s+/.test(trimmed)) {
    const paths = parseRemovalTargets(trimmed);
    if (paths.length === 0) {
      return {
        kind: 'record-irreversible',
        command: trimmed,
        reason: 'remoção sem alvo legível — não dá para mandar para a lixeira',
      };
    }
    if (paths.some((path) => UNTRASHABLE_TARGET.test(path))) {
      return {
        kind: 'record-irreversible',
        command: trimmed,
        reason: 'alvo é raiz, home ou volume montado: a lixeira não desfaz isso',
      };
    }
    return { kind: 'trash', command: trimmed, paths };
  }
  if (/git\s+push\s+.*(--force|-f\b)/.test(trimmed)) {
    return { kind: 'backup-ref', command: trimmed, subject: 'remote-tip' };
  }
  if (/git\s+reset\s+--hard/.test(trimmed)) {
    return { kind: 'backup-ref', command: trimmed, subject: 'head' };
  }
  return {
    kind: 'record-irreversible',
    command: trimmed,
    reason: 'efeito sem desfazer conhecido: registrado na auditoria da missão',
  };
}
