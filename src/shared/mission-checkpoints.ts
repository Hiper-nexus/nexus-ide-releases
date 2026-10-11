/**
 * F-1173 — checkpoints ocultos de writer vistos pela pessoa (aba Resultado →
 * "O que mudou"). Projeção só de leitura do que o Main já guarda em
 * `refs/nexus-checkpoint/…`; a raiz de cada árvore sai da autoridade do Main,
 * o renderer só devolve a ref que recebeu.
 */

/** Lista de arquivos com teto: `total` diz quantos existem de verdade. */
export interface MissionCheckpointFileList {
  readonly files: readonly string[];
  readonly total: number;
}

export interface MissionCheckpointEntryView {
  readonly ref: string;
  readonly ordinal: number;
  /** Epoch ms da gravação do checkpoint. */
  readonly createdAt: number;
  /** `turn` = fim do turno de um writer; `backup` = cópia antes de restaurar. */
  readonly kind: 'turn' | 'backup' | 'other';
  /** Writer que fechou o turno (metadado da mensagem, nunca autoridade). */
  readonly writer: string | null;
  /** Arquivos que o checkpoint traz diferentes do HEAD daquele momento. */
  readonly changed: MissionCheckpointFileList;
}

export interface MissionCheckpointScopeView {
  readonly root: string;
  readonly branch: string | null;
  readonly checkpoints: readonly MissionCheckpointEntryView[];
  /** A árvore existe na missão, mas não pôde ser lida agora. */
  readonly unavailable?: string;
}

export type MissionCheckpointListResult =
  | { readonly ok: true; readonly missionId: string; readonly scopes: readonly MissionCheckpointScopeView[] }
  | { readonly ok: false; readonly error: string };

export interface MissionCheckpointPlanView {
  readonly ref: string;
  readonly root: string;
  readonly overwrite: MissionCheckpointFileList;
  readonly create: MissionCheckpointFileList;
  /** Arquivos que existem agora e não estão no checkpoint: ficam como estão. */
  readonly keptExtra: MissionCheckpointFileList;
  /** Caminhos bloqueados (diretório/symlink): não são escritos. */
  readonly conflicts: MissionCheckpointFileList;
}

export type MissionCheckpointPreviewResult =
  | ({
      readonly ok: true;
      /** Impressão do plano mostrado; a restauração exige a mesma. */
      readonly fingerprint: string;
    } & MissionCheckpointPlanView)
  | { readonly ok: false; readonly error: string };

export type MissionCheckpointRestoreResult =
  | ({
      readonly ok: true;
      readonly applied: boolean;
      /** Estado anterior guardado antes de escrever (só quando escreveu). */
      readonly backupRef: string | null;
    } & MissionCheckpointPlanView)
  | {
      readonly ok: false;
      readonly error: string;
      /** O plano mudou desde a prévia: nada foi escrito; peça outra prévia. */
      readonly stale?: true;
    };

export interface MissionCheckpointRefInput {
  readonly missionId: string;
  readonly ref: string;
}

export interface MissionCheckpointRestoreInput extends MissionCheckpointRefInput {
  /** `fingerprint` devolvido pela prévia que a pessoa confirmou. */
  readonly fingerprint: string;
}
