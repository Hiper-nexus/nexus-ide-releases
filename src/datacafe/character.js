/** O dev: low-poly, moletom rosa com capuz, óculos e a caneca no cinto.
 * Animação procedural (sem esqueleto): pernas e braços por seno da passada,
 * caixa de GPU nas mãos quando carrega, ombros caídos e bocejo quando cansado,
 * pose sentada com as mãos no teclado.
 *
 * Nenhuma face pode dividir o plano com outra de cor diferente (z-fighting), e a
 * caneca fica abaixo do alcance dos braços: o art.test.js verifica as duas regras. */
import { CylinderGeometry, Group } from 'three';
import { PALETTE } from './palette.js';

const STRIDE = 7.5;
const TYPE_RATE = 14;

export function createDev(kit, { palette = PALETTE } = {}) {
  const root = new Group();
  root.name = 'dev';
  const body = new Group();
  root.add(body);

  const skin = kit.mat(palette.skin);
  const hoodie = kit.mat(palette.hoodie, { roughness: 0.9 });
  const hoodieDark = kit.mat(palette.hoodieDark, { roughness: 0.9 });
  const pants = kit.mat(palette.pants);
  const shoe = kit.mat(palette.shoe);
  const hair = kit.mat(palette.hair);
  const glass = kit.mat(0x141217, { roughness: 0.3, metalness: 0.4 });
  const mugMat = kit.mat(palette.ink);

  // Pernas com pivô no quadril.
  const legs = [-0.09, 0.09].map(x => {
    const pivot = new Group();
    pivot.position.set(x, 0.46, 0);
    kit.box(pivot, [0.13, 0.4, 0.15], [0, -0.2, 0], pants);
    kit.box(pivot, [0.15, 0.08, 0.24], [0, -0.42, 0.04], shoe);
    body.add(pivot);
    return pivot;
  });

  const torso = new Group();
  torso.position.set(0, 0.46, 0);
  body.add(torso);
  kit.box(torso, [0.42, 0.44, 0.26], [0, 0.23, 0], hoodie);
  kit.box(torso, [0.44, 0.06, 0.28], [0, 0.02, 0], hoodieDark); // barra do moletom
  kit.box(torso, [0.2, 0.1, 0.02], [0, 0.14, 0.135], hoodieDark); // bolso canguru
  kit.box(torso, [0.34, 0.18, 0.1], [0, 0.44, -0.14], hoodieDark); // capuz nas costas, mais largo que a cabeça
  // Caneca pendurada no cinto, abaixo do ponto mais baixo que a mão alcança.
  const mug = kit.mesh(torso, kit.geo('mug', () => new CylinderGeometry(0.055, 0.05, 0.11, 10)), mugMat, [0.24, -0.09, 0.02]);
  kit.box(mug, [0.02, 0.05, 0.04], [0.06, 0, 0], mugMat, { cast: false });

  // Braços com pivô no ombro.
  const arms = [-0.27, 0.27].map(x => {
    const pivot = new Group();
    pivot.position.set(x, 0.42, 0);
    kit.box(pivot, [0.12, 0.38, 0.14], [0, -0.18, 0], hoodie);
    kit.box(pivot, [0.1, 0.08, 0.1], [0, -0.4, 0], skin);
    torso.add(pivot);
    return pivot;
  });

  const head = new Group();
  head.position.set(0, 0.5, 0.01);
  torso.add(head);
  kit.box(head, [0.3, 0.3, 0.28], [0, 0.17, 0], skin);
  kit.box(head, [0.32, 0.1, 0.3], [0, 0.34, -0.005], hair); // franja 5 mm à frente da testa
  kit.box(head, [0.32, 0.16, 0.06], [0, 0.23, -0.14], hair);
  kit.box(head, [0.1, 0.06, 0.02], [-0.07, 0.19, 0.145], glass, { cast: false });
  kit.box(head, [0.1, 0.06, 0.02], [0.07, 0.19, 0.145], glass, { cast: false });
  kit.box(head, [0.06, 0.015, 0.02], [0, 0.2, 0.145], glass, { cast: false });
  const mouth = kit.box(head, [0.07, 0.02, 0.01], [0, 0.09, 0.142], kit.mat(0x6b2a36), { cast: false });

  // Caixa de GPU, visível só quando carrega.
  const crate = new Group();
  crate.position.set(0, 0.2, 0.3);
  kit.box(crate, [0.46, 0.3, 0.34], [0, 0, 0], kit.mat(palette.kraft));
  kit.box(crate, [0.47, 0.06, 0.35], [0, 0.04, 0], kit.mat(palette.pink, { emissive: palette.pink, emissiveIntensity: 0.35 }));
  crate.visible = false;
  torso.add(crate);

  let phase = 0, yawn = 0, yawnClock = 0, lean = 0, droop = 0, typeClock = 0;
  const mix = (a, b, k) => a + (b - a) * k;

  /** `seat` vai de 0 (de pé) a 1 (sentado); `typing` mexe as mãos no teclado. */
  function setMotion({ speed = 0, heading = 0, carrying = false, tired = false, calm = false, seat = 0, typing = false }, dt) {
    const step = Math.min(dt, 0.05);
    root.rotation.y = heading;
    const moving = Math.min(1, speed / 3.4) * (1 - seat);
    phase += speed * STRIDE * step * (tired ? 0.8 : 1);
    const swing = calm ? moving * 0.35 : moving * 0.7;
    const s = Math.sin(phase);
    legs[0].rotation.x = mix(s * swing, -Math.PI / 2, seat);
    legs[1].rotation.x = mix(-s * swing, -Math.PI / 2, seat);
    lean += ((calm ? 0 : moving * 0.12) - lean) * Math.min(1, 8 * step);
    droop += ((tired ? 1 : 0) - droop) * Math.min(1, 3 * step);
    torso.rotation.x = lean + droop * 0.1 + seat * 0.06;
    body.position.y = calm ? 0 : Math.abs(Math.cos(phase)) * 0.04 * moving;
    if (carrying) {
      arms[0].rotation.x = arms[1].rotation.x = -1.25;
      arms[0].rotation.z = 0.18; arms[1].rotation.z = -0.18;
    } else {
      typeClock += typing && !calm ? step * TYPE_RATE : 0;
      const tap = typing && !calm ? Math.sin(typeClock) * 0.07 : 0;
      arms[0].rotation.x = mix(-s * swing * 0.9 + droop * 0.15, -1 + tap, seat);
      arms[1].rotation.x = mix(s * swing * 0.9 + droop * 0.15, -1 - tap, seat);
      arms[0].rotation.z = mix(-0.06 - droop * 0.05, 0.15, seat); arms[1].rotation.z = mix(0.06 + droop * 0.05, -0.15, seat);
    }
    crate.visible = carrying;
    // Bocejo lento a cada ~5 s quando cansado e parado.
    yawnClock += step;
    if (tired && moving < 0.2 && !calm && yawnClock > 5) { yawn = 1; yawnClock = 0; }
    yawn = Math.max(0, yawn - step * 0.6);
    const open = Math.sin(Math.min(1, yawn) * Math.PI);
    head.rotation.x = droop * 0.18 - open * 0.35 + seat * 0.15;
    mouth.scale.y = 1 + open * 4;
  }

  return { group: root, setMotion, parts: { crate, head, torso, mug, arms, legs } };
}
