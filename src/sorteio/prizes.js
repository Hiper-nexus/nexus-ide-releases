/** Os prêmios do sorteio da comunidade: a única fonte do que a página, o jogo e a
 * home dizem sobre eles. Puro e imutável. O site não conhece o número de membros do
 * grupo, então nada aqui fala em contagem atual, progresso ou "faltam N". */

export const PRIZES = Object.freeze([
  Object.freeze({ id: 'claude', brand: 'Claude', tier: '20x', duration: '1 mês', goal: 200, order: 1, live: 'primeira live' }),
  Object.freeze({ id: 'codex', brand: 'Codex', tier: '20x', duration: '1 mês', goal: 500, order: 2, live: 'segunda live' }),
]);

/** O próximo a sair. */
export function nextPrize() {
  return PRIZES[0];
}

export function goalLine(prize) {
  return `aos ${prize.goal} no grupo`;
}

/** Uma linha só, para HUD e faixas: prêmio e meta. */
export function hudLine(prize) {
  return `SORTEIO · CONTA ${prize.brand.toUpperCase()} ${prize.tier} · ${goalLine(prize).toUpperCase()}`;
}

/** Frases do letreiro corrido. Só afirma o que a página já afirma. */
export function tickerPhrases() {
  const [first, second] = PRIZES;
  return [
    `CONTA ${first.brand.toUpperCase()} ${first.tier} · ${goalLine(first).toUpperCase()}`,
    `CONTA ${second.brand.toUpperCase()} ${second.tier} · ${goalLine(second).toUpperCase()}`,
    'SORTEIO AO VIVO, NUMA LIVE',
    'ENTRAR NO GRUPO É A INSCRIÇÃO',
  ];
}

export const DISCLAIMER = 'Participar é gratuito. Jogar, missões e XP não registram participação nem mudam as chances.';
