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
  version: '0.10.0',
  date: '2026-07-06',
  codename: 'Billing, times e operação refinada',
  summary:
    'O NexusIDE agora tem Billing/Team completo de ponta a ponta: checkout e portal via Stripe, webhooks idempotentes, licença assinada no app, times com convites e assentos, além de correções nos pipes, no canvas e no perfil de operador.',
  highlights: [
    {
      title: 'Billing Stripe real',
      detail:
        'Checkout Pro/Team, portal de assinatura, webhook idempotente e espelho local de assinatura agora fecham o ciclo SaaS. O app sincroniza uma licença assinada e nunca fala direto com Stripe.',
    },
    {
      title: 'Times com convites e assentos',
      detail:
        'A tela Minha Conta mostra owner/member, assentos, membros, convite, entrada por código, saída e remoção. O join usa lock transacional para evitar corrida no último assento.',
    },
    {
      title: 'Operação mais previsível',
      detail:
        'Pipes entregam imediatamente ao criar conexão onIdle, o canvas não arrasta quando você está selecionando texto e o perfil de operador ganhou atalho e estado vazio.',
    },
  ],
  fixes: [
    {
      title: 'Checkout Team sem travar usuário',
      detail:
        'Se o pagamento falhar, o checkout Team reutiliza o time pendente do owner e um reaper remove órfãos antigos, evitando 409 sem rota de recuperação.',
    },
    {
      title: 'Grace e webhooks idempotentes',
      detail:
        'A graça de past_due é ancorada na primeira observação e retries do Stripe não estendem acesso indefinidamente. Eventos já processados não rodam de novo.',
    },
    {
      title: 'Checkout inválido bloqueado no app',
      detail:
        'O CTA Team envia nome do time e assentos ao backend, e o plano Free não é mais mapeado por engano para checkout Pro.',
    },
  ],
};
