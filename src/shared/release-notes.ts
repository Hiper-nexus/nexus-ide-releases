export interface ReleaseNote {
  title: string;
  detail: string;
}

export interface AppRelease {
  version: string;
  date: string;
  codename: string;
  summary: string;
  highlights: ReleaseNote[];
  fixes: ReleaseNote[];
}

export const CURRENT_RELEASE: AppRelease = {
  version: '0.13.6',
  date: '2026-07-11',
  codename: 'Realtime Continuity',
  summary:
    'Jarvis realtime de verdade: wake por voz (VAD→STT), full-duplex, follow-up sem re-dizer o nome, gate anti-alucinação de TV/ambiente, e rescue de comandos na sessão Live quente.',
  highlights: [
    {
      title: 'Wake por voz operacional',
      detail:
        'VAD passivo com hangover + force-emit de fala real; matcher Overclock (acorda Jarvis); threshold acústico PT-calibrado. Clique deixa de ser o único caminho.',
    },
    {
      title: 'Realtime full-duplex',
      detail:
        'Mic aberto enquanto ela fala (Gemini barge-in). Follow-up reabre escuta sem matar o stream. STT local resgata comando se o provider perder o final.',
    },
    {
      title: 'Anti-alucinação (hot session)',
      detail:
        'Comandos na sessão quente exigem energia de fala + cues de comando; TV/música/STT lixo não disparam tools. Prompt Live alinhado às leis Overclock.',
    },
  ],
  fixes: [
    {
      title: 'liveInterrupt sem owner',
      detail: 'Wake não quebra com "voice live session has no owner".',
    },
    {
      title: 'Tool follow-up em turno stale',
      detail: 'Resultado de tool reabre continuidade na sessão quente.',
    },
    {
      title: 'Boot Keychain',
      detail: 'getInfo não decripta o vault inteiro; mic sobe sem travar SecItem.',
    },
  ],
};
