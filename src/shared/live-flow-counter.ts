/**
 * Contador throttled para observabilidade do fluxo de áudio realtime — puro e
 * testável. O pipeline de voz tinha um ponto CEGO fatal: mic→socket,
 * socket→áudio e áudio→alto-falante não emitiam NADA no voice.log, então uma
 * sessão realtime MUDA (engaja o socket e não responde) era indistinguível de
 * uma saudável. Este contador registra (com throttle) quantos frames de mic
 * subiram, quantos eventos/chunks o servidor mandou e quantos chunks tocaram —
 * por SESSÃO. Um mute agora deixa rastro: micFramesSent>0 mas serverAudio=0
 * (socket surdo) ou serverAudio>0 mas played=0 (áudio retido/suprimido).
 *
 * Throttle duplo (a cada N ticks OU a cada M ms) para não inundar o log num
 * stream de 16 kHz mas ainda provar movimento em tempo real.
 */

export interface CounterTick {
  /** true quando esta chamada deve emitir uma linha de log (passou o throttle). */
  readonly fire: boolean;
  /** total acumulado de ticks nesta sessão. */
  readonly count: number;
}

export class ThrottledCounter {
  private count = 0;
  private lastLoggedCount = 0;
  private lastLoggedAt = 0;
  private started = false;

  constructor(
    private readonly everyN: number,
    private readonly everyMs: number,
  ) {}

  /** Registra um evento; devolve se deve logar agora + o total. */
  tick(now: number): CounterTick {
    this.count += 1;
    // O PRIMEIRO tick de uma sessão sempre dispara — prova imediata de fluxo.
    const first = !this.started;
    this.started = true;
    const dueByN = this.count - this.lastLoggedCount >= this.everyN;
    const dueByMs = now - this.lastLoggedAt >= this.everyMs;
    if (first || dueByN || dueByMs) {
      this.lastLoggedCount = this.count;
      this.lastLoggedAt = now;
      return { fire: true, count: this.count };
    }
    return { fire: false, count: this.count };
  }

  get total(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
    this.lastLoggedCount = 0;
    this.lastLoggedAt = 0;
    this.started = false;
  }
}
