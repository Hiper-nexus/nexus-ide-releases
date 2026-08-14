/**
 * Lata de energético nossa — delight "abre e ferve" do pet.
 * Puro SVG+CSS; sem emoji, sem asset externo. aria-hidden por ser decoração.
 * Cilindro metálico + tampa + faixa operacional (`--ok`). Sem logo, sem
 * garra, sem wordmark de marca terceira. Motion e derrame em coffee-cup.css.
 * Em prefers-reduced-motion a lata fica estática.
 */

import { useId } from 'react';

/**
 * Derrame de energético no canto do pane focado.
 * Lata no canto + filete curto + poça. Nunca uma barra do teto ao chão:
 * o viewBox cabe num canto (~76px). SVG puro, pointer-events none.
 * Anima só opacity e transform (compositor).
 * Em prefers-reduced-motion: poça estática curta.
 */
export function CoffeeSpillCorner({ className }: { className?: string } = {}) {
  return (
    <svg
      className={`spill-corner${className ? ` ${className}` : ''}`}
      viewBox="0 0 64 76"
      width="64"
      height="76"
      fill="none"
      aria-hidden="true"
    >
      <g className="spill__can">
        <rect className="spill__can-body" x="42" y="4" width="14" height="26" rx="2" />
        <rect className="spill__can-shade" x="51.2" y="5.6" width="3.2" height="22.4" rx="1" />
        <rect className="spill__can-sheen" x="43.4" y="6" width="1.7" height="20" rx="0.7" />
        <rect className="spill__can-band" x="42" y="12.4" width="14" height="6.2" />
        <ellipse className="spill__can-lid" cx="49" cy="4.3" rx="7.2" ry="2.1" />
        <ellipse className="spill__can-mouth" cx="49" cy="4.5" rx="4.6" ry="1.1" />
      </g>
      {/* Um arco da boca à poça — pour curto, não onda vertical. */}
      <path
        className="spill__stream spill__stream--body"
        d="M 43 14 C 34 24 30 40 26 58"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        className="spill__stream spill__stream--sheen"
        d="M 44.5 14 C 35.5 24 31.5 40 27.5 58"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle className="spill__drop spill__drop--1" cx="36" cy="26" r="2.4" />
      <circle className="spill__drop spill__drop--2" cx="30" cy="40" r="1.8" />
      <circle className="spill__drop spill__drop--3" cx="28" cy="50" r="2.1" />
      <ellipse className="spill__pool" cx="26" cy="70" rx="16" ry="4" />
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
  const w = Math.round(size * (24 / 48));
  const h = size;
  return (
    <svg
      viewBox="0 0 24 48"
      fill="none"
      width={w}
      height={h}
      aria-hidden="true"
      className={`pet-coffee${celebrating ? ' pet-coffee--celebrating' : ''}`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="5" y="12" width="14" height="32" rx="1.8" />
        </clipPath>
      </defs>
      <ellipse className="pet-coffee__ground" cx="12" cy="46.4" rx="8" ry="1.15" />
      <rect className="pet-coffee__body" x="5" y="12" width="14" height="32" rx="1.8" />
      <ellipse className="pet-coffee__base" cx="12" cy="43.8" rx="7" ry="1.35" />
      <g clipPath={`url(#${clipId})`}>
        <rect className="pet-coffee__shade" x="15.4" y="13.2" width="2.8" height="29.2" rx="1" />
        <rect className="pet-coffee__sheen" x="6.1" y="13.6" width="1.7" height="26.8" rx="0.8" />
        <rect className="pet-coffee__neck" x="5" y="14.2" width="14" height="1.2" />
        <rect className="pet-coffee__band" x="5" y="22.4" width="14" height="8.2" />
        <rect className="pet-coffee__band-edge" x="5" y="22.4" width="14" height="0.85" />
        <circle className="pet-coffee__seal" cx="12" cy="26.5" r="1.7" />
        <circle className="pet-coffee__seal-core" cx="12" cy="26.5" r="0.6" />
        <circle className="pet-coffee__bead pet-coffee__bead--a" cx="7.2" cy="34.2" r="0.7" />
        <circle className="pet-coffee__bead pet-coffee__bead--b" cx="17" cy="32.4" r="0.5" />
        <circle className="pet-coffee__bead pet-coffee__bead--c" cx="7.6" cy="39.6" r="0.4" />
      </g>
      <ellipse className="pet-coffee__lid" cx="12" cy="12.05" rx="7.3" ry="2.25" />
      <ellipse
        className="pet-coffee__rim"
        cx="12"
        cy="11.9"
        rx="7.3"
        ry="2.25"
        strokeWidth="0.6"
      />
      <ellipse className="pet-coffee__mouth" cx="12" cy="12.2" rx="4.6" ry="1.15" />
      <g className="pet-coffee__tab">
        <ellipse
          className="pet-coffee__tab-ring"
          cx="12"
          cy="11.15"
          rx="1.45"
          ry="0.78"
          strokeWidth="0.6"
        />
        <rect className="pet-coffee__tab-stem" x="11.35" y="11.7" width="1.3" height="0.55" rx="0.25" />
      </g>
      <circle className="pet-coffee__drip" cx="16.6" cy="13.4" r="0.65" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--a" cx="10.4" cy="8.2" r="0.55" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--b" cx="12.2" cy="6.6" r="0.42" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--c" cx="13.5" cy="8" r="0.34" />
    </svg>
  );
}
