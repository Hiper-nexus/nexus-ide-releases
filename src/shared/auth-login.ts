/**
 * Login Nexus (GitHub/Google) — contrato compartilhado entre Main e renderer.
 * Dependency-free. Toda mensagem aqui é a que a PESSOA lê: nomeia o problema e
 * a saída. Texto vindo do servidor ou de exceção nunca passa daqui para a UI.
 */

export type LoginProvider = 'github' | 'google';

/** Ordem em que a interface oferece os provedores (o primeiro é a ação principal). */
export const LOGIN_PROVIDERS: readonly LoginProvider[] = ['github', 'google'];

/** Janela em que o deep link do navegador ainda completa o login (Main e UI). */
export const LOGIN_PENDING_TTL_MS = 10 * 60 * 1000;

/** O prazo do login esgotou sem o navegador devolver o deep link. */
export const LOGIN_TIMEOUT_MESSAGE =
  'O tempo para concluir o login no navegador acabou. Comece de novo quando puder.';

/** O IPC falhou antes de o Main responder; o texto técnico nunca chega à pessoa. */
export const LOGIN_START_FALLBACK =
  'Não foi possível iniciar o login agora. Tente de novo em instantes.';

const PROVIDER_LABEL: Record<LoginProvider, string> = { github: 'GitHub', google: 'Google' };

export function loginProviderLabel(provider: LoginProvider): string {
  return PROVIDER_LABEL[provider];
}

/** Resultado da checagem prévia do servidor: status HTTP, ou falha de rede. */
export type LoginProbeFailure = { status: number } | { network: true };

export function loginProbeMessage(provider: LoginProvider, failure: LoginProbeFailure): string {
  const name = PROVIDER_LABEL[provider];
  if ('network' in failure) {
    return 'Não consegui falar com o servidor do Nexus. Verifique sua conexão e tente de novo.';
  }
  if (failure.status === 429) {
    return 'Muitas tentativas seguidas. Espere um minuto e tente de novo.';
  }
  if (failure.status >= 500) {
    return `O login com ${name} ainda não está disponível no servidor do Nexus. Tente outro método ou volte mais tarde.`;
  }
  return `O servidor recusou iniciar o login com ${name}. Tente de novo; se continuar, atualize o NexusIDE.`;
}

const EXCHANGE_MESSAGES: Record<string, string> = {
  'nenhum login pendente':
    'Este link de login já foi usado ou expirou. Comece o login de novo.',
  'state não confere com o login pendente':
    'Este link não pertence ao login que você iniciou. Comece o login de novo.',
  'login superseded':
    'Você iniciou outro login depois deste. Conclua o mais recente no navegador.',
  'exchange-network':
    'O navegador voltou, mas não consegui confirmar a conta no servidor. Verifique sua conexão e tente de novo.',
  'exchange-http':
    'O servidor não aceitou o código de login. Comece o login de novo.',
  'exchange-invalid-response':
    'O servidor respondeu algo que o NexusIDE não entendeu. Tente de novo em instantes.',
  'account identity unavailable':
    'Não consegui confirmar a identidade da conta. Tente de novo em instantes.',
  'exchange-license-invalid':
    'A conta entrou, mas a licença recebida não pôde ser validada. Tente entrar de novo.',
  'exchange-storage':
    'Não consegui guardar a sessão no cofre de credenciais do sistema. Libere o acesso do NexusIDE a ele e tente de novo.',
};

/** O login concluiu, mas atualizar a conta/equipe depois falhou. */
export const LOGIN_FINISH_FALLBACK =
  'Você entrou, mas não consegui atualizar seu acesso agora. Tente de novo em instantes.';

/**
 * Rejeições de pré-validação do deep link (link velho, de outro login ou
 * forjado por um site): o login pendente NÃO é consumido, então a espera
 * continua válida e a interface não deve tratá-las como falha do login atual.
 */
const STALE_EXCHANGE_CODES: ReadonlySet<string> = new Set([
  'login superseded',
  'nenhum login pendente',
  'state não confere com o login pendente',
]);

export function isStaleLoginCode(code: string | undefined): boolean {
  return code !== undefined && STALE_EXCHANGE_CODES.has(code);
}

const EXCHANGE_FALLBACK =
  'Não foi possível concluir o login. Comece de novo; se repetir, atualize o NexusIDE.';

export function loginExchangeMessage(code: string | undefined): string {
  // hasOwn: 'constructor'/'toString' herdados do Object não podem virar função no IPC.
  return code !== undefined && Object.hasOwn(EXCHANGE_MESSAGES, code)
    ? EXCHANGE_MESSAGES[code]
    : EXCHANGE_FALLBACK;
}

/** Evento Main → renderer quando o deep link do login termina de ser trocado. */
export interface LoginResultEvent {
  ok: boolean;
  /** Mensagem já pronta para exibir; ausente quando `ok`. */
  error?: string;
  /** Link velho/forjado: a espera do login atual continua valendo. */
  stale?: true;
}
