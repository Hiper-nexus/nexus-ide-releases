/**
 * Lata de energético nossa — delight "abre e ferve" do pet.
 * Puro SVG+CSS; sem emoji, sem asset externo. aria-hidden por ser decoração.
 * Corpo preto + faixa operacional (`--ok`) + ouro no filete. Sem logo, sem
 * garra, sem wordmark de marca terceira. Efervescência em coffee-cup.css.
 * Em prefers-reduced-motion o fizz fica estático.
 */

import { useId } from 'react';

/**
 * Overlay de efervescência no canto do pane focado.
 * SVG puro, position absolute, pointer-events none.
 * Animações: só opacity e transform (compositor). Uma única execução (forwards).
 * Em prefers-reduced-motion: condensação estática, sem movimento.
 */
export function CoffeeSpillCorner({ className }: { className?: string } = {}) {
  return (
    <svg
      className={`spill-corner${className ? ` ${className}` : ''}`}
      viewBox="0 0 84 220"
      width="84"
      height="220"
      fill="none"
      aria-hidden="true"
    >
      {/* Spray curto — o "pssch" de abrir a lata */}
      <path
        className="spill__spray spill__spray--a"
        d="M62 14 C 52 6 44 3 34 8"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        className="spill__spray spill__spray--b"
        d="M66 12 C 70 3 78 1 82 8"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        className="spill__spray spill__spray--c"
        d="M60 18 C 50 14 40 18 32 28"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <ellipse className="spill__mist" cx="58" cy="24" rx="24" ry="11" />
      <path
        className="spill__stream spill__stream--body"
        d="M 58 30 C 53 72 64 112 56 158 C 50 192 62 202 57 216"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        className="spill__stream spill__stream--sheen"
        d="M 60 30 C 55 72 66 112 58 158 C 52 192 64 202 59 216"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle className="spill__bubble spill__bubble--1" cx="50" cy="88" r="3.1" />
      <circle className="spill__bubble spill__bubble--2" cx="67" cy="126" r="2.3" />
      <circle className="spill__bubble spill__bubble--3" cx="53" cy="160" r="2.7" />
      <circle className="spill__bubble spill__bubble--4" cx="64" cy="70" r="1.7" />
      <circle className="spill__bead spill__bead--1" cx="74" cy="50" r="2.1" />
      <circle className="spill__bead spill__bead--2" cx="78" cy="80" r="1.45" />
      <circle className="spill__bead spill__bead--3" cx="72" cy="112" r="1.8" />
      <path
        className="spill__flash"
        d="M46 18 L74 54"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface CoffeeCupProps {
  /** Altura-alvo em px (lata é mais estreita que alta). Padrão: 32. */
  size?: number;
  /** Quando verdadeiro, o fizz acelera e a lata tomba como se tivesse sido aberta. */
  celebrating?: boolean;
}

export function CoffeeCup({ size = 32, celebrating = false }: CoffeeCupProps) {
  const rawId = useId();
  const clipId = `can-body-${rawId.replace(/:/g, '')}`;
  const w = Math.round(size * (22 / 40));
  const h = size;
  return (
    <svg
      viewBox="0 0 22 40"
      fill="none"
      width={w}
      height={h}
      aria-hidden="true"
      className={`pet-coffee${celebrating ? ' pet-coffee--celebrating' : ''}`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="4.4" y="11" width="13.2" height="26.2" rx="2.6" />
        </clipPath>
      </defs>
      <ellipse className="pet-coffee__ground" cx="11" cy="38.5" rx="7" ry="1" />
      <g clipPath={`url(#${clipId})`}>
        <rect className="pet-coffee__body" x="4.4" y="11" width="13.2" height="26.2" rx="2.6" />
        <rect className="pet-coffee__shade" x="14.4" y="12.2" width="2.6" height="23.6" rx="1.1" />
        <rect className="pet-coffee__sheen" x="5.4" y="12.6" width="1.7" height="21.4" rx="0.85" />
        <rect className="pet-coffee__band" x="4.4" y="19.2" width="13.2" height="5.4" />
        <rect className="pet-coffee__band-edge" x="4.4" y="19.2" width="13.2" height="0.7" />
        <circle className="pet-coffee__seal" cx="11" cy="21.9" r="1.65" />
        <circle className="pet-coffee__seal-core" cx="11" cy="21.9" r="0.65" />
        <circle className="pet-coffee__bead pet-coffee__bead--a" cx="6.7" cy="28.4" r="0.72" />
        <circle className="pet-coffee__bead pet-coffee__bead--b" cx="16.1" cy="25.6" r="0.52" />
        <circle className="pet-coffee__bead pet-coffee__bead--c" cx="7.2" cy="33.2" r="0.42" />
      </g>
      <ellipse className="pet-coffee__lid" cx="11" cy="11.05" rx="6.7" ry="2" />
      <ellipse
        className="pet-coffee__rim"
        cx="11"
        cy="10.9"
        rx="6.7"
        ry="2"
        strokeWidth="0.55"
      />
      <ellipse className="pet-coffee__mouth" cx="11" cy="11.15" rx="4.5" ry="1.15" />
      <rect className="pet-coffee__tab-stem" x="11.1" y="8.85" width="1.55" height="0.7" rx="0.3" />
      <ellipse
        className="pet-coffee__tab-ring"
        cx="13.4"
        cy="8.55"
        rx="1.55"
        ry="0.82"
        strokeWidth="0.65"
      />
      <circle className="pet-coffee__fizz pet-coffee__fizz--a" cx="9.1" cy="6.2" r="0.82" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--b" cx="11.7" cy="4.4" r="0.62" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--c" cx="13.4" cy="6.5" r="0.48" />
    </svg>
  );
}
