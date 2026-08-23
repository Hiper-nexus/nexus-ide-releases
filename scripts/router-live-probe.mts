/**
 * Probe ao vivo do intent-router Tier 1: mostra quais provedores baratos têm
 * key configurada nesta máquina e como o router classifica missões reais.
 */
import { routeIntent, answerDirectQuestion } from '../src/main/orch/intent-router.ts';
import { hasRuntimeKey, listProviderSettings } from '../src/main/persistence/provider-config-store.ts';
import { loadLauncherProviderKey } from '../src/main/adapters/launcher-provider-manager.ts';

const CHAIN = ['deepseek', 'glm', 'qwen'] as const;

console.log('=== KEYS CONFIGURADAS (cadeia do router) ===');
for (const id of CHAIN) {
  const has = hasRuntimeKey(id);
  const key = has ? loadLauncherProviderKey(id) : null;
  console.log(
    `  ${id.padEnd(9)} key:${has ? `SIM (${key ? key.length : 0} chars)` : 'não'}`,
  );
}

const settings = listProviderSettings();
const apiProviders = settings.filter((s) =>
  CHAIN.includes(s.adapterId as (typeof CHAIN)[number]),
);
console.log('\n=== PROVIDERS BARATOS NO SETTINGS ===');
for (const s of apiProviders) {
  console.log(`  ${s.adapterId}: enabled=${s.enabled ?? '?'}`);
}

const MISSIONS = [
  // [objetivo, classificação ESPERADA]
  ['quanto é 17% de 340?', 'direct-answer'],
  ['qual a diferença entre MySQL e PostgreSQL?', 'direct-answer'],
  ['pergunte aos panes quem é melhor: react ou vue', 'mission-question (guarda determinística ⇒ null)'],
  ['crie uma landing page para meu buffet com formulário de contato', 'mission-work'],
  ['construa um ecommerce completo com carrinho e pagamento', 'mission-work'],
  ['corrija o bug do login que dá erro 500', 'mission-work'],
  ['adicione um botão azul na página inicial', 'mission-work'],
] as const;

console.log('\n=== CLASSIFICAÇÃO AO VIVO (routeIntent) ===');
for (const [objective, esperado] of MISSIONS) {
  const route = await routeIntent(objective);
  const got = route?.kind ?? 'null→vira missão normal';
  const esperadoOk = got === esperado || (esperado.startsWith('mission-question') && got === 'null→vira missão normal');
  const ok = esperadoOk ? 'OK ' : 'DIF';
  console.log(`[${ok}] "${objective.slice(0, 52)}"`);
  console.log(`       esperado=${esperado} · router=${got}${
    route?.kind === 'mission-work' && route.skills.length ? ` skills=[${route.skills.join(',')}]` : ''
  }`);
}

console.log('\n=== RESPOSTA DIRETA AO VIVO (answerDirectQuestion) ===');
const answer = await answerDirectQuestion('quanto é 15% de 800?');
console.log(answer ? `"${answer.slice(0, 120)}"` : '(null — ninguém respondeu)');
process.exit(0);
