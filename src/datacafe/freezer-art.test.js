import test from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_SIZE, PLAQUE_SIZE, CAN_SIZE, DOOR_SIZE, paintSign, paintPlaque, paintCan, paintDoor } from './freezer-art.js';

/** Contexto 2D de mentira que anota os textos desenhados. */
function recorder() {
  const log = [];
  const gradient = { addColorStop() {} };
  const state = {};
  const context = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'fillText') return (text, x, y) => log.push({ text, x, y });
      if (key === 'measureText') return text => ({ width: String(text).length * 10 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { context, log };
}
const shown = log => log.map(entry => entry.text);

test('o letreiro do freezer diz NEXUS+ em néon, sem prometer nada além do nome', () => {
  const { context, log } = recorder();
  paintSign(context, { width: SIGN_SIZE.width, height: SIGN_SIZE.height });
  assert.ok(shown(log).includes('NEXUS+'), shown(log).join('|'));
  assert.ok(!shown(log).some(text => /saúde|vitamina|performance|energia infinita|R\$|preço/i.test(text)));
});

test('a plaqueta do freezer só destaca o Nexus+ como o energético que dá energia, sem aviso nem promessa', () => {
  const { context, log } = recorder();
  paintPlaque(context, { width: PLAQUE_SIZE.width, height: PLAQUE_SIZE.height });
  const text = shown(log).join(' ');
  assert.match(text, /NEXUS\+/);
  assert.match(text, /ENERGÉTICO/);
  assert.match(text, /DÁ ENERGIA/);
  assert.doesNotMatch(text, /FICTÍCIA|SÓ NO JOGO|saúde|vitamina|performance|R\$|preço/i);
});

test('a lata leva o N+ no rótulo e a porta de vidro desenha a moldura sem texto algum', () => {
  const can = recorder();
  paintCan(can.context, { width: CAN_SIZE, height: CAN_SIZE });
  assert.ok(shown(can.log).includes('N+'));
  const door = recorder();
  paintDoor(door.context, { width: DOOR_SIZE.width, height: DOOR_SIZE.height });
  assert.deepEqual(door.log, []);
});
