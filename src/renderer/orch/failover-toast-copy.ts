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

  // F-1483: retry de limite que voltou à própria conta e pediu "continue".
  if (event.transientPhase === 'nudged' && effectiveKind(event) !== 'transient') {
    return { title: 'Missão continuou na mesma conta', detail: `${event.reason}.` };
  }

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
  // F-1471: a conta esgotou e a tarefa seguiu na irmã da MESMA CLI.
  if (event.toAccountId && event.toAdapterId === event.fromAdapterId) {
    return {
      title: `Trocado para "${event.toAccountLabel}"`,
      detail:
        `"${event.fromAccountLabel}" atingiu o limite (${event.reason}). A tarefa seguiu no pane ` +
        `${event.toPaneId ?? 'novo'}, na mesma CLI, ` +
        // F-1473: no Claude a conversa atravessa a troca de conta.
        (event.nativeResume ? 'na mesma conversa.' : 'com o pacote de continuidade.'),
    };
  }
  if (effectiveKind(event) === 'model') {
    return {
      title: `Tarefa reaberta em ${to}`,
      detail:
        `${event.reason}. O pane parado foi fechado; o trabalho segue no pane ` +
        `${event.toPaneId ?? 'novo'}.`,
    };
  }
  // F-775: todas as contas da CLI esgotaram — a tarefa trocou de CLI.
  return {
    title:
      `${event.fromAdapterLabel ?? event.fromAdapterId ?? 'A CLI'} esgotou em todas as contas; ` +
      `continuando em ${event.toAdapterLabel ?? to}`,
    detail:
      `${event.reason}. O pane novo (${event.toPaneId ?? 'novo'}) recebeu o pacote de ` +
      'continuidade: arquivos tocados, diff e próximo passo.',
  };
}

/**
 * F-775: troca de CLI no lugar (pane do operador). O pedido já avisa — o dono
 * quer ver na hora que a CLI esgotou e para onde o trabalho foi —; o recibo
 * confirma ou diz que nada foi trocado.
 */
export function cliSwitchToastCopy(event: FailoverEvent): FailoverToastCopy {
  const from = event.fromAdapterLabel ?? event.fromAdapterId ?? 'A CLI';
  const to = event.toAdapterLabel ?? event.toAdapterId ?? 'outra CLI';
  if (event.cliSwitchPhase === 'applied' && !event.switched) {
    return {
      title: `Troca de ${from} para ${to} não aplicada`,
      detail: `${event.reason}.`,
    };
  }
  return {
    title: `${from} esgotou em todas as contas; continuando em ${to}`,
    detail:
      event.cliSwitchPhase === 'applied'
        ? 'O pane já roda na CLI nova, com o pacote de continuidade (arquivos tocados, diff e próximo passo).'
        : 'Sessão nova na CLI escolhida pela rota, com o pacote de continuidade — o histórico do terminal fica.',
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
