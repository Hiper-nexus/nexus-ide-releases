import { useEffect, useRef } from 'react';
import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';

/**
 * JARVIS como humano de partículas — "forma e desfaz".
 *
 * Substitui o orb no modo expandido (ampliado) do HUD: em vez do disco de
 * anéis, um campo de partículas que coalesce num contorno humano quando a voz
 * está viva e se dissolve num vórtice solto em repouso. A amplitude real do mic
 * (`voice-store.level`) faz o corpo "respirar" — jitter proporcional ao volume.
 *
 * Geometria e física ficam em funções puras exportadas (`buildHumanSilhouette`,
 * `cohesionForStatus`): testáveis sem canvas. O desenho é um loop `rAF`
 * imperativo no próprio canvas (mesmo padrão do orb — sem re-render por frame).
 * `prefers-reduced-motion` pinta um único quadro estático e não anima.
 */

export interface Particle2 {
  x: number;
  y: number;
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
): Particle2 {
  const angle = rng() * Math.PI * 2;
  const radius = Math.sqrt(rng()) * r;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

/** Ponto num segmento-capsula (membro): linha central + offset perpendicular. */
function capsulePoint(
  rng: () => number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
): Particle2 {
  const t = rng();
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular à linha central; distribui a "carne" do membro.
  const off = (rng() * 2 - 1) * r;
  return {
    x: x1 + dx * t + (-dy / len) * off,
    y: y1 + dy * t + (dx / len) * off,
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
): Particle2 {
  const y = topY + (bottomY - topY) * rng();
  const progress = (y - topY) / (bottomY - topY);
  const half = topHalf + (bottomHalf - topHalf) * progress;
  return { x: cx + (rng() * 2 - 1) * half, y };
}

/**
 * Contorno humano em coordenadas normalizadas [0,1] (x: esquerda→direita,
 * y: topo→base). Cabeça + pescoço + tronco + dois braços + duas pernas.
 * Orçamento por região para a densidade ler como figura inteira, não varetas.
 */
export function buildHumanSilhouette(count: number, seed = 0x9e3779b9): Particle2[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const rng = mulberry32(seed);

  const head = Math.round(n * 0.14);
  const neck = Math.round(n * 0.04);
  const torso = Math.round(n * 0.28);
  const arms = Math.round(n * 0.16);
  const legs = n - head - neck - torso - arms;

  const pts: Particle2[] = [];
  for (let i = 0; i < head; i += 1) pts.push(circlePoint(rng, 0.5, 0.155, 0.09));
  for (let i = 0; i < neck; i += 1) pts.push(capsulePoint(rng, 0.5, 0.24, 0.5, 0.29, 0.028));
  for (let i = 0; i < torso; i += 1) pts.push(trapezoidPoint(rng, 0.5, 0.29, 0.52, 0.16, 0.14));

  const leftArm = Math.floor(arms / 2);
  for (let i = 0; i < leftArm; i += 1) pts.push(capsulePoint(rng, 0.35, 0.31, 0.3, 0.55, 0.026));
  for (let i = 0; i < arms - leftArm; i += 1) pts.push(capsulePoint(rng, 0.65, 0.31, 0.7, 0.55, 0.026));

  const leftLeg = Math.floor(legs / 2);
  for (let i = 0; i < leftLeg; i += 1) pts.push(capsulePoint(rng, 0.44, 0.52, 0.43, 0.96, 0.042));
  for (let i = 0; i < legs - leftLeg; i += 1) pts.push(capsulePoint(rng, 0.56, 0.52, 0.57, 0.96, 0.042));

  return pts;
}

/**
 * Quanto o humano está "formado" (0 = dissolvido, 1 = inteiro) para cada fase
 * do pipeline. Repouso é vórtice solto; falando/ouvindo é corpo inteiro.
 */
export function cohesionForStatus(status: VoiceUiStatus): number {
  switch (status) {
    case 'listening':
    case 'speaking':
      return 1;
    case 'transcribing':
      return 0.62;
    case 'routing':
      return 0.5;
    case 'error':
      return 0.2;
    case 'idle':
      return 0;
  }
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

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface Particle {
  home: Particle2;
  cloud: Particle2;
  pos: Particle2;
  vel: Particle2;
  r: number;
  phase: number;
}

export function JarvisParticleFigure({ status }: { status: VoiceUiStatus }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(0);
  const formTargetRef = useRef(cohesionForStatus(status));
  const isErrorRef = useRef(status === 'error');

  useEffect(() => {
    formTargetRef.current = cohesionForStatus(status);
    isErrorRef.current = status === 'error';
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom/teste sem canvas 2d: renderiza o nó, sem desenhar

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    // cssW/cssH = tamanho de layout do canvas (o CSS dá aspect-ratio 1).
    const cssSize = canvas.clientWidth || canvas.clientHeight || 140;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);

    const accent = readToken(canvas, '--jarvis-particle', DEFAULT_ACCENT);
    const danger = readToken(canvas, '--jarvis-particle-error', DEFAULT_DANGER);

    const count = Math.round(clamp((cssSize * cssSize) / 85, 120, 360));
    const scatter = mulberry32(0xc0ffee);
    const particles: Particle[] = buildHumanSilhouette(count).map((p) => ({
      home: { x: p.x * cssSize, y: p.y * cssSize },
      cloud: { x: scatter() * cssSize, y: scatter() * cssSize },
      pos: { x: scatter() * cssSize, y: scatter() * cssSize },
      vel: { x: 0, y: 0 },
      r: 0.8 + scatter() * 1.5,
      phase: scatter() * Math.PI * 2,
    }));

    const unsub = useVoiceStore.subscribe((s) => {
      levelRef.current = s.level;
    });

    ctx.scale(dpr, dpr);
    ctx.globalCompositeOperation = 'lighter'; // acúmulo de brilho sobre fundo escuro

    let form = cohesionForStatus(status);
    let raf = 0;
    let last = performance.now();

    const draw = (now: number, dtMs: number) => {
      const target = formTargetRef.current;
      // Easing suave para formar/desfazer — o "fazendo e desfazendo" da figura.
      form = lerp(form, target, clamp(dtMs * 0.0045, 0, 1));
      const level = levelRef.current;
      const error = isErrorRef.current;
      const color = error ? danger : accent;

      ctx.clearRect(0, 0, cssSize, cssSize);
      const t = now * 0.001;
      const breath = form * level; // o corpo "respira" com o volume da voz

      for (const p of particles) {
        const restX = lerp(p.cloud.x, p.home.x, form);
        const restY = lerp(p.cloud.y, p.home.y, form);
        p.vel.x += (restX - p.pos.x) * 0.055;
        p.vel.y += (restY - p.pos.y) * 0.055;
        p.vel.x *= 0.86;
        p.vel.y *= 0.86;
        const wander = (1 - form) * 0.34; // vórtice solto em repouso
        p.pos.x += p.vel.x + Math.sin(t * 0.8 + p.phase) * wander;
        p.pos.y +=
          p.vel.y +
          Math.cos(t * 0.7 + p.phase) * wander +
          Math.sin(t * 3.1 + p.phase) * breath * 0.6;

        ctx.globalAlpha = clamp(0.28 + form * 0.38 + level * 0.2, 0, 1);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.pos.x, p.pos.y, p.r * (0.85 + breath * 0.35), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    if (reduced) {
      // Sem animação: um único quadro do estado de repouso-alvo da figura.
      draw(performance.now(), 16);
    } else {
      const step = (now: number) => {
        const dt = Math.min(50, now - last);
        last = now;
        draw(now, dt);
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
  }, [status]);

  return <canvas ref={canvasRef} className="jarvis-particle-figure" aria-hidden="true" />;
}
