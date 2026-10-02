/** O que o HUD e o painel de estação dizem sobre o sorteio, como dados puros.
 * Todo o texto vem de src/sorteio/prizes.js: o jogo nunca escreve a meta por conta própria. */
import { PRIZES, hudLine, goalLine, DISCLAIMER } from '../sorteio/prizes.js';

/** O chip fixo do HUD: `parts` viram os trechos visíveis e `label` é a frase lida por leitor de tela. */
export function chipParts(prize) {
  const label = hudLine(prize);
  return { label, parts: label.split(' · ') };
}

const upperFirst = text => text.charAt(0).toUpperCase() + text.slice(1);

/** Os dois bilhetes do painel do sorteio, o próximo a sair primeiro. */
export function stationRows() {
  return PRIZES.map(prize => ({
    id: prize.id,
    name: `Conta ${prize.brand} ${prize.tier}`,
    goal: upperFirst(goalLine(prize)),
    meta: `${prize.duration} · ao vivo na ${prize.live}`,
    next: prize.order === 1,
    badge: prize.order === 1 ? 'PRÓXIMO A SAIR' : 'NA SEQUÊNCIA',
  }));
}

/** O painel do mural do sorteio: convite ao grupo, os dois prêmios e o aviso de regras. */
export function groupStation(url) {
  return {
    kicker: 'SORTEIO NO GRUPO',
    title: 'Entrar no grupo é a inscrição',
    copy: 'O sorteio é ao vivo, numa live, entre quem está no grupo. Quem ganha é avisado na hora.',
    note: DISCLAIMER,
    prizes: stationRows(),
    url, label: 'Entrar no grupo', whatsapp: true,
  };
}
