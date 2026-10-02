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
  const clefReady = status.isReady; const jevReady = status.jevReady;
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
  if (mode === 'auto' && !jevReady && !clefReady) {
    notices.push({ id: 'no-provider', tone: 'warn', text: 'O Automático está escolhido, mas nenhum provedor está configurado. Configure o Jev ou a Cloudflare em Chaves de API.' });
  } else if (mode === 'auto' && !jevReady) {
    notices.push({ id: 'credential-fallback', tone: 'warn', text: `Sem chave Jev, o Automático envia à Cloudflare (Clef) o texto das decisões que normalmente usam o Jev. ${SAFEGUARDS} ficam desligados sem o Jev.` });
  } else if (mode === 'auto' && !clefReady) {
    notices.push({ id: 'auto-jev-only', tone: 'info', text: `Enquanto falta ${missingClef(status)} da Cloudflare, o Automático decide tudo pelo Jev.` });
  }
  if (visionEnabled && !clefReady) {
    notices.push({ id: 'vision-not-ready', tone: 'warn', text: 'A análise de imagens está ligada, mas a Cloudflare não está pronta: nenhuma captura é enviada.' });
  }
  return notices;
}
