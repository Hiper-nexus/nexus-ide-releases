/** O freezer do Nexus+ em 3D: gabinete de duas células na parede norte, prateleiras com as latas
 * (uma por unidade do estoque), portas de vidro que abrem enquanto a ação é segurada, letreiro
 * de néon frio e um LED que diz se dá para beber agora. O Nexus+ é uma marca fictícia, só do
 * jogo: a plaqueta da frente diz isso. Tudo que repete é InstancedMesh e o descarte é do kit. */
import { AdditiveBlending, CylinderGeometry, DoubleSide, Group, MeshBasicMaterial, PlaneGeometry } from 'three';
import { PALETTE } from './palette.js';
import { DRINK } from './energy-drink.js';
import { SIGN_SIZE, PLAQUE_SIZE, CAN_SIZE, DOOR_SIZE, paintSign, paintPlaque, paintCan, paintDoor } from './freezer-art.js';

const STATUS_COLORS = Object.freeze({ ready: 0x7ee2a8, cooling: 0xffb27a, empty: 0xff4d4d });
const COLUMNS = 4;
const SHELF_Y = [0.3, 0.74, 1.18, 1.62];
/** Onde a frente de vidro fica: na borda da célula, para não invadir o corredor. */
const FRONT = 2.0;
const CAN = { radius: 0.07, height: 0.17 };
const OPEN_ANGLE = 1.15;
const OPEN_RATE = 8;

export function buildFreezer(kit, root, spec) {
  const cx = spec.x + spec.width / 2;
  const width = spec.width - 0.08;
  const body = kit.mat(0x23212b, { roughness: 0.6, metalness: 0.3 });
  const steel = kit.mat(PALETTE.steel, { metalness: 0.6, roughness: 0.35 });

  // Gabinete, jambas da frente e rodapé.
  kit.box(root, [width, 1.96, 0.8], [cx, 0.98, 1.46], body, { receive: false });
  kit.instanced(root, kit.boxGeo(0.08, 1.96, 0.14), body, [-1, 1], (d, side) => d.position.set(cx + side * (width / 2 - 0.04), 0.98, FRONT - 0.07), { cast: false, receive: false });
  kit.box(root, [width, 0.2, 0.14], [cx, 0.1, FRONT - 0.07], body, { cast: false, receive: false });

  // Interior aceso e prateleiras.
  kit.mesh(root, kit.geo('freezerlit', () => new PlaneGeometry(width - 0.2, 1.6)), kit.own(new MeshBasicMaterial({ color: 0xcdeeff, toneMapped: false })), [cx, 1.0, 1.866], { cast: false, receive: false });
  kit.instanced(root, kit.boxGeo(width - 0.24, 0.03, 0.15), steel, SHELF_Y, (d, y) => d.position.set(cx, y, FRONT - 0.065), { cast: false, receive: false });

  // Latas: uma por unidade do estoque, da prateleira de baixo para a de cima.
  const slots = Array.from({ length: DRINK.stockMax }, (_, i) => ({
    x: cx + ((i % COLUMNS) - (COLUMNS - 1) / 2) * 0.4,
    y: SHELF_Y[Math.floor(i / COLUMNS)] + 0.015 + CAN.height / 2,
    z: FRONT - 0.065,
  }));
  const canTex = kit.canvasTexture(CAN_SIZE, CAN_SIZE, paintCan);
  const canMat = kit.own(kit.mat(0xffffff, { emissive: PALETTE.pink, emissiveIntensity: 0.16 }).clone());
  canMat.map = canTex.texture;
  const canBodies = kit.instanced(root, kit.geo('can', () => new CylinderGeometry(CAN.radius, CAN.radius, CAN.height, 12)), canMat, slots, (d, s) => d.position.set(s.x, s.y, s.z), { cast: false, receive: false });
  const canLids = kit.instanced(root, kit.geo('canlid', () => new CylinderGeometry(CAN.radius * 0.84, CAN.radius * 0.84, 0.02, 12)), steel, slots, (d, s) => d.position.set(s.x, s.y + CAN.height / 2 + 0.01, s.z), { cast: false, receive: false });

  // Portas de vidro: cada uma gira na dobradiça da ponta de fora.
  const doorTex = kit.canvasTexture(DOOR_SIZE.width, DOOR_SIZE.height, paintDoor);
  const doorMat = kit.own(new MeshBasicMaterial({ map: doorTex.texture, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false }));
  const doorGeo = kit.geo('freezerdoor', () => new PlaneGeometry(0.88, 1.64));
  const hinges = [-1, 1].map(side => {
    const hinge = new Group();
    hinge.position.set(cx + side * (width / 2 - 0.02), 1.0, FRONT - 0.01);
    root.add(hinge);
    const pane = kit.mesh(hinge, doorGeo, doorMat, [-side * 0.44, 0, 0], { cast: false, receive: false });
    pane.scale.x = side;
    pane.renderOrder = 2;
    return hinge;
  });

  // Faixa fria no alto, LED de estado, letreiro e plaqueta.
  kit.box(root, [width - 0.1, 0.04, 0.04], [cx, 1.88, FRONT - 0.01], kit.mat(0xcfefff, { basic: true }), { cast: false, receive: false });
  const ledMat = kit.own(new MeshBasicMaterial({ color: STATUS_COLORS.ready, toneMapped: false }));
  kit.mesh(root, kit.boxGeo(0.07, 0.07, 0.03), ledMat, [cx + width / 2 - 0.2, 1.88, FRONT + 0.012], { cast: false, receive: false });
  const signTex = kit.canvasTexture(SIGN_SIZE.width, SIGN_SIZE.height, paintSign);
  const sign = kit.mesh(root, kit.geo('freezersign', () => new PlaneGeometry(1.7, 0.425)), kit.own(new MeshBasicMaterial({ map: signTex.texture, transparent: true, toneMapped: false, depthWrite: false })), [cx, 2.36, 1.03], { cast: false, receive: false });
  sign.renderOrder = 2;
  const plaqueTex = kit.canvasTexture(PLAQUE_SIZE.width, PLAQUE_SIZE.height, paintPlaque);
  kit.mesh(root, kit.geo('freezerplaque', () => new PlaneGeometry(1.7, 0.2125)), kit.own(new MeshBasicMaterial({ map: plaqueTex.texture, toneMapped: false })), [cx, 0.105, FRONT + 0.003], { cast: false, receive: false });

  // O frio que escorre pelo piso, na frente das portas.
  const spill = kit.mesh(root, kit.geo('freezerspill', () => new PlaneGeometry(width, 1.1)), kit.own(new MeshBasicMaterial({ color: 0x8fe9ff, transparent: true, opacity: 0.1, depthWrite: false, blending: AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, toneMapped: false })), [cx, 0.012, FRONT + 0.55], { cast: false, receive: false });
  spill.rotation.x = -Math.PI / 2;

  let target = 0, open = 0;
  canBodies.count = canLids.count = DRINK.stockStart;
  const applyDoor = () => { hinges[0].rotation.y = -open * OPEN_ANGLE; hinges[1].rotation.y = open * OPEN_ANGLE; };

  return {
    x: cx,
    front: FRONT,
    max: DRINK.stockMax,
    cans: () => canBodies.count,
    /** Mostra exatamente `value` latas (0 a 12); valor inválido vale 0. */
    setStock(value) {
      const count = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(DRINK.stockMax, Math.floor(value))) : 0;
      canBodies.count = canLids.count = count;
    },
    /** 'ready' (verde), 'cooling' (âmbar) ou 'empty' (vermelho). */
    setStatus(status) {
      if (!(status in STATUS_COLORS)) throw new Error(`estado de freezer inválido: ${status}`);
      ledMat.color.setHex(STATUS_COLORS[status]);
    },
    setDoor(value) { target = value ? 1 : 0; },
    doorOpen: () => open,
    /** A porta anda até o alvo; com redução de movimento ela vai de uma vez. */
    update(dt, calm) {
      if (open === target) return;
      open = calm || Math.abs(target - open) < 0.004 ? target : open + (target - open) * Math.min(1, OPEN_RATE * dt);
      applyDoor();
    },
  };
}
