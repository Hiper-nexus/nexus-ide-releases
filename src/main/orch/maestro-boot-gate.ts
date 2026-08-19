/**
 * Gate do kickoff do Maestro — first-run / OAuth não pode virar "running"
 * com recibo de kickoff aceito (fake-run).
 *
 * Pure helpers: a Via Rápida lê o tail do PTY depois do boot e só grava
 * kickoff quando o briefing foi consumido e a tela não é auth/onboarding.
 */

/** Telas de auth/login que pedem humano — nunca auto-aceitar. */
const AUTH_STALL_PATTERNS: ReadonlyArray<{
  readonly re: RegExp;
  readonly reason: string;
}> = [
  {
    re: /paste code here if prompted/i,
    reason:
      'Claude pediu código OAuth (Paste code here). Faça `claude auth login` ' +
      'no terminal do host (mesmo HOME) e reinicie a missão.',
  },
  {
    re: /select login method/i,
    reason:
      'Claude está no menu de login. Autentique com `claude auth login` e ' +
      'reinicie a missão.',
  },
  {
    re: /sign in with chatgpt/i,
    reason:
      'Codex pediu login ChatGPT. Faça `codex login` e reinicie a missão.',
  },
  {
    re: /sign in with google/i,
    reason:
      'O CLI pediu login Google. Conclua a autenticação e reinicie a missão.',
  },
  {
    re: /login required/i,
    reason: 'O CLI exige login antes de trabalhar. Autentique e reinicie a missão.',
  },
  {
    re: /waiting for (authentication|login)/i,
    reason:
      'O CLI está aguardando autenticação. Conclua o login e reinicie a missão.',
  },
  {
    re: /press enter to log ?in/i,
    reason:
      'O CLI pediu Enter para login interativo. Autentique fora da missão e ' +
      'reinicie.',
  },
];

/** First-run / onboarding ainda na tela (não é turno de missão). */
const ONBOARDING_HOLD_PATTERNS: ReadonlyArray<RegExp> = [
  /choose the text style that looks best with your terminal/i,
  /claude code running in bypass permissions mode/i,
  /do you trust the files in this folder\?/i,
  /quick safety check: is this a project you created or one you trust\?/i,
  /do you trust the contents of this directory\?/i,
];

/**
 * Se o tail do PTY ainda é auth/OAuth, devolve motivo humano; senão null.
 */
export function detectMaestroAuthStall(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  for (const pattern of AUTH_STALL_PATTERNS) {
    if (pattern.re.test(text)) return pattern.reason;
  }
  return null;
}

/**
 * True enquanto first-run (tema, trust, bypass) ainda ocupa o TUI — o
 * briefing no argv não foi consumido como turno.
 */
export function isMaestroOnboardingHold(output: string): boolean {
  const text = output.trim();
  if (!text) return false;
  return ONBOARDING_HOLD_PATTERNS.some((re) => re.test(text));
}

/**
 * Motivo para NÃO gravar kickoff ainda: auth stall (bloqueio) ou onboarding
 * hold (esperar autoresponder / fail se persistir).
 */
export function maestroKickoffBlockReason(output: string): {
  readonly kind: 'auth' | 'onboarding';
  readonly reason: string;
} | null {
  const auth = detectMaestroAuthStall(output);
  if (auth) return { kind: 'auth', reason: auth };
  if (isMaestroOnboardingHold(output)) {
    return {
      kind: 'onboarding',
      reason:
        'Maestro ainda no first-run (tema/trust/bypass). O briefing não foi ' +
        'consumido — kickoff não aceito.',
    };
  }
  return null;
}
