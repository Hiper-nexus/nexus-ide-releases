import type { Squad } from '../../shared/orch-types';

const GENERIC_WORDS = new Set([
  'abre', 'abra', 'abrir', 'inicia', 'inicie', 'iniciar', 'sobe', 'suba',
  'liga', 'ligue', 'roda', 'rode', 'o', 'a', 'um', 'uma', 'de', 'do', 'da',
  'squad', 'squads', 'equipe', 'time', 'team', 'modo',
]);

export function normalizeSquadVoiceName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !GENERIC_WORDS.has(token))
    .join(' ');
}

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function compactSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const longer = Math.max(a.length, b.length);
  const distance = editDistance(a, b);
  return Math.round(((longer - distance) / longer) * 100);
}

function score(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 100;

  const queryCompact = compact(query);
  const candidateCompact = compact(candidate);
  if (queryCompact === candidateCompact) return 98;

  if (candidate.startsWith(query) || query.startsWith(candidate)) return 86;
  if (candidate.includes(query) || query.includes(candidate)) return 78;
  if (candidateCompact.includes(queryCompact) || queryCompact.includes(candidateCompact)) return 76;

  const qTokens = query.split(' ');
  const cTokens = candidate.split(' ');
  const tokenScores = qTokens.map((token) =>
    Math.max(...cTokens.map((candidateToken) => compactSimilarity(token, candidateToken))),
  );
  const fuzzyTokenScore = tokenScores.length
    ? Math.round(tokenScores.reduce((sum, item) => sum + item, 0) / tokenScores.length)
    : 0;

  const wholeScore = compactSimilarity(queryCompact, candidateCompact);
  return Math.max(fuzzyTokenScore, wholeScore);
}

export type SquadResolution =
  | { kind: 'match'; squad: Squad }
  | { kind: 'ambiguous'; candidates: Squad[] }
  | { kind: 'not-found' };

export function resolveSquadByVoiceName(
  spokenName: string,
  squads: readonly Squad[],
): SquadResolution {
  const query = normalizeSquadVoiceName(spokenName);
  if (!query) return { kind: 'not-found' };

  const ranked = squads
    .map((squad) => ({
      squad,
      score: Math.max(
        score(query, normalizeSquadVoiceName(squad.name)),
        score(query, normalizeSquadVoiceName(squad.id)),
      ),
    }))
    .filter((item) => item.score >= 82)
    .sort((a, b) => b.score - a.score || a.squad.name.localeCompare(b.squad.name));

  if (!ranked.length) return { kind: 'not-found' };

  const best = ranked[0];
  const tied = ranked.filter((item) => item.score === best.score);
  if (tied.length > 1) {
    return { kind: 'ambiguous', candidates: tied.map((item) => item.squad) };
  }

  return { kind: 'match', squad: best.squad };
}
