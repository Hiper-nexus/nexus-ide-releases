/**
 * Lata de energético nossa — delight "abre e ferve" do pet.
 * Puro SVG+CSS; sem emoji, sem asset externo. aria-hidden por ser decoração.
 * Cilindro preto + tampa prata + slash `--ok` + wordmark NEXUS.
 * Sem garra, sem wordmark de marca terceira. Motion em coffee-cup.css.
 * Em prefers-reduced-motion a lata fica estática.
 */

import { useId } from 'react';

const CAN_VB_W = 28;
const CAN_VB_H = 52;
const CAN_BODY =
  'M 7.2 11.4 L 5.2 13.8 L 5.2 45.6 L 7.2 48.1 L 20.8 48.1 L 22.8 45.6 L 22.8 13.8 L 20.8 11.4 Z';

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
        <rect className="spill__can-body" x="43" y="3.2" width="13" height="27.2" rx="1.6" />
        <rect className="spill__can-shade" x="51.6" y="4.8" width="3" height="23.6" rx="1" />
        <rect className="spill__can-sheen" x="44.2" y="5.2" width="1.5" height="21" rx="0.6" />
        <path className="spill__can-band" d="M 41.6 9.2 L 57.4 18.4 L 57.4 22.2 L 41.6 13 Z" />
        <ellipse className="spill__can-lid" cx="49.5" cy="3.4" rx="6.8" ry="2.15" />
        <ellipse className="spill__can-mouth" cx="49.5" cy="3.55" rx="4.2" ry="1.05" />
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
  const w = Math.round(size * (CAN_VB_W / CAN_VB_H));
  const h = size;
  return (
    <svg
      viewBox={`0 0 ${CAN_VB_W} ${CAN_VB_H}`}
      fill="none"
      width={w}
      height={h}
      aria-hidden="true"
      className={`pet-coffee${celebrating ? ' pet-coffee--celebrating' : ''}`}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={CAN_BODY} />
        </clipPath>
      </defs>
      <ellipse className="pet-coffee__ground" cx="14" cy="50.4" rx="8.4" ry="1.1" />
      <path className="pet-coffee__body" d={CAN_BODY} />
      <ellipse className="pet-coffee__base" cx="14" cy="47.9" rx="7.6" ry="1.3" />
      <g clipPath={`url(#${clipId})`}>
        <rect className="pet-coffee__shade" x="18.6" y="13.4" width="3.4" height="32.4" rx="1" />
        <rect className="pet-coffee__sheen" x="6.2" y="14" width="1.7" height="29.6" rx="0.7" />
        <rect className="pet-coffee__neck" x="5.2" y="13.6" width="17.6" height="1.25" />
        {/* Faixa operacional diagonal — um slash, não garra. */}
        <path className="pet-coffee__band" d="M 1.4 16.2 L 26.6 35.4 L 26.6 44.8 L 1.4 25.6 Z" />
        <path className="pet-coffee__band-edge" d="M 1.4 16.2 L 26.6 35.4 L 26.6 36.7 L 1.4 17.5 Z" />
        {/* Selo energético original: anel + raio. */}
        <g className="pet-coffee__seal" transform="translate(14 20.2)">
          <circle className="pet-coffee__seal-ring" r="2.55" />
          <path
            className="pet-coffee__seal-bolt"
            d="M 0.15 -1.7 L 1.05 -1.7 L 0.2 0.05 L 0.95 0.05 L -0.4 1.75 L 0.12 0.48 L -0.85 0.48 Z"
          />
        </g>
        <text
          className="pet-coffee__mark"
          data-word="NEXUS"
          x="14"
          y="34.8"
          textAnchor="middle"
          fontSize="8.6"
          fontWeight="650"
          letterSpacing="-0.18"
          textLength="16.8"
          lengthAdjust="spacingAndGlyphs"
        >
          NEXUS
        </text>
        <circle className="pet-coffee__bead pet-coffee__bead--a" cx="7.4" cy="41.2" r="0.65" />
        <circle className="pet-coffee__bead pet-coffee__bead--b" cx="20.4" cy="39.6" r="0.48" />
        <circle className="pet-coffee__bead pet-coffee__bead--c" cx="8" cy="44.8" r="0.38" />
      </g>
      <ellipse className="pet-coffee__lid" cx="14" cy="11.35" rx="8.2" ry="2.45" />
      <ellipse
        className="pet-coffee__rim"
        cx="14"
        cy="11.2"
        rx="8.2"
        ry="2.45"
        strokeWidth="0.7"
      />
      <ellipse className="pet-coffee__mouth" cx="14" cy="11.45" rx="5.1" ry="1.2" />
      <g className="pet-coffee__tab">
        <ellipse
          className="pet-coffee__tab-ring"
          cx="14"
          cy="10.25"
          rx="2.05"
          ry="1.05"
          strokeWidth="0.72"
        />
        <rect className="pet-coffee__tab-stem" x="13.15" y="11.05" width="1.7" height="0.62" rx="0.28" />
      </g>
      <circle className="pet-coffee__drip" cx="19.4" cy="12.7" r="0.65" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--a" cx="12.2" cy="7.4" r="0.55" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--b" cx="14.1" cy="5.8" r="0.42" />
      <circle className="pet-coffee__fizz pet-coffee__fizz--c" cx="15.6" cy="7.2" r="0.34" />
    </svg>
  );
}
