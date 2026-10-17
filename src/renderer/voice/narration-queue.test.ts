import { describe, expect, it, vi } from 'vitest';
import type { SpeakResult } from '../../shared/voice-ipc';
import {
  NarrationQueue,
  canStartNarration,
  createNarrationPlayer,
  narrationStillOwnsVoice,
  type NarrationPlayerDeps,
  type NarrationVoiceState,
} from './narration-queue';
import {
  STATUS_STUCK_DEADLINES_MS,
  speakingHasAudioProgress,
  statusWatchdogAction,
} from './status-watchdog';

const freeVoice: NarrationVoiceState = {
  status: 'idle',
  turnToken: 7,
  turnBusy: false,
  wakeOpening: false,
  listening: false,
  realtimeTurnActive: false,
  liveAudioPending: false,
  localAudioAudible: false,
  halted: false,
};

async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Deixa a cadeia de promessas do drain correr até o fim (nenhum timer envolvido). */
async function flush(): Promise<void> {
  await settle(30);
}

describe('NarrationQueue', () => {
  it('retains report-back while voice is busy and drains when idle', async () => {
    let idle = false;
    const play = vi.fn(async () => {});
    const queue = new NarrationQueue({ canPlay: () => idle, play });

    queue.enqueue('Worker terminou os testes.');
    await settle();
    expect(play).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);

    idle = true;
    queue.kick();
    await settle();
    expect(play).toHaveBeenCalledWith('Worker terminou os testes.');
    expect(queue.size).toBe(0);
  });

  it('serializes messages and ignores an adjacent duplicate', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const played: string[] = [];
    const queue = new NarrationQueue({
      canPlay: () => true,
      play: async (text) => {
        played.push(text);
        if (played.length === 1) await first;
      },
    });

    queue.enqueue('primeiro');
    queue.enqueue('primeiro');
    queue.enqueue('segundo');
    queue.enqueue('segundo');
    await settle();
    expect(played).toEqual(['primeiro']);
    // A duplicated IPC event arriving while the first narration is playing
    // must not enqueue the same audio a second time.
    queue.enqueue('primeiro');
    releaseFirst();
    await settle();
    await settle();
    expect(played).toEqual(['primeiro', 'segundo']);
  });

  it('continues after one narration fails', async () => {
    const onError = vi.fn();
    const play = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('tts unavailable'))
      .mockResolvedValue(undefined);
    const queue = new NarrationQueue({ canPlay: () => true, play, onError });

    queue.enqueue('um');
    queue.enqueue('dois');
    await settle();
    await settle();

    expect(play).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('F-1545 narration vs wake', () => {
  it('does not start while handleWake passes through idle with the turn busy', () => {
    expect(canStartNarration(freeVoice)).toBe(true);
    // handleWake: busy=true + setStatus('idle') antes de a captura abrir.
    expect(canStartNarration({ ...freeVoice, turnBusy: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, wakeOpening: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, listening: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, realtimeTurnActive: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, liveAudioPending: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, localAudioAudible: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, halted: true })).toBe(false);
  });

  it('requeues a narration to the front instead of losing it', async () => {
    let free = true;
    const played: string[] = [];
    const queue = new NarrationQueue({
      canPlay: () => free,
      play: async (text) => {
        played.push(text);
        if (played.length === 1) {
          free = false; // wake abriu durante a síntese
          queue.requeue(text);
        }
      },
    });

    queue.enqueue('primeiro relato');
    queue.enqueue('segundo relato');
    await settle();
    await settle();
    expect(played).toEqual(['primeiro relato']);
    expect(queue.size).toBe(2);

    free = true;
    queue.kick();
    await settle();
    await settle();
    await settle();
    expect(played).toEqual(['primeiro relato', 'primeiro relato', 'segundo relato']);
    expect(queue.size).toBe(0);
  });
});

describe('narrationStillOwnsVoice (posse sem depender do status do HUD)', () => {
  const START = freeVoice.turnToken;

  it('o HUD voltar a idle/speaking sozinho NÃO tira a voz do relato', () => {
    // watchdog de status preso, evento `dormant` do Live, qualquer blip do HUD:
    for (const status of ['idle', 'speaking', 'error']) {
      expect(narrationStillOwnsVoice({ ...freeVoice, status }, START)).toBe(true);
    }
  });

  it('um turno aberto durante a síntese (token novo) tira a voz, seja qual for o status', () => {
    // wake/PTT/ditado/clique abrem o turno via turnExecution.beginTurn().
    for (const status of ['idle', 'speaking', 'listening']) {
      expect(narrationStillOwnsVoice({ ...freeVoice, status, turnToken: START + 1 }, START)).toBe(
        false,
      );
    }
  });

  it('turno em voo, wake abrindo, captura, Live ou áudio local tiram a voz', () => {
    expect(narrationStillOwnsVoice({ ...freeVoice, turnBusy: true }, START)).toBe(false);
    expect(narrationStillOwnsVoice({ ...freeVoice, wakeOpening: true }, START)).toBe(false);
    expect(narrationStillOwnsVoice({ ...freeVoice, listening: true }, START)).toBe(false);
    expect(narrationStillOwnsVoice({ ...freeVoice, realtimeTurnActive: true }, START)).toBe(false);
    expect(narrationStillOwnsVoice({ ...freeVoice, liveAudioPending: true }, START)).toBe(false);
    expect(narrationStillOwnsVoice({ ...freeVoice, halted: true }, START)).toBe(false);
    expect(narrationStillOwnsVoice(freeVoice, START, true)).toBe(false);
  });
});

describe('NarrationQueue — limite de tentativas', () => {
  it('desiste do relato depois de maxAttempts devoluções em vez de sintetizar em laço', async () => {
    const onDrop = vi.fn();
    let plays = 0;
    const queue: NarrationQueue = new NarrationQueue({
      canPlay: () => plays < 50, // trava de segurança do teste: sem o limite o laço iria a 50
      maxAttempts: 3,
      onDrop,
      play: async (text) => {
        plays += 1;
        queue.requeue(text); // a voz é tomada em TODA tentativa
      },
    });

    queue.enqueue('relato que nunca consegue falar');
    await flush();

    expect(plays).toBe(3);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('relato que nunca consegue falar', 3);
    expect(queue.size).toBe(0);
  });

  it('o padrão são 3 tentativas e o limite vale por relato, sem travar os outros', async () => {
    const played: string[] = [];
    const onDrop = vi.fn();
    const queue: NarrationQueue = new NarrationQueue({
      canPlay: () => played.length < 50,
      onDrop,
      play: async (text) => {
        played.push(text);
        if (text === 'teimoso') queue.requeue(text);
      },
    });

    queue.enqueue('teimoso');
    queue.enqueue('normal');
    await flush();

    expect(played.filter((t) => t === 'teimoso')).toHaveLength(3);
    expect(played).toContain('normal'); // o relato seguinte falou
    expect(onDrop).toHaveBeenCalledWith('teimoso', 3);
    expect(queue.size).toBe(0);
  });

  it('um relato que falou à segunda tentativa zera a contagem para a próxima vez', async () => {
    const onDrop = vi.fn();
    let plays = 0;
    const queue: NarrationQueue = new NarrationQueue({
      canPlay: () => plays < 50,
      maxAttempts: 2,
      onDrop,
      play: async (text) => {
        plays += 1;
        if (plays === 1) queue.requeue(text); // 1ª tentativa: voz tomada; 2ª: fala
      },
    });

    queue.enqueue('mesmo texto');
    await flush();
    expect(plays).toBe(2);
    expect(onDrop).not.toHaveBeenCalled();

    // O mesmo texto chegando de novo (outro handoff) começa do zero.
    plays = 0;
    queue.enqueue('mesmo texto');
    await flush();
    expect(plays).toBe(2);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('clear() esquece as tentativas: o relato volta a ter o limite inteiro', async () => {
    let plays = 0;
    let free = true;
    const onDrop = vi.fn();
    const queue: NarrationQueue = new NarrationQueue({
      canPlay: () => free && plays < 50,
      maxAttempts: 2,
      onDrop,
      play: async (text) => {
        plays += 1;
        free = false; // a voz foi tomada: o drain pára depois desta tentativa
        queue.requeue(text);
      },
    });
    const retry = async () => {
      free = true;
      queue.kick();
      await flush();
    };

    queue.enqueue('relato');
    await flush();
    expect(plays).toBe(1); // tentativa 1 de 2

    queue.clear(); // power-off / halt: some o relato e a contagem dele
    queue.enqueue('relato'); // chega de novo: conta como tentativa 1
    await retry();
    expect(plays).toBe(2); // tentativa 1 de 2 (sem o clear seria a 2 de 2)
    await retry();
    expect(plays).toBe(3); // tentativa 2 de 2: ainda permitida
    expect(onDrop).not.toHaveBeenCalled();
    await retry(); // a 3ª já excede o limite: descartada
    expect(plays).toBe(3);
    expect(onDrop).toHaveBeenCalledWith('relato', 2);
    expect(queue.size).toBe(0);
  });

  it('uma síntese que falha não é re-tentada nem conta como devolução', async () => {
    const play = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('timeout'));
    const onError = vi.fn();
    const onDrop = vi.fn();
    const queue = new NarrationQueue({ canPlay: () => true, play, onError, onDrop });

    queue.enqueue('relato');
    await flush();

    expect(play).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });
});

describe('createNarrationPlayer — TTS lenta com o HUD voltando a idle', () => {
  const audio: SpeakResult = {
    ok: true,
    provider: 'gemini',
    mode: 'audio',
    format: 'wav',
    audioBase64: 'AAAA',
  };

  /** Mundo falso do controller: status do HUD, token do turno, flag da síntese. */
  function world(overrides: Partial<NarrationVoiceState> = {}) {
    const w = {
      status: 'idle' as string,
      turnToken: 7,
      synthesizing: false,
      synthesizingDuringSpeak: [] as boolean[],
      synthCalls: 0,
      played: [] as string[],
      statuses: [] as string[],
      requeued: [] as string[],
      deferred: 0,
      stopped: 0,
      muted: false,
      halted: false,
      extra: overrides,
    };
    return w;
  }

  function depsFor(
    w: ReturnType<typeof world>,
    synthesize: (text: string) => Promise<SpeakResult>,
    queue?: () => NarrationQueue,
  ): NarrationPlayerDeps {
    return {
      isMuted: () => w.muted,
      isHalted: () => w.halted,
      voiceState: () => ({
        ...freeVoice,
        status: w.status,
        turnToken: w.turnToken,
        ...w.extra,
      }),
      setStatus: (status) => {
        w.status = status;
        w.statuses.push(status);
      },
      stopPlayback: () => {
        w.stopped += 1;
      },
      synthesize: async (text) => {
        w.synthCalls += 1;
        w.synthesizingDuringSpeak.push(w.synthesizing);
        return synthesize(text);
      },
      playAudio: async () => {
        w.played.push(`status=${w.status}`);
      },
      setSynthesizing: (active) => {
        w.synthesizing = active;
      },
      requeue: (text) => {
        w.requeued.push(text);
        queue?.().requeue(text);
      },
      onDeferred: () => {
        w.deferred += 1;
      },
    };
  }

  it('o HUD voltar a idle SEM takeover (watchdog, Live dormant) não re-sintetiza: fala uma vez', async () => {
    const w = world();
    const play = createNarrationPlayer(
      depsFor(w, async () => {
        w.status = 'idle'; // o watchdog (ou um `dormant` do Live) zerou o HUD no meio da síntese
        return audio;
      }),
    );

    await play('Worker terminou os testes.');

    expect(w.synthCalls).toBe(1);
    expect(w.requeued).toEqual([]);
    // O áudio tocou com o HUD de volta em `speaking`, e fecha em idle.
    expect(w.played).toEqual(['status=speaking']);
    expect(w.status).toBe('idle');
  });

  it('um wake que abriu o turno durante a síntese ganha a voz: o relato volta à fila e não toca', async () => {
    const w = world();
    const play = createNarrationPlayer(
      depsFor(w, async () => {
        w.turnToken += 1; // handleWake → beginListening → turnExecution.beginTurn()
        w.status = 'listening';
        return audio;
      }),
    );

    await play('relato');

    expect(w.requeued).toEqual(['relato']);
    expect(w.deferred).toBe(1);
    expect(w.played).toEqual([]);
    // Não derruba o HUD do turno que assumiu: só restaura idle quando ainda era dele.
    expect(w.status).toBe('listening');
  });

  it('sinais de turno ativos no fim da síntese (wake abrindo, captura) também adiam o relato', async () => {
    for (const extra of [{ turnBusy: true }, { wakeOpening: true }, { listening: true }]) {
      const w = world(extra);
      const play = createNarrationPlayer(depsFor(w, async () => audio));
      await play('relato');
      expect(w.requeued).toEqual(['relato']);
      expect(w.played).toEqual([]);
    }
  });

  it('a flag de síntese cobre exatamente a chamada do TTS, inclusive quando ela falha', async () => {
    const w = world();
    const play = createNarrationPlayer(depsFor(w, async () => audio));
    await play('relato');
    expect(w.synthesizingDuringSpeak).toEqual([true]); // ligada durante a síntese
    expect(w.synthesizing).toBe(false); // desligada depois

    const failing = world();
    const playFailing = createNarrationPlayer(
      depsFor(failing, async () => {
        throw new Error('TTS do relato demorou demais (40s)');
      }),
    );
    await expect(playFailing('relato')).rejects.toThrow('demorou demais');
    expect(failing.synthesizing).toBe(false); // o deadline da síntese solta o watchdog
    expect(failing.status).toBe('idle'); // e o HUD não fica preso em speaking
    expect(failing.requeued).toEqual([]);
  });

  it('mudo ou desligado: não sintetiza nem mexe no HUD', async () => {
    for (const patch of [{ muted: true }, { halted: true }]) {
      const w = world();
      Object.assign(w, patch);
      const play = createNarrationPlayer(depsFor(w, async () => audio));
      await play('relato');
      expect(w.synthCalls).toBe(0);
      expect(w.statuses).toEqual([]);
    }
  });

  it('mudar para mudo/desligado DURANTE a síntese descarta o áudio sem requeue', async () => {
    const w = world();
    const play = createNarrationPlayer(
      depsFor(w, async () => {
        w.muted = true;
        return audio;
      }),
    );
    await play('relato');
    expect(w.played).toEqual([]);
    expect(w.requeued).toEqual([]);
    expect(w.status).toBe('idle');
  });

  it('resposta sem áudio (silent/falha) não toca nada e devolve o HUD a idle', async () => {
    const w = world();
    const play = createNarrationPlayer(
      depsFor(w, async () => ({ ok: false, error: 'sem voz' })),
    );
    await play('relato');
    expect(w.played).toEqual([]);
    expect(w.status).toBe('idle');
  });

  it('LAÇO: TTS lenta + watchdog forçando idle a cada tentativa termina com UMA síntese e o relato falado', async () => {
    // Reprodução do defeito: status `speaking` sem áudio audível por >6 s fazia o
    // watchdog forçar idle; o relato voltava à fila e era sintetizado de novo,
    // sem nunca falar. Aqui o "watchdog" roda DENTRO de cada síntese, como no app.
    const w = world();
    const synthesizingAtTick: boolean[] = [];
    const queue: NarrationQueue = new NarrationQueue({
      canPlay: () => w.status === 'idle' && w.synthCalls < 20, // trava de segurança do teste
      play: createNarrationPlayer(
        depsFor(
          w,
          async () => {
            // tick do watchdog aos ~10 s de síntese: com o sinal de progresso, não dispara.
            synthesizingAtTick.push(w.synthesizing);
            const progress = speakingHasAudioProgress({
              liveRemainingMs: 0,
              pendingLiveChunks: 0,
              localAudioAudible: false,
              narrationSynthesizing: w.synthesizing,
            });
            const stuckMs = STATUS_STUCK_DEADLINES_MS.speaking! + 4_000;
            if (!progress && statusWatchdogAction('speaking', stuckMs) === 'force-idle') {
              w.status = 'idle';
              w.turnToken += 1; // o watchdog também invalida o turno (beginTurn)
            }
            return audio;
          },
          () => queue,
        ),
      ),
    });

    queue.enqueue('Worker terminou os testes.');
    await flush();

    expect(w.synthCalls).toBe(1); // antes: 20 (preso no laço até a trava do teste)
    expect(w.played).toEqual(['status=speaking']);
    expect(synthesizingAtTick).toEqual([true]);
    expect(queue.size).toBe(0);
  });

  it('LAÇO residual: se algo tomar a voz em TODA tentativa, para em maxAttempts sínteses', async () => {
    const w = world();
    const onDrop = vi.fn();
    const queue: NarrationQueue = new NarrationQueue({
      canPlay: () => w.synthCalls < 20,
      maxAttempts: 3,
      onDrop,
      play: createNarrationPlayer(
        depsFor(
          w,
          async () => {
            w.turnToken += 1; // takeover em toda síntese (pior caso)
            return audio;
          },
          () => queue,
        ),
      ),
    });

    queue.enqueue('relato');
    await flush();

    expect(w.synthCalls).toBe(3); // 3 chamadas de TTS no pior caso, não uma por tick
    expect(onDrop).toHaveBeenCalledWith('relato', 3);
    expect(w.played).toEqual([]);
    expect(queue.size).toBe(0);
  });
});
