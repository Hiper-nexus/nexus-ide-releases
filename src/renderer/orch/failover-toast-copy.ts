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
  const retryNote = event.scheduledRetryAtMs && event.scheduledRetryAtMs > Date.now()
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
      // Momentos do mesmo episódio (failover.ts, handleTransientHit), lidos
      // do campo estruturado — nunca do texto de `reason`. A cópia só promete
      // o que o Main de fato faz em cada caso.
      if (event.transientPhase === 'stopped') {
        return {
          title: 'A CLI parou num erro do provider',
          detail: `${event.reason}.`,
        };
      }
      if (event.transientPhase === 'nudged') {
        return {
          title: 'Missão continuou na mesma conta',
          detail: `${event.reason}.`,
        };
      }
      if (event.transientPhase === 'stalled') {
        return {
          title: 'Provider continua instável',
          detail:
            `${event.reason}. É erro do provider, não limite da conta ` +
            `"${event.fromAccountLabel}" — a conta fica como está.`,
        };
      }
      return {
        title: 'Provider instável — conta mantida',
        detail:
          `${event.reason}. É um erro do provider, não limite da conta ` +
          `"${event.fromAccountLabel}": trocar de conta não resolve. A CLI ` +
          `tenta de novo sozinha; ` +
          (event.missionId
            ? 'se ela parar no erro, o Nexus pede para ela continuar, na mesma conta e na mesma conversa.'
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
 * F-765/F-775: o Main reabriu a tarefa em outro pane (outro modelo ou outra
 * CLI) e fechou o pane parado. O toast só conta o que já aconteceu.
 */
export function reroutedFailoverToastCopy(
  event: FailoverEvent,
): FailoverToastCopy {
  const to = event.toAdapterId ?? 'outra CLI';
  return {
    title:
      effectiveKind(event) === 'model'
        ? `Tarefa reaberta em ${to}`
        : `Tarefa seguiu em ${to}`,
    detail:
      `${event.reason}. O pane parado foi fechado; o trabalho segue no pane ` +
      `${event.toPaneId ?? 'novo'}.`,
  };
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
