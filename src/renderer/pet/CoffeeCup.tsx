/**
 * Lata de energético nossa — delight "abre e ferve" do pet.
 * Puro SVG+CSS; sem emoji, sem asset externo. aria-hidden por ser decoração.
 * Corpo preto + faixa operacional (`--ok`) + ouro no filete. Sem logo, sem
 * garra, sem wordmark de marca terceira. Motion e derrame em coffee-cup.css.
 * Em prefers-reduced-motion a lata fica estática.
 */

import { useId } from 'react';

/**
 * Derrame de energético no canto do pane focado.
 * A lata entorna: filete cai da boca, gotas, poça espalha e some.
 * SVG puro, pointer-events none. Anima só opacity e transform (compositor).
 * Em prefers-reduced-motion: poça estática curta.
 */
export function CoffeeSpillCorner({ className }: { className?: string } = {}) {
  return (
    <svg
      className={`spill-corner${className ? ` ${className}` : ''}`}
      viewBox="0 0 96 236"
      width="96"
      height="236"
      fill="none"
      aria-hidden="true"
    >
      {/* Lata fonte — tomba e o líquido sai da boca */}
      <g className="spill__can">
        <rect className="spill__can-body" x="64" y="8" width="16" height="30" rx="3" />
        <rect className="spill__can-shade" x="75" y="10" width="3.2" height="25" rx="1" />
        <rect className="spill__can-sheen" x="65.4" y="10.4" width="1.8" height="23" rx="0.8" />
        <rect className="spill__can-band" x="64" y="18" width="16" height="6" />
        <ellipse className="spill__can-lid" cx="72" cy="8.4" rx="8.2" ry="2.3" />
        <ellipse className="spill__can-mouth" cx="72" cy="8.6" rx="5.4" ry="1.25" />
      </g>
      {/* Filete — nasce na boca, cai e encontra a poça */}
      <path
        className="spill__stream spill__stream--body"
        d="M 64 14 C 50 52 70 98 48 154 C 36 192 54 214 44 228"
        strokeWidth="6.5"
        strokeLinecap="round"
      />
      <path
        className="spill__stream spill__stream--sheen"
        d="M 66 14 C 52 52 72 98 50 154 C 38 192 56 214 46 228"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle className="spill__drop spill__drop--1" cx="58" cy="56" r="3.3" />
      <circle className="spill__drop spill__drop--2" cx="42" cy="104" r="2.5" />
      <circle className="spill__drop spill__drop--3" cx="52" cy="148" r="2.9" />
      <ellipse className="spill__pool" cx="44" cy="230" rx="24" ry="5.2" />
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
      <g className="pet-coffee__tab">
        <rect className="pet-coffee__tab-stem" x="11.1" y="8.85" width="1.55" height="0.7" rx="0.3" />
        <ellipse
          className="pet-coffee__tab-ring"
          cx="13.4"
          cy="8.55"
          rx="1.55"
          ry="0.82"
          strokeWidth="0.65"
        />
      </g>
      <circle className="pet-coffee__drip" cx="14.2" cy="12.2" r="0.7" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--a" cx="9.1" cy="6.2" r="0.82" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--b" cx="11.7" cy="4.4" r="0.62" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--c" cx="13.4" cy="6.5" r="0.48" />
    </svg>
  );
}
