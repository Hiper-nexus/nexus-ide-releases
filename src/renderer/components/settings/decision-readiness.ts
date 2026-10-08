import type { DecisionModelStatus } from '../../../shared/decision-models';

export interface DecisionNotice { id: string; tone: 'warn' | 'info'; text: string }

function missingClef(status: DecisionModelStatus): string {
  const missing = [status.accountId ? '' : 'Account ID', status.hasStoredKey || status.hasEnv ? '' : 'API Token'].filter(Boolean);
  return missing.join(' e ');
}

const SAFEGUARDS = 'guarda de despacho, revisão de handoff, memória e pilotos de navegador e desktop';

/** What the chosen mode will really do with the current credentials, before the operator finds out the hard way. */
export function decisionNotices(status: DecisionModelStatus): DecisionNotice[] {
  const { mode, visionEnabled } = status.settings;
  const clefReady = status.isReady; const jevReady = status.jevReady; const lunaReady = status.lunaReady;
  const notices: DecisionNotice[] = [];
  if (mode === 'jev' && !jevReady) {
    notices.push({ id: 'jev-not-ready', tone: 'warn', text: 'Somente Jev está escolhido, mas não há chave TypeSafe. As ferramentas de decisão ficam ocultas e as triagens seguem as regras locais até você configurar o Jev.' });
  }
  if (mode === 'clef' && !clefReady) {
    notices.push({ id: 'clef-not-ready', tone: 'warn', text: `Somente Clef está escolhido, mas falta ${missingClef(status)} da Cloudflare. As ferramentas de decisão ficam ocultas e as triagens seguem as regras locais até a configuração terminar.` });
  }
  if (mode === 'clef') {
    notices.push({ id: 'clef-only-scope', tone: 'warn', text: `Em Somente Clef, ${SAFEGUARDS} ficam desligados: eles só rodam no Jev.` });
  }
  if (mode === 'luna' && !lunaReady) {
    notices.push({ id: 'luna-not-ready', tone: 'warn', text: 'Somente Luna (beta) está escolhido, mas não há chave OpenAI. As ferramentas de decisão ficam ocultas. Configure a chave em Chaves de API → OpenAI.' });
  }
  if (mode === 'luna' && lunaReady) {
    notices.push({ id: 'luna-pins', tone: jevReady ? 'info' : 'warn', text: jevReady
      ? `Somente Luna (beta) julga as decisões de texto sem limiar medido no Jev. ${SAFEGUARDS} continuam no Jev.`
      : `Somente Luna (beta) julga as decisões de texto. Sem chave TypeSafe, ${SAFEGUARDS} ficam desligados: eles não vão para a Luna.` });
  }
  if (mode === 'auto' && !jevReady && !clefReady && !lunaReady) {
    notices.push({ id: 'no-provider', tone: 'warn', text: 'O Automático está escolhido, mas nenhum provedor está configurado. Configure o Jev, a Cloudflare ou a OpenAI em Chaves de API.' });
  } else if (mode === 'auto' && !jevReady && !clefReady && lunaReady) {
    notices.push({ id: 'luna-fallback', tone: 'warn', text: `Sem Jev e sem Cloudflare, o Automático usa a Luna (beta, OpenAI) nas decisões de texto. ${SAFEGUARDS} ficam desligados sem o Jev.` });
  } else if (mode === 'auto' && !jevReady) {
    notices.push({ id: 'credential-fallback', tone: 'warn', text: `Sem chave Jev, o Automático envia à Cloudflare (Clef) o texto das decisões que normalmente usam o Jev. ${SAFEGUARDS} ficam desligados sem o Jev.` });
  } else if (mode === 'auto' && !clefReady) {
    notices.push({ id: 'auto-jev-only', tone: 'info', text: `Enquanto falta ${missingClef(status)} da Cloudflare, o Automático decide tudo pelo Jev.` });
  }
  const visionReady = mode === 'luna' ? lunaReady : mode === 'auto' ? clefReady || lunaReady : clefReady;
  if (visionEnabled && !visionReady) {
    notices.push({ id: 'vision-not-ready', tone: 'warn', text: 'A análise de imagens está ligada, mas nenhum provedor de visão está pronto: nenhuma captura é enviada.' });
  }
  return notices;
}
