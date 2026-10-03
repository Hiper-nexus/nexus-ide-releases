import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { QUESTION_POLL_MS } from '../jarvis/realtime/pending-question-router';

export interface NarratedQuestion {
  paneId: string;
  questionHash: string;
}

export interface PendingQuestionSource {
  poll(): NarratedQuestion[];
}

export class LiveQuestionPoller {
  private readonly taskId = `voice-live-question:${randomUUID()}`;
  private stopped = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private registeredQuestions = new Set<string>();

  constructor(
    private readonly source: PendingQuestionSource | undefined,
    private readonly onQuestion: (question: NarratedQuestion) => void,
  ) {}

  start(): void {
    if (!this.source || this.timer) return;
    this.stopped = false;
    const tick = (): void => { void runPeriodicTask(this.taskId, async ctx => {
      for (const question of this.source?.poll() ?? []) {
        if (this.stopped) return;
        await ctx.checkpoint();
        if (this.stopped) return;
        const key = `${question.paneId}::${question.questionHash}`;
        if (this.registeredQuestions.has(key)) continue;
        if (this.registeredQuestions.size >= 4096) this.registeredQuestions.delete(this.registeredQuestions.values().next().value!);
        this.registeredQuestions.add(key);
        this.onQuestion(question);
      }
    }, { cadenceMs: QUESTION_POLL_MS, timeoutMs: QUESTION_POLL_MS }).catch(() => undefined); };
    tick();
    this.timer = setInterval(tick, QUESTION_POLL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await stopPeriodicTask(this.taskId);
    this.registeredQuestions.clear();
  }
}
