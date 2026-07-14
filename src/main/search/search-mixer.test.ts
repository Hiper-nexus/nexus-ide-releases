import { describe, expect, it, vi } from 'vitest';
import type { SearchHit, SearchSourceProvider } from '../../shared/search-mixer-types';
import { SearchMixer, substringScore } from './search-mixer';

function provider(
  source: SearchHit['source'],
  hits: SearchHit[],
  delayMs = 0,
): SearchSourceProvider {
  return {
    source,
    async search(_q, signal) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      }
      return hits;
    },
  };
}

describe('SearchMixer', () => {
  it('ranks and limits across sources with stable order', async () => {
    const mixer = new SearchMixer({ debounceMs: 0 });
    mixer.register(
      provider('files', [
        {
          id: 'f1',
          source: 'files',
          title: 'alpha.ts',
          score: 0.5,
        },
      ]),
    );
    mixer.register(
      provider('missions', [
        {
          id: 'm1',
          source: 'missions',
          title: 'alpha mission',
          score: 0.5,
        },
      ]),
    );

    const result = await mixer.searchNow({ text: 'alpha', limit: 10 });
    expect(result.partial).toBe(false);
    expect(result.hits.map((h) => h.id)).toEqual(['m1', 'f1']);
  });

  it('discards stale generations when a newer search starts', async () => {
    const mixer = new SearchMixer({ debounceMs: 0 });
    mixer.register(
      provider(
        'files',
        [{ id: 'slow', source: 'files', title: 'slow', score: 1 }],
        40,
      ),
    );

    const seen: number[] = [];
    const gen1 = mixer.search({ text: 'a', limit: 5 }, (r) => {
      seen.push(r.generation);
    });
    const gen2 = mixer.search({ text: 'b', limit: 5 }, (r) => {
      seen.push(r.generation);
    });
    expect(gen2).toBeGreaterThan(gen1);

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(seen.every((g) => g === gen2)).toBe(true);
  });

  it('substringScore prefers prefix matches', () => {
    expect(substringScore('mission-alpha', 'mission')).toBeGreaterThan(
      substringScore('x-mission', 'mission'),
    );
    expect(substringScore('abc', 'zzz')).toBe(0);
  });
});
