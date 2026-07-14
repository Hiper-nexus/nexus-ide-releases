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
  version: '0.15.4',
  date: '2026-07-13',
  codename: 'Jarvis Wake Safety',
  summary:
    'O wake da Jarvis agora preserva somente a fala ligada ao comando e nunca inicia trabalho sem intenção explícita.',
  highlights: [
    {
      title: 'Wake sem contexto ambiente',
      detail:
        'O pre-roll encaminha apenas a fala contígua à palavra de ativação, evitando que televisão ou conversas anteriores virem comando.',
    },
    {
      title: 'Intenção explícita antes da ação',
      detail:
        'Detectar o wake não inicia nem retoma missões; mudanças de estado continuam passando pela rota auditada da Jarvis.',
    },
  ],
  fixes: [
    {
      title: 'Terminal PT-BR seguro',
      detail:
        'Comandos acentuados continuam classificados como shell, enquanto entradas com quebra de linha são bloqueadas antes da confirmação.',
    },
    {
      title: 'Distribuição alinhada',
      detail:
        'Aplicativo, servidor, lockfile, changelog e notas internas apontam para a versão 0.15.4.',
    },
  ],
};
