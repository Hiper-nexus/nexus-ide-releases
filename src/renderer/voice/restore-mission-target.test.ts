import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  missionPickRequestSchema,
  type MissionPickRequest,
  type MissionPickResult,
} from '../../shared/mission-pick';
import {
  MISSION_PICK_CLIENT_TIMEOUT_MS,
  decideRestoreMission,
  requestMissionPick,
  type RestorableMission,
} from './restore-mission-target';

function mission(id: string, title: string, over: Partial<RestorableMission> = {}): RestorableMission {
  return { id, title, state: 'running', updatedAt: 1_700_000_000_000, ...over };
}

const SITE = mission('real-id-1', 'Site da loja');
const SITE_V2 = mission('real-id-2', 'Site da loja v2');
const API = mission('real-id-3', 'API de pagamento');

const picked = (index: number): MissionPickResult => ({ decision: 'picked', index, confidence: 0.9 });
const undecided: MissionPickResult = { decision: 'undecided', reason: 'low-confidence' };

describe('decideRestoreMission', () => {
  it('opens the one obvious mission without asking the Jev', async () => {
    const pick = vi.fn();
    const decision = await decideRestoreMission('site da loja', [SITE_V2, SITE, API], pick);
    expect(decision).toEqual({
      kind: 'open',
      mission: SITE,
      say: 'Abrindo os terminais da missão Site da loja.',
    });
    expect(pick).not.toHaveBeenCalled();
  });

  it('opens the most recent mission when no name was said, without asking the Jev', async () => {
    const pick = vi.fn();
    const decision = await decideRestoreMission(undefined, [API, SITE], pick);
    expect(decision).toMatchObject({ kind: 'open', mission: API });
    expect(pick).not.toHaveBeenCalled();
  });

  it('refuses when nothing matches, listing what exists, and never reaches the Jev', async () => {
    const pick = vi.fn();
    const decision = await decideRestoreMission('banana', [SITE, SITE_V2, API], pick);
    expect(decision).toEqual({
      kind: 'refuse',
      reason: 'none',
      say: 'Não achei nenhuma missão com esse nome. Você tem: Site da loja, Site da loja v2, API de pagamento.',
    });
    expect(pick).not.toHaveBeenCalled();
  });

  it('lists at most five titles when nothing matches and says how many were left out', async () => {
    const many = Array.from({ length: 8 }, (_, i) => mission(`id-${i}`, `Missão ${i + 1}`));
    const decision = await decideRestoreMission('banana', many, vi.fn());
    expect(decision).toMatchObject({ kind: 'refuse', reason: 'none' });
    if (decision.kind !== 'refuse') return;
    expect(decision.say).toBe(
      'Não achei nenhuma missão com esse nome. Você tem: Missão 1, Missão 2, Missão 3, Missão 4, Missão 5 e mais 3.',
    );
  });

  describe('ambiguous', () => {
    it('sends only titles, states and times to the Jev — never a real id', async () => {
      const pick = vi.fn(async (_request: MissionPickRequest) => picked(0));
      await decideRestoreMission('site', [SITE, SITE_V2, API], pick);
      expect(pick).toHaveBeenCalledOnce();
      const request = pick.mock.calls[0]![0];
      expect(request).toEqual({
        spoken: 'site',
        candidates: [
          { title: 'Site da loja', state: 'running', updatedAt: 1_700_000_000_000 },
          { title: 'Site da loja v2', state: 'running', updatedAt: 1_700_000_000_000 },
        ],
      });
      expect(JSON.stringify(request)).not.toContain('real-id');
    });

    it('opens the mission the Jev picked and says who it was', async () => {
      const decision = await decideRestoreMission('site', [SITE, SITE_V2], async () => picked(1));
      expect(decision).toEqual({
        kind: 'open',
        mission: SITE_V2,
        say: 'Abrindo a missão Site da loja v2, a mais parecida com o que você disse.',
      });
    });

    it('opens nothing and asks which one when the Jev did not decide', async () => {
      const decision = await decideRestoreMission('site', [SITE, SITE_V2], async () => undecided);
      expect(decision).toEqual({
        kind: 'refuse',
        reason: 'ambiguous',
        say: 'Achei 2 missões parecidas: Site da loja e Site da loja v2. Qual delas?',
      });
    });

    it('names three titles and the total when more than three match', async () => {
      const lojas = Array.from({ length: 5 }, (_, i) => mission(`id-${i}`, `Loja ${i + 1}`));
      const decision = await decideRestoreMission('loja', lojas, async () => undecided);
      expect(decision).toEqual({
        kind: 'refuse',
        reason: 'ambiguous',
        say: 'Achei 5 missões parecidas, como Loja 1, Loja 2 e Loja 3. Qual delas?',
      });
    });

    it.each([
      ['no answer at all', async () => null],
      ['a rejected call', async () => { throw new Error('ipc down'); }],
      ['an index past the candidates', async () => picked(7)],
      ['a negative index', async () => picked(-1)],
      ['a fractional index', async () => picked(0.5)],
      ['garbage', async () => ({ decision: 'picked' }) as unknown as MissionPickResult],
    ])('treats %s as "no decision": nothing opens and the person is asked', async (_label, pick) => {
      const decision = await decideRestoreMission('site', [SITE, SITE_V2], pick as never);
      expect(decision).toMatchObject({ kind: 'refuse', reason: 'ambiguous' });
    });

    it('builds a request the Main schema accepts, even when titles are made of astral characters', async () => {
      const emojiA = mission('id-a', `Foguete ${'🚀'.repeat(150)} A`);
      const emojiB = mission('id-b', `Foguete ${'🚀'.repeat(150)} B`);
      const pick = vi.fn(async (_request: MissionPickRequest) => undecided);
      await decideRestoreMission('foguete', [emojiA, emojiB], pick);
      const request = pick.mock.calls[0]![0];
      // O limite do schema conta unidades UTF-16; cortar por "caracteres" estouraria.
      expect(missionPickRequestSchema.safeParse(request).success).toBe(true);
    });

    it('clamps long titles for the model and for the voice', async () => {
      const longTitle = 'Refatoração '.repeat(30);
      const a = mission('id-a', `${longTitle}A`);
      const b = mission('id-b', `${longTitle}B`);
      const pick = vi.fn(async (_request: MissionPickRequest) => undecided);
      const decision = await decideRestoreMission('refatoracao', [a, b], pick);
      expect(Array.from(pick.mock.calls[0]![0].candidates[0]!.title).length).toBeLessThanOrEqual(100);
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.say.length).toBeLessThan(260);
    });
  });
});

describe('requestMissionPick', () => {
  const request: MissionPickRequest = {
    spoken: 'site',
    candidates: [
      { title: 'Site da loja', state: 'running' },
      { title: 'Site da loja v2', state: 'running' },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns null when the bridge is missing (older preload, tests)', async () => {
    vi.stubGlobal('window', { nexus: {} });
    expect(await requestMissionPick(request)).toBeNull();
  });

  it('forwards the request and returns the Main answer', async () => {
    const missionPick = vi.fn(async () => picked(1));
    vi.stubGlobal('window', { nexus: { jev: { missionPick } } });
    expect(await requestMissionPick(request)).toEqual(picked(1));
    expect(missionPick).toHaveBeenCalledWith(request);
  });

  it('gives up on a call that never answers, so the voice is not left mute', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { nexus: { jev: { missionPick: () => new Promise(() => {}) } } });
    const pending = requestMissionPick(request);
    await vi.advanceTimersByTimeAsync(MISSION_PICK_CLIENT_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
  });

  it('stops waiting as soon as the turn is cancelled, so the cancellation is not delayed', async () => {
    vi.stubGlobal('window', { nexus: { jev: { missionPick: () => new Promise(() => {}) } } });
    const abort = new AbortController();
    const pending = requestMissionPick(request, abort.signal);
    abort.abort();
    const outcome = await Promise.race([
      pending.then((value) => (value === null ? 'null' : 'value')),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
    ]);
    expect(outcome).toBe('null');
  });

  it('does not even call the bridge when the turn was already cancelled', async () => {
    const missionPick = vi.fn(async () => picked(0));
    vi.stubGlobal('window', { nexus: { jev: { missionPick } } });
    const abort = new AbortController();
    abort.abort();
    expect(await requestMissionPick(request, abort.signal)).toBeNull();
    expect(missionPick).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the call is rejected', async () => {
    vi.stubGlobal('window', { nexus: { jev: { missionPick: async () => { throw new Error('denied'); } } } });
    expect(await requestMissionPick(request)).toBeNull();
  });
});
