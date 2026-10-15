/**
 * Lata de energético nossa — delight "abre e ferve" do pet.
 * Puro SVG+CSS; sem emoji, sem asset externo. aria-hidden por ser decoração.
 * Cilindro preto + tampa prata + slash `--ok` + wordmark NEXUS.
 * Sem garra, sem wordmark de marca terceira. Motion em coffee-cup.css.
 * Em prefers-reduced-motion a lata fica estática.
 */

import { useId, type CSSProperties } from 'react';

const CAN_VB_W = 28;
const CAN_VB_H = 52;
const CAN_BODY =
  'M 7.2 11.4 L 5.2 13.8 L 5.2 45.6 L 7.2 48.1 L 20.8 48.1 L 22.8 45.6 L 22.8 13.8 L 20.8 11.4 Z';

/** Faíscas do estalo: para onde cada uma voa a partir da boca da lata. */
const POP_SPARKS: ReadonlyArray<{ x: number; y: number; r: number; dx: number; dy: number }> = [
  { x: 47.6, y: 8.6, r: 0.9, dx: -7, dy: -6 },
  { x: 49.8, y: 7.8, r: 0.75, dx: 1, dy: -10 },
  { x: 51.6, y: 8.6, r: 0.85, dx: 7, dy: -5 },
  { x: 46, y: 9.4, r: 0.6, dx: -10, dy: -2 },
  { x: 53, y: 9.2, r: 0.55, dx: 10, dy: -1 },
  { x: 49, y: 7.6, r: 0.5, dx: -4, dy: -13 },
];

export type SpillCornerPhase = 'open' | 'sip';

interface CoffeeSpillCornerProps {
  className?: string;
  /**
   * open = a lata abre com estalo (foco): lacre estala, anel de pressão,
   * espuma sobe e escorre, bolhas. sip = gole quando o XP entra.
   */
  phase?: SpillCornerPhase;
  /** Texto do gole ("+3K XP"); só no sip. */
  xpLabel?: string | null;
  /** Fim da cena (a lata saiu de vez) — o contêiner desmonta. */
  onDone?: () => void;
}

/**
 * Lata de energético no canto do pane focado. Cabe no canto (~76px), SVG puro,
 * pointer-events none. Motion em coffee-cup.css: só transform/opacity, tudo
 * finito — parada, a lata não custa frame nenhum. Em prefers-reduced-motion:
 * lata aberta estática e saída só por opacidade.
 */
export function CoffeeSpillCorner({
  className,
  phase = 'open',
  xpLabel = null,
  onDone,
}: CoffeeSpillCornerProps = {}) {
  return (
    <svg
      className={`spill-corner spill-corner--${phase}${className ? ` ${className}` : ''}`}
      viewBox="26 -8 38 46"
      width="64"
      height="76"
      fill="none"
      aria-hidden="true"
      onAnimationEnd={
        onDone
          ? (event) => {
              if (
                event.target === event.currentTarget &&
                event.animationName === 'spill-corner-out'
              ) {
                onDone();
              }
            }
          : undefined
      }
    >
      {/* Espuma que transbordou: escorre pela lateral e empoça na base. */}
      <path
        className="spill__stream spill__stream--body"
        d="M 44.4 11.2 C 43.2 15 43.6 22 43.1 33"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <ellipse className="spill__pool" cx="47" cy="37.6" rx="8" ry="1.7" />
      <g className="spill__can">
        <path className="spill__can-body" d="M44.5 10H54.5L56 12V34.8L54.5 36.4H44.5L43 34.8V12Z" />
        <ellipse className="spill__can-base" cx="49.5" cy="35.7" rx="5.5" ry="0.7" />
        <rect className="spill__can-shade" x="51.6" y="11.6" width="3" height="23.2" rx="1" />
        <rect className="spill__can-sheen" x="44.2" y="12" width="1.5" height="20.6" rx="0.6" />
        <path className="spill__can-band" d="M 43 17 L 56 24.6 L 56 28.4 L 43 20.8 Z" />
        <path className="spill__can-bolt" d="M49.9 13.5L47.6 17.3H49.4L48.8 20L52 15.8H50.2Z" />
        <text className="spill__can-mark" x="49.5" y="30.8" textAnchor="middle" textLength="10.5" lengthAdjust="spacingAndGlyphs">NEXUS</text>
        <ellipse className="spill__can-lid" cx="49.5" cy="10" rx="6.8" ry="2.15" />
        <ellipse className="spill__can-mouth" cx="48.6" cy="10.1" rx="2.6" ry="0.95" />
        <g className="spill__foam">
          <circle cx="46.9" cy="8.9" r="1.9" />
          <circle cx="49.4" cy="7.7" r="2.5" />
          <circle cx="52" cy="8.8" r="1.8" />
          <circle cx="50.9" cy="6.5" r="1.1" />
        </g>
        <g className="spill__tab">
          <ellipse className="spill__tab-ring" cx="52.4" cy="9.5" rx="1.7" ry="0.8" strokeWidth="0.7" />
          <rect className="spill__tab-stem" x="50.2" y="9.2" width="1.4" height="0.6" rx="0.25" />
        </g>
      </g>
      <circle className="spill__pop" cx="49.5" cy="8.6" r="4.2" strokeWidth="0.9" />
      <path className="spill__pressure" d="M40 11C37 4 42-2 46-3M54-2C60 0 63 5 60 11" strokeWidth="0.7" strokeLinecap="round" />
      {POP_SPARKS.map((spark) => (
        <circle
          key={`${spark.dx}:${spark.dy}`}
          className="spill__spark"
          cx={spark.x}
          cy={spark.y}
          r={spark.r}
          style={{ '--dx': `${spark.dx}px`, '--dy': `${spark.dy}px` } as CSSProperties}
        />
      ))}
      <circle className="spill__drop spill__drop--1" cx="47.6" cy="6.2" r="1.15" />
      <circle className="spill__drop spill__drop--2" cx="50.4" cy="5" r="0.85" />
      <circle className="spill__drop spill__drop--3" cx="52.4" cy="6.6" r="1" />
      {phase === 'sip' && xpLabel ? (
        <text className="spill__xp" x="40.5" y="4.5" textAnchor="end">
          {xpLabel}
        </text>
      ) : null}
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
