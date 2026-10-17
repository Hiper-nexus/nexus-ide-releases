import { useEffect, useRef } from 'react';
import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';

/**
 * JARVIS como humano de partículas — "forma e desfaz".
 *
 * Substitui o orb no modo expandido (ampliado) do HUD: em vez do disco de
 * anéis, um campo de partículas que coalesce num contorno humano. Cada fase do
 * pipeline lê como um estado PRÓPRIO (`figureMotionForStatus`):
 *
 *  - ocioso: a silhueta fica RECONHECÍVEL o tempo todo e respira (peito e
 *    ombros sobem e abrem, `breathingOffset`). Num ciclo de ~9 s a coesão cai
 *    do pico (~0,9) a um vale parcial (~0,6) e volta (`idleCohesion`): o
 *    núcleo só fica um pouco poroso, enquanto mãos e pés se soltam em poeira
 *    e se refazem (`idleParticleCohesion`, dissolução LOCAL — nunca a nuvem
 *    espalhada pelo canvas inteiro);
 *  - ouvindo: corpo inteiro puxado para dentro, pulsando com o nível do mic;
 *  - falando: ondas (ripples) saindo da cabeça/peito, boca e torso vibrando
 *    com a energia da fala (`speakingEnergy` — nível real quando há, pulso
 *    base quando não há);
 *  - transcrevendo/roteando: órbita/vórtice ao redor do centro;
 *  - erro: cor `--danger` e dispersão.
 *
 * O mouse participa sem quebrar nada: o canvas é decorativo
 * (`pointer-events: none`), o cursor é ouvido num listener de `window`
 * (repulsão perto do cursor, cabeça/olhar acompanhando com easing e um leve
 * parallax por profundidade — `cursorForce`/`gazeOffset`/`parallaxOffset`).
 *
 * Geometria, física e mapeamento de estado ficam em funções puras exportadas:
 * testáveis sem canvas. O desenho é um loop `rAF` imperativo no próprio
 * canvas (sem re-render por frame), pausado quando a aba está oculta.
 * `prefers-reduced-motion` pinta um quadro estático com a silhueta FORMADA na
 * posição de repouso e o repinta quando o estado ou o tamanho mudam.
 */

export interface Particle2 {
  x: number;
  y: number;
}

/** Ponto da silhueta + o quanto ele está na ponta de um membro. */
export interface SilhouettePoint extends Particle2 {
  /** 0 = núcleo do corpo (cabeça, pescoço, tronco) … 1 = ponta (mão, pé). */
  tip: number;
}

/** PRNG determinístico (mulberry32) — silhueta estável entre renders e testes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ponto uniforme em área dentro de um círculo (não enviesado ao centro). */
function circlePoint(
  rng: () => number,
  cx: number,
  cy: number,
  r: number,
): SilhouettePoint {
  const angle = rng() * Math.PI * 2;
  const radius = Math.sqrt(rng()) * r;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, tip: 0 };
}

/**
 * Ponto num segmento-capsula (membro): linha central + offset perpendicular.
 * `tipPower` > 0 faz a ponta (t → 1) soltar-se mais que a raiz do membro.
 */
function capsulePoint(
  rng: () => number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
  tipPower = 0,
): SilhouettePoint {
  const t = rng();
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular à linha central; distribui a "carne" do membro.
  const off = (rng() * 2 - 1) * r;
  return {
    x: x1 + dx * t + (-dy / len) * off,
    y: y1 + dy * t + (dx / len) * off,
    tip: tipPower > 0 ? t ** tipPower : 0,
  };
}

/** Ponto num trapézio vertical (tronco: ombros largos → quadris). */
function trapezoidPoint(
  rng: () => number,
  cx: number,
  topY: number,
  bottomY: number,
  topHalf: number,
  bottomHalf: number,
): SilhouettePoint {
  const y = topY + (bottomY - topY) * rng();
  const progress = (y - topY) / (bottomY - topY);
  const half = topHalf + (bottomHalf - topHalf) * progress;
  return { x: cx + (rng() * 2 - 1) * half, y, tip: 0 };
}

/**
 * Contorno humano em coordenadas normalizadas [0,1] (x: esquerda→direita,
 * y: topo→base). Cabeça + pescoço + tronco + dois braços + duas pernas.
 * Orçamento por região para a densidade ler como figura inteira, não varetas.
 * Mãos e pés carregam `tip` alto: são eles que se soltam no ocioso.
 */
export function buildHumanSilhouette(count: number, seed = 0x9e3779b9): SilhouettePoint[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const rng = mulberry32(seed);

  const head = Math.round(n * 0.14);
  const neck = Math.round(n * 0.04);
  const torso = Math.round(n * 0.28);
  const arms = Math.round(n * 0.16);
  const legs = n - head - neck - torso - arms;

  const pts: SilhouettePoint[] = [];
  for (let i = 0; i < head; i += 1) pts.push(circlePoint(rng, 0.5, 0.155, 0.09));
  for (let i = 0; i < neck; i += 1) pts.push(capsulePoint(rng, 0.5, 0.24, 0.5, 0.29, 0.028));
  for (let i = 0; i < torso; i += 1) pts.push(trapezoidPoint(rng, 0.5, 0.29, 0.52, 0.16, 0.14));

  const leftArm = Math.floor(arms / 2);
  for (let i = 0; i < leftArm; i += 1) pts.push(capsulePoint(rng, 0.35, 0.31, 0.3, 0.55, 0.026, 1.3));
  for (let i = 0; i < arms - leftArm; i += 1) pts.push(capsulePoint(rng, 0.65, 0.31, 0.7, 0.55, 0.026, 1.3));

  const leftLeg = Math.floor(legs / 2);
  for (let i = 0; i < leftLeg; i += 1) pts.push(capsulePoint(rng, 0.44, 0.52, 0.43, 0.96, 0.042, 1.6));
  for (let i = 0; i < legs - leftLeg; i += 1) pts.push(capsulePoint(rng, 0.56, 0.52, 0.57, 0.96, 0.042, 1.6));

  return pts;
}

/**
 * Parâmetros de movimento de cada fase do pipeline. Cada estado tem uma
 * assinatura PRÓPRIA (não só o grau de coesão):
 *  - `cohesion`: quanto o humano está formado (0 = dissolvido, 1 = inteiro);
 *  - `inward`: puxa as partículas para o centro do corpo (ouvindo);
 *  - `orbit`: força tangencial — vórtice ao redor do centro (pensando/roteando);
 *  - `wander`: deriva solta da nuvem dissolvida (ocioso, acentuado no erro);
 *  - `jitter`: vibração de alta frequência (boca/torso falando, tremor no erro);
 *  - `ripple`: ondas por segundo saindo da cabeça/peito (falando);
 *  - `breathe`: amplitude da respiração (ocioso/ouvindo);
 *  - `calm`: 1 = dissolução LOCAL (poeira ao redor da casa, só as pontas se
 *    soltam — ocioso); 0 = dissolução GLOBAL (as partículas vão para a nuvem).
 */
export interface FigureMotion {
  cohesion: number;
  inward: number;
  orbit: number;
  wander: number;
  jitter: number;
  ripple: number;
  breathe: number;
  calm: number;
}

/** Coesão-base do ocioso: figura inteira o bastante para ser reconhecida. */
export const IDLE_COHESION_MID = 0.76;
const IDLE_COHESION_SWING = 0.15;
/** rad/s: um ciclo de formar → soltar → refazer leva ~9 s. */
const IDLE_CYCLE_RATE = 0.7;
export const IDLE_CYCLE_S = (Math.PI * 2) / IDLE_CYCLE_RATE;
/** As pontas atrasam até este tanto (s) em relação ao núcleo. */
const IDLE_TIP_LAG_S = 0.6;
/** O quanto as pontas se soltam além do núcleo no vale do ciclo. */
const IDLE_TIP_LOOSEN = 0.85;
/** Expoente da dissolução: fica nítida no pico e só abre de fato no vale. */
const IDLE_EASE = 1.5;
/** Alcance máximo da poeira (fração do canvas até a nuvem): núcleo e pontas. */
const IDLE_CORE_SCATTER = 0.1;
const IDLE_TIP_SCATTER = 0.32;
/** Respiração de repouso: ~4,2 s por ciclo (12 a 15 respirações por minuto). */
const BREATH_RATE = 1.5;

const MOTION: Record<VoiceUiStatus, FigureMotion> = {
  idle: {
    cohesion: IDLE_COHESION_MID,
    inward: 0,
    orbit: 0,
    wander: 0.34,
    jitter: 0,
    ripple: 0,
    breathe: 1,
    calm: 1,
  },
  listening: { cohesion: 1, inward: 1, orbit: 0, wander: 0, jitter: 0, ripple: 0, breathe: 0.6, calm: 0 },
  transcribing: { cohesion: 0.62, inward: 0, orbit: 0.55, wander: 0.18, jitter: 0, ripple: 0, breathe: 0.3, calm: 0 },
  routing: { cohesion: 0.5, inward: 0, orbit: 1, wander: 0.22, jitter: 0, ripple: 0, breathe: 0.2, calm: 0 },
  speaking: { cohesion: 1, inward: 0, orbit: 0, wander: 0, jitter: 1, ripple: 1.1, breathe: 0.2, calm: 0 },
  error: { cohesion: 0.2, inward: 0, orbit: 0, wander: 0.5, jitter: 0.5, ripple: 0, breathe: 0, calm: 0 },
};

export function figureMotionForStatus(status: VoiceUiStatus): FigureMotion {
  return MOTION[status];
}

/**
 * Quanto o humano está "formado" (0 = dissolvido, 1 = inteiro) para cada fase
 * do pipeline. Repouso é figura reconhecível e porosa; falando/ouvindo é o
 * corpo inteiro; transcrever/rotear/erro se desfazem em vórtice.
 */
export function cohesionForStatus(status: VoiceUiStatus): number {
  return MOTION[status].cohesion;
}

/**
 * Coesão-alvo no ocioso, em função do tempo (s): sobe até o pico (~0,91, figura
 * inteira) e cai a um vale parcial (~0,61, figura porosa) num ciclo de ~9 s.
 * Nunca some nem fica inteira: é a respiração da própria figura.
 */
export function idleCohesion(t: number): number {
  return IDLE_COHESION_MID + IDLE_COHESION_SWING * Math.sin(t * IDLE_CYCLE_RATE);
}

/**
 * Coesão de UMA partícula no ocioso. O núcleo (`tip` 0) segue o ciclo global;
 * mãos e pés (`tip` → 1) atrasam um pouco e se soltam mais no vale, então se
 * desfazem e refazem a cada ciclo enquanto cabeça e tronco ficam legíveis.
 */
export function idleParticleCohesion(t: number, tip: number): number {
  const base = idleCohesion(t - IDLE_TIP_LAG_S * tip);
  const loosened = clamp01(base - tip * IDLE_TIP_LOOSEN * (1 - base));
  return 1 - (1 - loosened) ** IDLE_EASE;
}

/** Alcance da poeira no ocioso: o núcleo mal sai do lugar, as pontas voam mais. */
export function idleScatter(tip: number): number {
  return lerp(IDLE_CORE_SCATTER, IDLE_TIP_SCATTER, clamp01(tip));
}

/**
 * Posição de repouso (normalizada) de uma partícula: a casa na silhueta quando
 * coesa, a nuvem quando dissolvida. `scatter` limita até onde a dissolução
 * leva: 1 = a nuvem inteira; menos que isso = só uma poeira ao redor da casa.
 */
export function restPoint(
  home: Particle2,
  cloud: Particle2,
  cohesion: number,
  scatter = 1,
): Particle2 {
  const k = scatter * (1 - clamp01(cohesion));
  return { x: home.x + (cloud.x - home.x) * k, y: home.y + (cloud.y - home.y) * k };
}

/**
 * Respiração COERENTE (deslocamento normalizado, positivo = direita/baixo):
 * peito e ombros sobem e a caixa torácica abre ao inspirar; a cabeça acompanha
 * de leve e as pernas ficam. Substitui o tremor por partícula, que lia como
 * ruído e não como respiração.
 */
export function breathingOffset(x: number, y: number, t: number): Particle2 {
  const zone = Math.exp(-(((y - 0.4) / 0.2) ** 2));
  const wave = Math.sin(t * BREATH_RATE);
  return { x: (x - 0.5) * 0.05 * zone * wave, y: -0.01 * zone * wave };
}

/** Quantas partículas desenham a figura num canvas de `size` px de lado. */
export function particleCountForSize(size: number): number {
  return Math.round(clamp((size * size) / 85, 120, 360));
}

/**
 * Energia da fala para vibrar boca/torso e emitir ondas: usa o nível REAL de
 * áudio quando existe; sem nível, um pulso base para o estado não ficar estático.
 */
export function speakingEnergy(level: number, t: number): number {
  if (level > 0.02) return clamp01(level);
  return 0.3 + 0.25 * Math.sin(t * 8.2);
}

/**
 * Peso da vibração por região do corpo enquanto fala: peito/torso vibram mais,
 * cabeça (boca) um pouco, pernas quase nada.
 */
export function speakingZoneWeight(y: number): number {
  if (y > 0.27 && y < 0.56) return 1;
  if (y >= 0.06 && y <= 0.27) return 0.55;
  return 0.3;
}

/**
 * Força de repulsão do cursor sobre uma partícula: máxima no ponteiro, cai
 * quadraticamente até zero no raio. Fora do raio (ou strength 0) = vetores.
 */
export function cursorForce(
  px: number,
  py: number,
  mx: number,
  my: number,
  radius: number,
  strength = 1,
): Particle2 {
  const dx = px - mx;
  const dy = py - my;
  const d2 = dx * dx + dy * dy;
  if (strength === 0 || radius <= 0 || d2 === 0 || d2 >= radius * radius) {
    return { x: 0, y: 0 };
  }
  const d = Math.sqrt(d2);
  const falloff = 1 - d / radius;
  const mag = strength * falloff * falloff;
  return { x: (dx / d) * mag, y: (dy / d) * mag };
}

/**
 * Para onde a cabeça/olhar pende: direção da cabeça ao cursor, crescendo com
 * a distância e travada em `maxPx` (easing acontece no loop, via smoothing).
 */
export function gazeOffset(
  headX: number,
  headY: number,
  mx: number,
  my: number,
  maxPx: number,
): Particle2 {
  const dx = mx - headX;
  const dy = my - headY;
  const d = Math.hypot(dx, dy);
  if (d === 0 || maxPx <= 0) return { x: 0, y: 0 };
  const k = (Math.min(1, d / 120) * maxPx) / d;
  return { x: dx * k, y: dy * k };
}

/**
 * Parallax do cursor: o corpo inteiro desloca um pouco na direção do mouse,
 * proporcional à profundidade (cabeça mais, pés menos).
 */
export function parallaxOffset(
  mx: number,
  my: number,
  cx: number,
  cy: number,
  size: number,
  maxPx: number,
  depth: number,
): Particle2 {
  const half = size / 2 || 1;
  const nx = clamp((mx - cx) / half, -1, 1);
  const ny = clamp((my - cy) / half, -1, 1);
  return { x: nx * maxPx * depth, y: ny * maxPx * depth * 0.6 };
}

const DEFAULT_ACCENT = '#ff4f8b';
const DEFAULT_DANGER = '#ff6b4a';

function readToken(el: HTMLElement, name: string, fallback: string): string {
  try {
    const value = getComputedStyle(el).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface Particle {
  /** Casa e nuvem em coordenadas normalizadas [0,1] — escalam com o canvas. */
  home: Particle2;
  cloud: Particle2;
  pos: Particle2;
  vel: Particle2;
  r: number;
  phase: number;
  /** 0 = núcleo … 1 = ponta de membro: quem se solta primeiro no ocioso. */
  tip: number;
  /** Coesão efetiva neste quadro (alpha: a ponta solta fica mais tênue). */
  form: number;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

/** Fontes das ondas ao falar: boca/peito, em coordenadas normalizadas. */
const RIPPLE_SOURCES: readonly Particle2[] = [
  { x: 0.5, y: 0.19 },
  { x: 0.5, y: 0.4 },
];

const MAX_RIPPLES = 24;

export function JarvisParticleFigure({ status }: { status: VoiceUiStatus }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(0);
  const statusRef = useRef<VoiceUiStatus>(status);
  const motionRef = useRef<FigureMotion>(figureMotionForStatus(status));
  /** Movimento reduzido: não há loop, então o estado novo pede repintura. */
  const repaintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    statusRef.current = status;
    motionRef.current = figureMotionForStatus(status);
    repaintRef.current?.();
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom/teste sem canvas 2d: renderiza o nó, sem desenhar

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    // cssSize = tamanho de layout do canvas (o CSS dá aspect-ratio 1).
    let cssSize = canvas.clientWidth || canvas.clientHeight || 140;
    const applySize = () => {
      canvas.width = Math.round(cssSize * dpr);
      canvas.height = Math.round(cssSize * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Mexer em width/height zera TODO o estado do contexto, composição
      // inclusa: sem isto o resize voltava ao 'source-over' e a figura perdia
      // o brilho aditivo.
      ctx.globalCompositeOperation = 'lighter'; // acúmulo de brilho sobre fundo escuro
    };
    applySize();

    const accent = readToken(canvas, '--jarvis-particle', DEFAULT_ACCENT);
    const danger = readToken(canvas, '--jarvis-particle-error', DEFAULT_DANGER);

    const count = particleCountForSize(cssSize);
    const scatter = mulberry32(0xc0ffee);
    const particles: Particle[] = buildHumanSilhouette(count).map((p) => ({
      home: { x: p.x, y: p.y },
      cloud: { x: scatter(), y: scatter() },
      pos: { x: scatter() * cssSize, y: scatter() * cssSize },
      vel: { x: 0, y: 0 },
      r: 0.8 + scatter() * 1.5,
      phase: scatter() * Math.PI * 2,
      tip: p.tip,
      form: 0,
    }));

    const unsub = useVoiceStore.subscribe((s) => {
      levelRef.current = s.level;
    });

    // Cursor: ouvido em `window` (o canvas é pointer-events:none e o clique do
    // botão/alça de arraste do HUD nunca pode ser bloqueado). "Dentro" é
    // calculado pela geometria, então arrastar o HUD não deixa estado preso.
    const mouse = { x: 0, y: 0, inside: false };
    const smooth = { x: cssSize / 2, y: cssSize / 2, amt: 0 };
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.inside =
        mouse.x >= -rect.width * 0.25 &&
        mouse.x <= rect.width * 1.25 &&
        mouse.y >= -rect.height * 0.25 &&
        mouse.y <= rect.height * 1.25;
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    let form = cohesionForStatus(statusRef.current);
    let calm = figureMotionForStatus(statusRef.current).calm;
    let ripples: Ripple[] = [];
    let rippleAcc = 0;
    let rippleToggle = 0;
    let raf = 0;
    let running = false;
    let last = performance.now();
    // Valores por quadro que o pincel lê (física e desenho são separados).
    const frame = { level: 0, energy: 0, breath: 0 };

    /** Avança a física um quadro. Não toca no canvas. */
    const step = (now: number, dtMs: number) => {
      const motion = motionRef.current;
      const st = statusRef.current;
      const size = cssSize;
      const cx = size / 2;
      const cy = size / 2;
      const level = levelRef.current;
      const t = now * 0.001;

      // Alvo de coesão: no ocioso a forma respira (desfaz e refaz devagar).
      const target = st === 'idle' ? idleCohesion(t) : motion.cohesion;
      // Easing suave para formar/desfazer — o "fazendo e desfazendo" da figura.
      form = lerp(form, target, clamp(dtMs * 0.0045, 0, 1));
      calm = lerp(calm, motion.calm, clamp(dtMs * 0.004, 0, 1));

      const energy = st === 'speaking' ? speakingEnergy(level, t) : 0;
      frame.level = level;
      frame.energy = energy;
      frame.breath = form * motion.breathe * (0.35 + level * 0.65); // pulsa com a voz

      // Cursor com easing: entra/sai suave (amt → 0/1), posição perseguida.
      smooth.amt = lerp(smooth.amt, mouse.inside ? 1 : 0, clamp(dtMs * 0.006, 0, 1));
      smooth.x = lerp(smooth.x, mouse.inside ? mouse.x : cx, clamp(dtMs * 0.008, 0, 1));
      smooth.y = lerp(smooth.y, mouse.inside ? mouse.y : cy, clamp(dtMs * 0.008, 0, 1));
      const gaze = gazeOffset(cx, size * 0.155, smooth.x, smooth.y, size * 0.07);
      gaze.x *= smooth.amt;
      gaze.y *= smooth.amt;

      const wander = motion.wander * (1 - form * 0.75); // nuvem solta quando dissolvida

      for (const p of particles) {
        // Coesão efetiva: no ocioso cada ponto segue o ciclo da sua região
        // (as pontas se soltam mais); fora dele, a coesão global do estado.
        const pf = calm > 0.001 ? lerp(form, idleParticleCohesion(t, p.tip), calm) : form;
        p.form = pf;

        // Casa/nuvem normalizadas → px; repouso intermediado pela coesão.
        const rest = restPoint(p.home, p.cloud, pf, lerp(1, idleScatter(p.tip), calm));
        let restX = rest.x * size;
        let restY = rest.y * size;

        // Respiração coerente do corpo (peito sobe e abre).
        if (motion.breathe > 0) {
          const b = breathingOffset(p.home.x, p.home.y, t);
          restX += b.x * size * motion.breathe;
          restY += b.y * size * motion.breathe;
        }

        // Ouvindo: corpo inteiro puxado para dentro, mais com o nível do mic.
        if (motion.inward > 0) {
          const pull = motion.inward * (0.1 + level * 0.22);
          restX = lerp(restX, cx, pull);
          restY = lerp(restY, cy, pull);
        }

        // Cabeça/olhar acompanha o cursor; corpo inteiro tem parallax leve.
        const depth = 1 - p.home.y * 0.7; // cabeça (y≈0) mais que os pés
        if (smooth.amt > 0.01) {
          if (p.home.y < 0.25) {
            restX += gaze.x;
            restY += gaze.y * 0.6;
          }
          const par = parallaxOffset(smooth.x, smooth.y, cx, cy, size, size * 0.035, depth);
          restX += par.x * smooth.amt;
          restY += par.y * smooth.amt;
        }

        p.vel.x += (restX - p.pos.x) * 0.055;
        p.vel.y += (restY - p.pos.y) * 0.055;

        // Repulsão do cursor perto da partícula (só quando está dentro).
        if (mouse.inside) {
          const f = cursorForce(p.pos.x, p.pos.y, smooth.x, smooth.y, size * 0.3, 2.6);
          p.vel.x += f.x;
          p.vel.y += f.y;
        }

        // Órbita/vórtice ao redor do centro (pensando/roteando).
        if (motion.orbit > 0) {
          const rx = p.pos.x - cx;
          const ry = p.pos.y - cy;
          const rlen = Math.hypot(rx, ry) || 1;
          const spin = motion.orbit * 0.05;
          p.vel.x += (-ry / rlen) * spin;
          p.vel.y += (rx / rlen) * spin;
        }

        p.vel.x *= 0.86;
        p.vel.y *= 0.86;
        // A poeira das pontas soltas treme mais que o núcleo.
        const drift = wander * (1 + p.tip * 1.5 * calm);
        p.pos.x += p.vel.x + Math.sin(t * 0.8 + p.phase) * drift;
        p.pos.y += p.vel.y + Math.cos(t * 0.7 + p.phase) * drift;

        // Vibração: boca/torso quando fala (peso por zona), tremor no erro.
        const jitter =
          motion.jitter *
          (st === 'speaking' ? speakingZoneWeight(p.home.y) * (0.4 + energy) : 0.6);
        p.pos.x += Math.sin(t * 23 + p.phase * 7) * jitter * 0.5;
      }

      // Ondas ao falar: anéis que nascem na boca/peito, expandem e somem.
      if (running && motion.ripple > 0) {
        rippleAcc += motion.ripple * (0.5 + energy) * dtMs * 0.001;
        while (rippleAcc >= 1 && ripples.length < MAX_RIPPLES) {
          rippleAcc -= 1;
          const src = RIPPLE_SOURCES[rippleToggle++ % RIPPLE_SOURCES.length];
          ripples.push({
            x: cx + gaze.x,
            y: src.y * size + gaze.y,
            radius: size * 0.04,
            alpha: 0.5,
          });
        }
      }
      if (ripples.length > 0) {
        const next: Ripple[] = [];
        for (const rp of ripples) {
          rp.radius += size * 0.5 * dtMs * 0.001;
          rp.alpha -= dtMs * 0.0011;
          if (rp.alpha > 0) next.push(rp);
        }
        ripples = next;
      }
    };

    /** Pinta o estado atual das partículas no canvas. */
    const paint = () => {
      const size = cssSize;
      const color = statusRef.current === 'error' ? danger : accent;
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = color;
      for (const p of particles) {
        ctx.globalAlpha = clamp(0.28 + p.form * 0.38 + frame.level * 0.2 + frame.energy * 0.12, 0, 1);
        ctx.beginPath();
        ctx.arc(
          p.pos.x,
          p.pos.y,
          p.r * (0.85 + frame.breath * 0.35 + frame.energy * 0.25),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      if (ripples.length > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        for (const rp of ripples) {
          ctx.globalAlpha = rp.alpha;
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, rp.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };

    /**
     * Movimento reduzido: sem física nem relógio. As partículas vão direto à
     * posição de repouso (silhueta formada) e o quadro é pintado uma vez; só a
     * cor acompanha o estado (erro em `--danger`).
     */
    const paintStatic = () => {
      ripples = [];
      frame.level = 0;
      frame.energy = 0;
      frame.breath = 0;
      for (const p of particles) {
        p.form = 1;
        p.pos.x = p.home.x * cssSize;
        p.pos.y = p.home.y * cssSize;
        p.vel.x = 0;
        p.vel.y = 0;
      }
      paint();
    };

    const tick = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      step(now, dt);
      paint();
      raf = requestAnimationFrame(tick);
    };

    if (reduced) {
      repaintRef.current = paintStatic;
      paintStatic();
    } else {
      running = true;
      raf = requestAnimationFrame(tick);
    }

    // Custo de CPU: aba oculta pausa o loop (e zera o backlog de dt).
    const onVisibility = () => {
      if (reduced) return;
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // O tamanho do canvas é CSS (segue o container do HUD): reescala sem
    // re-scatter. Redimensionar apaga o canvas — sem loop, repinta na hora.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const next = canvas.clientWidth || canvas.clientHeight || cssSize;
        if (next === cssSize || next <= 0) return;
        const ratio = next / cssSize;
        cssSize = next;
        applySize();
        for (const p of particles) {
          p.pos.x *= ratio;
          p.pos.y *= ratio;
        }
        if (reduced) paintStatic();
      });
      ro.observe(canvas);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      repaintRef.current = null;
      unsub();
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      ro?.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="jarvis-particle-figure" aria-hidden="true" />;
}
