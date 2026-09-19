import fs from 'node:fs';
import path from 'node:path';
import type { CodexIngestSnapshot } from './codex-transcript';
import { isCodexIngestSnapshot } from './codex-transcript';

/**
 * Persistência dos offsets de resume do scanner Codex (`<dir>/codex-resume.json`).
 *
 * O scanner é global (hoje+ontem, todos os projetos), então o estado não cabe
 * nos stores por escopo: um JSON pequeno com um registro por rollout. Escrita
 * atômica (tmp+rename), leitura tolerante (JSON inválido ou registro
 * malformado = reparse integral daquele arquivo, nunca throw para o scanner).
 */

export interface CodexResumeRecord {
  /** Offset em bytes no fim da última linha completa ingerida. */
  readonly offset: number;
  /** Tamanho do arquivo quando o registro foi salvo (detecta rotação sob skip). */
  readonly size: number;
  /**
   * Snapshot do ingestor no offset (ordinal incluído — ele compõe o messageId).
   * Nulo quando nada atribuível foi ingerido (skip/inactive só precisam flags).
   */
  readonly ingest: CodexIngestSnapshot | null;
  readonly skip: boolean;
  readonly inactiveCwd: string | null;
  readonly headDigest: string | null;
  readonly boundaryDigest: string | null;
}

interface ResumeFile {
  readonly version: 1;
  readonly files: Record<string, CodexResumeRecord>;
}

const RESUME_FILE_NAME = 'codex-resume.json';
const MAX_RECORDS = 1000;

function isRecord(value: unknown): value is CodexResumeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.offset) &&
    (record.offset as number) >= 0 &&
    Number.isSafeInteger(record.size) &&
    (record.size as number) >= 0 &&
    (record.ingest === null || isCodexIngestSnapshot(record.ingest)) &&
    typeof record.skip === 'boolean' &&
    (record.inactiveCwd === null || typeof record.inactiveCwd === 'string') &&
    (record.headDigest === null || typeof record.headDigest === 'string') &&
    (record.boundaryDigest === null ||
      typeof record.boundaryDigest === 'string')
  );
}

export class CodexResumeStore {
  private readonly file: string;
  private cache = new Map<string, CodexResumeRecord>();
  private loaded = false;

  constructor(dir: string) {
    this.file = path.join(dir, RESUME_FILE_NAME);
  }

  get(file: string): CodexResumeRecord | null {
    this.ensureLoaded();
    return this.cache.get(file) ?? null;
  }

  set(file: string, record: CodexResumeRecord): void {
    this.ensureLoaded();
    // Map preserva a ordem de inserção original no set: delete+set renova a
    // posição para a poda por teto expulsar o realmente mais antigo.
    this.cache.delete(file);
    this.cache.set(file, record);
  }

  delete(file: string): void {
    this.ensureLoaded();
    this.cache.delete(file);
  }

  /** Persiste tudo de uma vez; nunca lança (o scanner nunca bloqueia em fs). */
  save(): void {
    try {
      this.ensureLoaded();
      this.prune();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload: ResumeFile = {
        version: 1,
        files: Object.fromEntries(this.cache),
      };
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), { flag: 'w' });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      console.warn('[codex-usage] resume store save skipped', error);
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ResumeFile>;
      if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== 'object') {
        return;
      }
      for (const [file, record] of Object.entries(parsed.files)) {
        if (typeof file === 'string' && isRecord(record)) {
          this.cache.set(file, record);
        }
      }
    } catch {
      this.cache.clear();
    }
  }

  private missingPrunedOnce = false;

  private prune(): void {
    // Achado review: varrer statSync em até 1000 arquivos a cada flush (10s)
    // trava a main thread; arquivos sumidos só precisam sair uma vez por
    // processo, e o teto usa ordem LRU renovada no set().
    if (!this.missingPrunedOnce) {
      this.missingPrunedOnce = true;
      for (const file of [...this.cache.keys()]) {
        try {
          fs.statSync(file);
        } catch {
          this.cache.delete(file);
        }
      }
    }
    while (this.cache.size > MAX_RECORDS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) return;
      this.cache.delete(oldest.value);
    }
  }
}
