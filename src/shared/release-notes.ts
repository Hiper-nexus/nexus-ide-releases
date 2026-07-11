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
  version: '0.13.5',
  date: '2026-07-11',
  codename: 'Operator XP Live',
  summary:
    'XP de operador no trabalho diário (agent_turn), FX de tier-up, e hardening de segurança no git panel, URLs e writes atómicos. macOS notarizado; Windows aguarda certificado.',
  highlights: [
    {
      title: 'XP no trabalho real de agente',
      detail:
        'Cada turno Claude/Codex com output real ganha agent_turn (300 pts, com diminishing returns diário) e avança a streak — sem depender só de missão ou voz.',
    },
    {
      title: 'Operator FX',
      detail:
        'Toasts +XP, burst de TIER-UP/TRANSCENDÊNCIA e achievements; HUD com shimmer; reduz motion quando o sistema pede.',
    },
    {
      title: 'Hardening de segurança',
      detail:
        'Git panel seguro (ProcessGitRunner + config local safe), redacção de tokens em URLs, atomic-write com O_EXCL|O_NOFOLLOW, provider-config sem prototype pollution.',
    },
  ],
  fixes: [
    {
      title: 'Preload browser alinhado',
      detail:
        'Allowlist do preload inclui scroll/press/hover para o motor empacotado bater com o main.',
    },
  ],
};
