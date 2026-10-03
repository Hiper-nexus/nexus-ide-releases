/**
 * Arestas da memória (F-800/F-801): o que liga uma linha do SQLite a um
 * arquivo do repo, a uma missão ou a outra nota. É o "grafo" da memória —
 * deliberadamente pequeno: nenhum grafo novo, só as ligações que o texto já
 * declara (caminho citado, `Mission:` do evento trusted, `[[wikilink]]`).
 *
 * Quem percorre relações é o mapa de orientação (`nexus_code_map_blast_radius`);
 * aqui mora só a junção memória ↔ nó. Também define a chave de ASSUNTO da
 * primeira linha (`# Título`), usada para a versão nova de um assunto
 * substituir a anterior em vez de empilhar.
 *
 * Toda varredura é linear no tamanho do texto: as regexes abaixo só começam
 * em fronteira de token e nunca retrocedem além do token corrente (teste
 * adversarial de 16 KB em memory-links.test.ts).
 */
import { isProjectableMissionId, missionIdFromProjectionSource } from '../../shared/mission-id';

/** Prefixos dos alvos normalizados gravados em `memory_links.target`. */
export const FILE_LINK_PREFIX = 'file:';
export const MISSION_LINK_PREFIX = 'mission:';
export const NOTE_LINK_PREFIX = 'note:';

/** Teto de alvos por memória: uma linha de 8 KB cheia de caminhos não vira milhares de arestas. */
export const MAX_LINK_TARGETS = 64;

/**
 * Caminho de arquivo citado no texto (`src/main/x.ts`, `docs/a/b.md`). Mesmo
 * padrão do vault legível (wikilinks automáticos): o que vira `[[arquivo]]`
 * na projeção é exatamente o que vira aresta aqui.
 */
export const FILE_PATH_TOKEN_RE =
  /(?<![\w@+.~:/[\]-])((?:[\w@+.~-]+\/)+[\w+.~-]+\.[A-Za-z0-9]{1,8})(?![\w\]|])/g;

const WIKILINK_RE = /\[\[([^\]\n]{1,256})\]\]/g;
const MISSION_LINE_RE = /^Mission:[ \t]+([a-z0-9][a-z0-9-]{0,63})[ \t]*$/gm;

/**
 * Títulos que as classes automáticas usam como RÓTULO, não como assunto: duas
 * entregas distintas chamam-se ambas "Delivered handoff". Para elas a chave
 * de assunto é nula — nunca uma entrega substitui a anterior pelo título.
 */
export const GENERIC_MEMORY_TITLES: ReadonlySet<string> = new Set(
  [
    'Accepted task handoff',
    'Delivered handoff',
    'Session digest',
    'Operator preference',
    'Operator decision',
    'Approved merge',
    'Resolved problem',
    'Architecture rule',
  ].map((title) => normalizeSubject(title)),
);

export function normalizeSubject(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 160);
}

/** Caminho repo-relativo normalizado (separador `/`, sem `./` inicial). */
export function fileLinkTarget(relativePath: string): string | null {
  const normalized = relativePath
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    return null;
  }
  return `${FILE_LINK_PREFIX}${normalized.slice(0, 512)}`;
}

export function missionLinkTarget(missionId: string): string | null {
  return isProjectableMissionId(missionId) ? `${MISSION_LINK_PREFIX}${missionId}` : null;
}

/**
 * Chave de assunto: só quando a primeira linha não vazia é um heading
 * Markdown (`# Título`) e o título não é rótulo genérico de classe. Sem
 * heading não há assunto declarado — e aí nada é substituído por engano.
 */
export function memorySubjectKey(content: string): string | null {
  const firstLine = content
    .slice(0, 4_096)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const heading = /^#{1,6}[ \t]+(.+)$/.exec(firstLine)?.[1]?.trim();
  if (!heading) return null;
  const key = normalizeSubject(heading);
  if (!key || GENERIC_MEMORY_TITLES.has(key)) return null;
  return key;
}

/**
 * Alvos ligados a uma memória, deduplicados e limitados:
 *  - `file:<caminho>` para cada caminho de arquivo citado ou `[[arquivo]]`;
 *  - `mission:<id>` para a linha `Mission: <id>` (eventos trusted) e para a
 *    atribuição canônica do operador em `source` (`operator:mission:<id>`);
 *  - `note:<assunto>` para `[[Título]]` que não é caminho de arquivo.
 */
export function extractMemoryLinkTargets(
  content: string,
  source: string | null | undefined = null,
): string[] {
  const targets = new Set<string>();
  const add = (target: string | null): void => {
    if (target && targets.size < MAX_LINK_TARGETS) targets.add(target);
  };
  const text = content.slice(0, 16_384);
  for (const match of text.matchAll(WIKILINK_RE)) {
    const raw = match[1]!.trim();
    const pipe = raw.indexOf('|');
    const inner = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
    if (!inner) continue;
    if (/^[\w@+.~-]+(?:\/[\w@+.~-]+)*\.[A-Za-z0-9]{1,8}$/.test(inner)) {
      add(fileLinkTarget(inner));
    } else {
      const key = normalizeSubject(inner);
      if (key) add(`${NOTE_LINK_PREFIX}${key}`);
    }
  }
  for (const match of text.matchAll(FILE_PATH_TOKEN_RE)) {
    add(fileLinkTarget(match[1]!));
  }
  for (const match of text.matchAll(MISSION_LINE_RE)) {
    add(missionLinkTarget(match[1]!));
  }
  const missionFromSource = missionIdFromProjectionSource(source);
  if (missionFromSource) add(missionLinkTarget(missionFromSource));
  return [...targets];
}

/** Só os caminhos (sem prefixo) entre os alvos de uma lista. */
export function filePathsOfTargets(targets: readonly string[]): string[] {
  return targets
    .filter((target) => target.startsWith(FILE_LINK_PREFIX))
    .map((target) => target.slice(FILE_LINK_PREFIX.length));
}
