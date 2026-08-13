/**
 * Xícara SVG com vapor — delight "cafeinado" do pet.
 * Puro SVG+CSS; sem emoji, sem asset externo. aria-hidden por ser decoração.
 * O vapor é animado via keyframes de coffee-cup.css (pet + painel Git).
 * Em prefers-reduced-motion o vapor fica estático.
 */

/**
 * Overlay leve de café derramando no canto do pane vago focado.
 * SVG puro, position absolute, pointer-events none.
 * Animações: só opacity e transform (compositor). Uma única execução (forwards).
 * Em prefers-reduced-motion: mancha estática, sem movimento.
 */
export function CoffeeSpillCorner() {
  return (
    <svg
      className="spill-corner"
      viewBox="0 0 52 200"
      width="52"
      height="200"
      fill="none"
      aria-hidden="true"
    >
      {/* Corpo escuro do filete — líquido de café */}
      <path
        className="spill__stream spill__stream--body"
        d="M 35 0 C 32 30 40 60 34 100 C 28 140 36 160 32 192"
        strokeWidth="6"
        strokeLinecap="round"
      />
      {/* Reflexo dourado — fio de luz na superfície do filete */}
      <path
        className="spill__stream spill__stream--sheen"
        d="M 37 0 C 34 30 42 60 36 100 C 30 140 38 160 34 192"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Gota 1 — saiu para a direita */}
      <circle className="spill__drop spill__drop--1" cx="46" cy="42" r="3.5" />
      {/* Gota 2 — caiu para a esquerda */}
      <circle className="spill__drop spill__drop--2" cx="24" cy="88" r="2.5" />
      {/* Poça ao final do filete */}
      <ellipse className="spill__pool" cx="32" cy="196" rx="15" ry="4" />
    </svg>
  );
}

interface CoffeeCupProps {
  /** Altura-alvo em px (largura proporcionalmente menor). Padrão: 32. */
  size?: number;
  /** Quando verdadeiro, o vapor acelera ("rush de cafeína" em celebração). */
  celebrating?: boolean;
}

export function CoffeeCup({ size = 32, celebrating = false }: CoffeeCupProps) {
  // 24 de largura: a alça passa de x=16 e não pode viver num viewBox de 20.
  const w = Math.round(size * (24 / 28));
  const h = size;
  return (
    <svg
      viewBox="0 0 24 28"
      fill="none"
      width={w}
      height={h}
      aria-hidden="true"
      className={`pet-coffee${celebrating ? ' pet-coffee--celebrating' : ''}`}
    >
      {/* Três fios de vapor — staggered pelo CSS */}
      <path
        className="pet-coffee__steam pet-coffee__steam--a"
        d="M5 13 C4 10 6.5 8 5.5 5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        fill="none"
      />
      <path
        className="pet-coffee__steam pet-coffee__steam--b"
        d="M10 13 C9 10 11 8 10 5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        fill="none"
      />
      <path
        className="pet-coffee__steam pet-coffee__steam--c"
        d="M15 13 C14 10 16.5 8 15.5 5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        fill="none"
      />
      {/* Borda superior da xícara */}
      <rect x="2" y="13" width="16" height="2" rx="1" fill="currentColor" opacity="0.95" />
      {/* Corpo */}
      <rect x="2" y="15" width="14" height="10" rx="2" fill="currentColor" />
      {/* Alça */}
      <path
        d="M16 17 Q20.5 17 20.5 20 Q20.5 23 16 23"
        stroke="currentColor"
        strokeWidth="1.85"
        fill="none"
        strokeLinecap="round"
      />
      {/* Pires */}
      <ellipse cx="9" cy="26.5" rx="8.5" ry="1.2" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
