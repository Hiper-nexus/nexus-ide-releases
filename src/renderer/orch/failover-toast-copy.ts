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
      // Dois momentos do mesmo episódio (failover.ts, handleTransientHit):
      // o aviso inicial e, num pane do operador, "a CLI parou" — o texto só
      // promete o que o Main de fato faz em cada caso.
      if (/a CLI parou/.test(event.reason)) {
        return {
          title: 'A CLI parou num erro do provider',
          detail: `${event.reason}.`,
        };
      }
      return {
        title: 'Provider instável — conta mantida',
        detail:
          `${event.reason}. É um erro do provider, não limite da conta ` +
          `"${event.fromAccountLabel}": trocar de conta não resolve. A CLI ` +
          `tenta de novo sozinha; ` +
          (event.missionId
            ? 'se ela parar no erro, o Nexus retoma a missão na mesma conta.'
            : 'se ela parar no erro, mande "continue" no pane.'),
      };
    case 'rate-limit':
      return {
        title: `Limite temporário em "${event.fromAccountLabel}"`,
        detail:
          `${event.reason}. Nenhuma outra conta está disponível agora.${retryNote}`,
      };
    case 'model':
      return {
        title: `Modelo rejeitado em "${event.fromAccountLabel}"`,
        detail:
          `${event.reason}. A conta está operacional — atualize a CLI em ` +
          `Configurações → Providers para usar este modelo.`,
      };
  }
}

/**
 * Toast after switched=true same-account respawn. Auth must never claim
 * "Sessão recuperada automaticamente" — the credential is still dead.
 */
export function recoveredFailoverToastCopy(
  event: FailoverEvent,
): FailoverToastCopy {
  if (effectiveKind(event) === 'auth') {
    return {
      title: `Sessão expirada em "${event.fromAccountLabel}"`,
      detail:
        `${event.reason}. Esta conta ainda precisa de login. ` +
        `Abra + Pane com outra conta para continuar a missão, ` +
        `ou entre novamente em Configurações → Providers.`,
    };
  }
  return {
    title: 'Sessão recuperada automaticamente',
    detail: event.reason,
  };
}
