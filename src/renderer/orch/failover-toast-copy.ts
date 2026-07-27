import type {
  FailoverEvent,
  FailoverReasonKind,
} from '../../shared/account-types';

export interface FailoverToastCopy {
  readonly title: string;
  readonly detail: string;
}

function effectiveKind(event: FailoverEvent): FailoverReasonKind {
  return event.kind ?? 'rate-limit';
}

export function blockedFailoverToastCopy(
  event: FailoverEvent,
): FailoverToastCopy {
  const retryNote = event.scheduledRetryAtMs
    ? ` Nova tentativa automática às ${new Date(
        event.scheduledRetryAtMs,
      ).toLocaleTimeString()}.`
    : '';

  switch (effectiveKind(event)) {
    case 'auth':
      return {
        title: `Sessão expirada em "${event.fromAccountLabel}"`,
        detail:
          `${event.reason}. Nenhuma credencial alternativa está pronta. ` +
          `Entre novamente em Configurações → Providers.${retryNote}`,
      };
    case 'quota':
      return {
        title: `Cota esgotada em "${event.fromAccountLabel}"`,
        detail:
          `${event.reason}. Nenhuma outra conta está disponível agora. ` +
          `Você pode conectar outra em Configurações → Providers.${retryNote}`,
      };
    case 'transient':
      return {
        title: `Provider indisponível em "${event.fromAccountLabel}"`,
        detail:
          `${event.reason}. O Nexus preservou a missão e tentará novamente ` +
          `quando o provider estiver disponível.${retryNote}`,
      };
    case 'rate-limit':
      return {
        title: `Limite temporário em "${event.fromAccountLabel}"`,
        detail:
          `${event.reason}. Nenhuma outra conta está disponível agora.${retryNote}`,
      };
  }
}
