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
  version: '0.7.0',
  date: '2026-07-06',
  codename: 'Squad CLI sync',
  summary:
    'Release focada em deixar squads, providers e contas previsíveis: AGY assume o lugar do Gemini CLI nos defaults, workers são distribuídos entre CLIs instaladas e contas salvas passam a sincronizar de verdade antes do spawn.',
  highlights: [
    {
      title: 'AGY no lugar do Gemini CLI',
      detail:
        'O adapter Gemini foi removido dos built-ins. Squads, roteamento e remote spawn agora usam AGY como padrão compatível.',
    },
    {
      title: 'Squads mais equilibrados',
      detail:
        'O orquestrador permanece no Claude e os workers são distribuídos entre as CLIs instaladas para evitar tudo concentrado em um só provider.',
    },
    {
      title: 'Providers hands-free por padrão',
      detail:
        'Permissões passam a iniciar em YOLO quando a CLI suporta, ou Bypass quando esse for o modo disponível. O cliente ainda pode voltar para o default da CLI.',
    },
    {
      title: 'Contas sincronizadas',
      detail:
        'Conta nova vira ativa imediatamente. Ao usar uma conta Claude por assinatura, a credencial salva é restaurada no Keychain antes de marcar como em uso.',
    },
    {
      title: 'UI de contas mais clara',
      detail:
        'A tela mostra login local, conta em uso, credencial ausente, cooldown e botão para sincronizar a conta ativa antes de abrir novos terminais.',
    },
    {
      title: 'Auth local preservado nos workers',
      detail:
        'Codex, AGY, Kimi e Grok agora mantêm o HOME real do Mac nos panes orquestrados, então usam as contas já autenticadas em vez de pedir login de novo.',
    },
    {
      title: 'Skills reais por CLI',
      detail:
        'O Nexus espelha skills instaladas para Claude, Codex, AGY, Kimi e Grok no spawn e cria a skill ponytail a partir da regra interna, respeitando allowedSkills quando houver allowlist explícita.',
    },
  ],
  fixes: [
    {
      title: 'AGY não cai mais no help com code 2',
      detail:
        'O modo hands-free do AGY passou de --yolo para --dangerously-skip-permissions, que é a flag aceita pela CLI instalada.',
    },
    {
      title: 'Sem sobreposição no review de squad',
      detail:
        'O layout do passo Revisar foi reorganizado com identidade e controles separados, evitando texto por cima dos selects.',
    },
    {
      title: 'Compatibilidade de squads antigos',
      detail:
        'providerId gemini-cli em arquivos antigos passa a ser normalizado para agy quando o cli não está explícito.',
    },
  ],
};
