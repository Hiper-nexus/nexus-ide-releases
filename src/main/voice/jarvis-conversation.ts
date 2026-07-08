import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JarvisTurn } from '../../shared/voice-ipc';

/**
 * Persistência da CONVERSA da JARVIS entre mortes de sessão (Gap 9).
 *
 * O histórico de turnos vive só no renderer (jarvisHistory) e morre quando a
 * janela fecha/reinicia — ao voltar, a JARVIS recomeça do zero e re-pergunta o
 * que já sabia. Aqui o par (usuário → resposta) de cada turno é gravado em
 * disco; ao reabrir DENTRO da janela de resume (RESUME_WINDOW_MS), os últimos
 * turnos são reinjetados no prompt do cérebro como `[reconexão]`, então o
 * modelo retoma o fio em vez de reiniciar. Fora da janela, começa limpo.
 *
 * Espelha o padrão de persistência do JarvisMemory (filePath + nowFn injetáveis,
 * sem import de electron) para ser unit-testável. Sem segredos — só a conversa.
 */

export const CONVERSATION_MAX_MESSAGES = 40; // paridade com LIVE_HISTORY_MAX do Overclock
export const RESUME_WINDOW_MS = 5 * 60_000; // 5 min (paridade com RESUME_WINDOW_MS)
export const RESUME_INJECT_MESSAGES = 6; // últimos ~3 pares reinjetados

interface ConversationState {
  turns: JarvisTurn[];
  updatedAt: number;
}

export class JarvisConversation {
  private state: ConversationState | null = null;

  constructor(
    private filePath: string = path.join(os.homedir(), '.nexus', 'jarvis-conversation.json'),
    private nowFn: () => number = Date.now,
  ) {}

  /** Grava o par do turno atual. Ignora quando algum lado está vazio. */
  record(userText: string, assistantText: string): void {
    const user = userText.trim();
    const assistant = assistantText.trim();
    if (!user || !assistant) return;
    const state = this.load();
    state.turns.push({ role: 'user', content: user });
    state.turns.push({ role: 'assistant', content: assistant });
    if (state.turns.length > CONVERSATION_MAX_MESSAGES) {
      state.turns = state.turns.slice(-CONVERSATION_MAX_MESSAGES);
    }
    state.updatedAt = this.nowFn();
    this.save(state);
  }

  /**
   * Turnos a reinjetar num resume: os últimos RESUME_INJECT_MESSAGES, mas SÓ se
   * a conversa é fresca (dentro da janela). Fora dela → [] (começa limpo).
   */
  resume(): JarvisTurn[] {
    const state = this.load();
    if (state.turns.length === 0) return [];
    if (this.nowFn() - state.updatedAt > RESUME_WINDOW_MS) return [];
    return state.turns.slice(-RESUME_INJECT_MESSAGES);
  }

  /** Zera a conversa persistida (ex.: usuário pede "esquece o que falamos"). */
  clear(): void {
    this.save({ turns: [], updatedAt: this.nowFn() });
  }

  // ── persistência ────────────────────────────────────────────────────────────

  private load(): ConversationState {
    if (this.state) return this.state;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ConversationState>;
      this.state = Array.isArray(parsed?.turns)
        ? { turns: parsed.turns as JarvisTurn[], updatedAt: Number(parsed.updatedAt) || 0 }
        : { turns: [], updatedAt: 0 };
    } catch {
      this.state = { turns: [], updatedAt: 0 };
    }
    return this.state;
  }

  private save(state: ConversationState): void {
    this.state = state;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Best-effort: a persistência é conveniência, nunca derruba o turno de voz.
    }
  }
}

/** Singleton do processo main. */
export const jarvisConversation = new JarvisConversation();
