import { QUESTION_POLL_MS } from '../jarvis/realtime/pending-question-router';

export interface NarratedQuestion {
  paneId: string;
  questionHash: string;
}

export interface PendingQuestionSource {
  poll(): NarratedQuestion[];
}

export class LiveQuestionPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private registeredQuestions = new Set<string>();

  constructor(
    private readonly source: PendingQuestionSource | undefined,
    private readonly onQuestion: (question: NarratedQuestion) => void,
  ) {}

  start(): void {
    if (!this.source || this.timer) return;
    const tick = (): void => {
      for (const question of this.source?.poll() ?? []) {
        const key = `${question.paneId}::${question.questionHash}`;
        if (this.registeredQuestions.has(key)) continue;
        this.registeredQuestions.add(key);
        this.onQuestion(question);
      }
    };
    tick();
    this.timer = setInterval(tick, QUESTION_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.registeredQuestions.clear();
  }
}
