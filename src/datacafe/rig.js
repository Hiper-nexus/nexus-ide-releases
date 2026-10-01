/** Câmera do Data Café, estilo diorama: de cima e de trás do dev. Segue com suavização
 * independente da taxa de quadros, antecipa a direção da caminhada, aproxima ao interagir
 * e ao sentar, e sobe quando um rack ou parede ficaria entre ela e o dev.
 * Pura: o loop passa o estado e o mapa em dados (LAYOUT); nada aqui conhece o Three.js. */
import { obstacleHeight } from './layout.js';

export const RIG = {
  /** Distância da câmera ao ponto observado e elevação base (≈ 46°). */
  range: 10.9,
  pitch: 0.8,
  pitchMin: 0.62,
  /** O jogador inclina até aqui arrastando; acima disso só a câmera sobe, para ver o dev. */
  userPitchMax: 1.1,
  pitchMax: 1.38,
  yawMin: -0.7,
  yawMax: 0.7,
  zoomMin: 0.62,
  zoomMax: 1.45,
  lookHeight: 0.6,
  /** Taxas de aproximação por segundo: posição, e giro/elevação/distância. */
  follow: 5,
  turn: 6,
  /** Antecipação: olha `lead` segundos à frente da caminhada, até `leadMax`. */
  lead: 0.35,
  leadMax: 1.2,
  leadRate: 3,
  /** Folga da borda do salão, para a câmera não mostrar o vazio; ao sul a borda de baixo
   * da tela fica ~3,9 à frente do ponto observado, então a folga é maior. */
  margin: 4,
  southMargin: 3.6,
  /** O peito do dev: a câmera nunca perde esta altura de vista. */
  focusHeight: 0.85,
  clearance: 0.15,
  fov: 40,
  /** Perto de algo interativo: aproxima e desliza o olhar para o objeto. */
  approach: 0.86,
  approachShift: 0.35,
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const TAN_HALF_FOV = Math.tan(RIG.fov * Math.PI / 360);

export const clampYaw = yaw => clamp(yaw, RIG.yawMin, RIG.yawMax);
export const clampPitch = pitch => clamp(pitch, RIG.pitchMin, RIG.userPitchMax);
export const clampZoom = zoom => clamp(zoom, RIG.zoomMin, RIG.zoomMax);

/** Fração do caminho até o objetivo num passo de `dt`: exponencial, então 2 passos de
 * 1/60 s chegam ao mesmo lugar que 1 passo de 1/30 s. */
export function blendFor(rate, dt) {
  return 1 - Math.exp(-rate * clamp(dt, 0, 0.1));
}

/** Roda do mouse: para baixo afasta, para cima aproxima. */
export function wheelZoom(zoom, deltaY) {
  return clampZoom(zoom * Math.exp(deltaY * 0.0012));
}

/** Pinça: abrir os dedos aproxima. */
export function pinchZoom(startZoom, startDistance, distance) {
  return clampZoom(startZoom * startDistance / Math.max(1, distance));
}

/** Mantém o ponto observado dentro do salão, com margem. */
export function clampTarget(x, z, layout, out = { x: 0, z: 0 }) {
  const w = layout.width * layout.cellSize, h = layout.height * layout.cellSize;
  const mx = Math.min(RIG.margin, w / 2), mz = Math.min(RIG.margin * 0.6, h / 2);
  out.x = Math.max(mx, Math.min(w - mx, x));
  out.z = Math.max(mz, Math.min(h - Math.min(RIG.southMargin, h / 2), z));
  return out;
}

/** Puxa o ponto observado até o dev caber no quadro, mesmo numa tela estreita: vale mais
 * mostrar um pedaço de fora do salão do que perder o dev. */
export function keepInView(target, body, yaw, range, pitch, aspect, out = { x: 0, z: 0 }) {
  const halfWidth = range * TAN_HALF_FOV * aspect * 0.6;
  const halfDepth = range * TAN_HALF_FOV / Math.max(0.3, Math.sin(pitch)) * 0.55;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const dx = body.x - target.x, dz = body.z - target.z;
  const side = dx * rx + dz * rz, depth = dx * fx + dz * fz;
  const pushSide = side - clamp(side, -halfWidth, halfWidth);
  const pushDepth = depth - clamp(depth, -halfDepth, halfDepth);
  out.x = target.x + pushSide * rx + pushDepth * fx;
  out.z = target.z + pushSide * rz + pushDepth * fz;
  return out;
}

/** A linha do peito do dev até a câmera passa acima de tudo no caminho? Percorre as
 * células cruzadas no chão (DDA) e testa a altura da linha na borda de entrada de cada uma. */
function lineClear(layout, body, camX, camY, camZ) {
  const dx = camX - body.x, dz = camZ - body.z, flat = Math.hypot(dx, dz);
  if (flat < 1e-6) return true;
  const ux = dx / flat, uz = dz / flat, slope = (camY - RIG.focusHeight) / flat;
  let cx = Math.floor(body.x), cz = Math.floor(body.z);
  const stepX = ux > 0 ? 1 : -1, stepZ = uz > 0 ? 1 : -1;
  const deltaX = Math.abs(ux) < 1e-9 ? Infinity : Math.abs(1 / ux);
  const deltaZ = Math.abs(uz) < 1e-9 ? Infinity : Math.abs(1 / uz);
  let nextX = (ux > 0 ? cx + 1 - body.x : body.x - cx) * deltaX;
  let nextZ = (uz > 0 ? cz + 1 - body.z : body.z - cz) * deltaZ;
  for (;;) {
    let s;
    if (nextX < nextZ) { s = nextX; cx += stepX; nextX += deltaX; } else { s = nextZ; cz += stepZ; nextZ += deltaZ; }
    if (s > flat || cx < 0 || cz < 0 || cx >= layout.width || cz >= layout.height) return true;
    const height = obstacleHeight(layout, cx, cz);
    if (height > 0 && RIG.focusHeight + slope * s < height + RIG.clearance) return false;
  }
}

/** Menor elevação, a partir de `from`, em que nada fica entre a câmera e o peito do dev. */
export function occlusionPitch(layout, body, yaw, range, look = body, from = RIG.pitchMin) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  for (let pitch = from; pitch < RIG.pitchMax; pitch += 0.01) {
    const flat = range * Math.cos(pitch);
    if (lineClear(layout, body, look.x + flat * sin, RIG.lookHeight + range * Math.sin(pitch), look.z + flat * cos)) return pitch;
  }
  return RIG.pitchMax;
}

/** Sentado: por cima do ombro direito, com o dev à esquerda do monitor, perto o bastante
 * para o terminal ocupar a tela (quase toda a largura no celular). */
export function seatFraming(screen, aspect, out = {}) {
  out.range = clamp(0.95 / (2 * TAN_HALF_FOV * aspect), 2.1, 3.1);
  out.yaw = 0.72;
  out.pitch = 0.55;
  out.tx = screen.x;
  out.ty = screen.y;
  out.tz = screen.z;
  return out;
}

export function createCamera() {
  return { fresh: true, yaw: 0, pitch: RIG.pitch, range: RIG.range, lx: 0, lz: 0, x: 0, y: 0, z: 0, tx: 0, ty: RIG.lookHeight, tz: 0 };
}

const look = { x: 0, z: 0 };
const seen = { x: 0, z: 0 };
const framing = {};

/**
 * Um passo da câmera; `cam` (de createCamera) é atualizado no lugar e devolvido.
 * `input`: { playing, calm, aspect, body: {x, z, vx, vz}, yaw, pitch, zoom (o que o jogador
 * pediu), focus: {x, z} | null (algo interativo ao alcance), seat: { blend, screen } | null,
 * idle: {x, z} (para onde olhar antes de começar) }.
 */
export function cameraStep(cam, input, layout, dt) {
  const { body, playing, calm, aspect } = input;
  const instant = cam.fresh || calm;
  const base = playing ? (aspect < 0.9 ? 1.3 : 1) : (aspect < 0.9 ? 1.65 : 1.25);
  const near = Boolean(playing && input.focus && !calm);
  let yaw = clampYaw(input.yaw);
  let pitch = playing ? clampPitch(input.pitch) : RIG.pitch;
  let range = RIG.range * base * clampZoom(input.zoom) * (near ? RIG.approach : 1);

  // Antecipação da caminhada, suavizada para não tremer nas paradas.
  let leadX = playing && !calm ? body.vx * RIG.lead : 0, leadZ = playing && !calm ? body.vz * RIG.lead : 0;
  const length = Math.hypot(leadX, leadZ);
  if (length > RIG.leadMax) { leadX *= RIG.leadMax / length; leadZ *= RIG.leadMax / length; }
  const kLead = instant ? 1 : blendFor(RIG.leadRate, dt);
  cam.lx += (leadX - cam.lx) * kLead;
  cam.lz += (leadZ - cam.lz) * kLead;

  let ty = RIG.lookHeight;
  if (playing) {
    look.x = body.x + cam.lx;
    look.z = body.z + cam.lz;
    if (near) { look.x += (input.focus.x - look.x) * RIG.approachShift; look.z += (input.focus.z - look.z) * RIG.approachShift; }
    clampTarget(look.x, look.z, layout, look);
    // Enquadrar depende da elevação e a elevação depende do enquadramento: algumas voltas
    // convergem, e a última é a da elevação, que garante o dev à vista.
    const asked = pitch;
    for (let pass = 0; pass < 4; pass++) {
      keepInView(look, body, yaw, range, pitch, aspect, look);
      pitch = occlusionPitch(layout, body, yaw, range, look, asked);
    }
  } else {
    look.x = input.idle.x;
    look.z = input.idle.z;
  }
  let tx = look.x, tz = look.z;

  const blend = input.seat?.blend ?? 0;
  if (blend > 0) {
    seatFraming(input.seat.screen, aspect, framing);
    yaw += (framing.yaw - yaw) * blend;
    pitch += (framing.pitch - pitch) * blend;
    range += (framing.range - range) * blend;
    tx += (framing.tx - tx) * blend;
    ty += (framing.ty - ty) * blend;
    tz += (framing.tz - tz) * blend;
  }

  const kTurn = instant ? 1 : blendFor(RIG.turn, dt);
  const kFollow = instant ? 1 : blendFor(RIG.follow, dt);
  cam.yaw += (yaw - cam.yaw) * kTurn;
  cam.pitch += (pitch - cam.pitch) * kTurn;
  cam.range += (range - cam.range) * kTurn;
  cam.tx += (tx - cam.tx) * kFollow;
  cam.ty += (ty - cam.ty) * kFollow;
  cam.tz += (tz - cam.tz) * kFollow;
  cam.fresh = false;
  // A elevação segura acima vale para o destino; a câmera suavizada ainda está a caminho.
  // Subir é imediato, para o dev nunca sumir atrás de um rack; descer continua suave.
  if (playing && blend === 0) {
    seen.x = cam.tx;
    seen.z = cam.tz;
    cam.pitch = Math.max(cam.pitch, occlusionPitch(layout, body, cam.yaw, cam.range, seen, cam.pitch));
  }

  const flat = cam.range * Math.cos(cam.pitch);
  cam.x = cam.tx + flat * Math.sin(cam.yaw);
  cam.y = cam.ty + cam.range * Math.sin(cam.pitch);
  cam.z = cam.tz + flat * Math.cos(cam.yaw);
  // Nunca dentro de uma parede, rack ou mesa.
  cam.y = Math.max(cam.y, obstacleHeight(layout, Math.floor(cam.x), Math.floor(cam.z)) + 0.3);
  return cam;
}
