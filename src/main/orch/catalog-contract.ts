export type CatalogKind = 'agent' | 'skill';

export interface CatalogEntry {
  kind: CatalogKind;
  slug: string;
  name: string;
  category: string;
}

export interface CatalogProvenance {
  repository: string;
  commitSha: string;
  sha256?: string;
  fileCount?: number;
  totalBytes?: number;
  warnings?: string[];
}

export interface CatalogIndex {
  fetchedAt: number;
  agents: CatalogEntry[];
  skills: CatalogEntry[];
  provenance?: CatalogProvenance;
}

export interface InstallResult {
  ok: boolean;
  skipped?: boolean;
  installed?: { name: string; path: string };
  provenance?: CatalogProvenance;
  error?: string;
}

export interface CatalogInstallReview {
  readonly kind: CatalogKind;
  readonly slug: string;
  readonly name: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly targetPath: string;
  readonly alreadyInstalled: boolean;
}

export interface CatalogPreparedInstall extends CatalogInstallReview {
  readonly alreadyInstalled: false;
  readonly sha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly warnings: readonly string[];
}

export interface CatalogInstallOptions {
  readonly expectedCommitSha?: string;
  readonly beforePublish?: (
    candidate: CatalogPreparedInstall,
  ) => Promise<boolean> | boolean;
  readonly assertCurrentAuthority?: () => void;
  readonly operationTimeoutMs?: number;
}

export interface InstalledItem {
  kind: string;
  name: string;
  file: string;
  size: number;
  modifiedAt: number;
  /**
   * F-1308: quando um nome duplicado entre homes colapsa (first-wins), a cópia
   * vencedora aponta aqui o `file` das cópias ofuscadas que perderam.
   */
  shadowedFrom?: string[];
}
