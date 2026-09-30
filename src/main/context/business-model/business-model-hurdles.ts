import { createHash } from 'node:crypto';

/**
 * HURDLES — a armadilha conhecida do projeto.
 *
 * `docs/AGENTS-HURDLES.md` (e irmãos: *pitfalls*, *armadilhas*, *lições*,
 * *lessons*) é histórico de dor, não regra: são os erros que já morderam quem
 * mexeu naquele trecho. O doc real tem ~2.3 MB e ~1.5 mil entradas — acima do
 * teto de 1 MB por fonte que a extração de regras usa. Este parser é separado
 * justamente para isso: tolera um doc grande, mas continua determinístico e
 * limitado (cap de entradas, resumo curto, texto inerte citando arquivo:linha).
 *
 * Formato suportado (o mesmo do doc real):
 *
 *   ## Hurdle: <título curto>        ← título de nível 2..4 abre a entrada
 *   ...texto livre até o próximo heading...
 *
 * Um heading de nível 1 ou headings fora do padrão encerram a entrada corrente
 * sem abrir outra. Nenhum texto dentro de fence ``` vira entrada.
 */

export interface BusinessHurdle {
  readonly id: string;
  readonly titulo: string;
  readonly resumo: string;
  readonly origem: string;
}

const HURDLE_HEADING = /^#{2,4}\s+(.+?)\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const TITLE_PREFIX = /^(?:hurdle|armadilha|pitfall|li[cç][aã]o(?:\s+aprendida)?|lesson(?:\s+learned)?)\s*:\s*/i;
const MAX_HURDLES = 5000;
const MAX_SUMMARY_CHARS = 320;
const MAX_TITLE_CHARS = 160;

/** Nome de arquivo que o extractor e a seleção reconhecem como doc de hurdles. */
const HURDLE_DOC_BASENAME =
  /hurdle|pitfall|armadilh|li[cç][oõ]es|lessons/i;

export function isHurdleDoc(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return HURDLE_DOC_BASENAME.test(base);
}

export function hurdleId(file: string, titulo: string): string {
  const hash = createHash('sha256')
    .update(file, 'utf8')
    .update('\0', 'utf8')
    .update(titulo, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `hurdle:${hash}`;
}

function collapseWhitespace(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Extrai as hurdles de UM doc. Determinístico: mesma entrada, mesmas ids e
 * resumos. O texto é tratado como dado inerte — nada aqui é instrução.
 */
export function parseBusinessHurdles(
  file: string,
  text: string,
): BusinessHurdle[] {
  const hurdles: BusinessHurdle[] = [];
  let inFence = false;
  let titulo: string | null = null;
  let origem = '';
  let body: string[] = [];

  const flush = (): void => {
    if (titulo === null) return;
    if (hurdles.length < MAX_HURDLES) {
      hurdles.push({
        id: hurdleId(file, titulo),
        titulo,
        resumo: collapseWhitespace(body.join(' '), MAX_SUMMARY_CHARS),
        origem,
      });
    }
    titulo = null;
    body = [];
  };

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = HURDLE_HEADING.exec(line);
    if (heading) {
      flush();
      titulo = collapseWhitespace(
        heading[1]!.replace(TITLE_PREFIX, ''),
        MAX_TITLE_CHARS,
      );
      origem = `${file}:${index + 1}`;
      continue;
    }
    if (ANY_HEADING.test(line)) {
      // Nível 1 (ou heading sem título útil) encerra a entrada corrente.
      flush();
      continue;
    }
    if (titulo !== null) body.push(line);
  }
  flush();
  return Object.freeze(hurdles) as BusinessHurdle[];
}
