import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, tokenPose, sparkleAt } from './token.js';

test('a ficha gira sempre para o mesmo lado e flutua dentro de uma faixa curta', () => {
  let last = -Infinity;
  for (let t = 0; t < 12; t += 0.25) {
    const pose = tokenPose(t, false);
    assert.ok(pose.spin > last, 'giro crescente');
    last = pose.spin;
    assert.ok(Math.abs(pose.y - TOKEN.y) <= TOKEN.bob + 1e-9, `altura ${pose.y}`);
  }
});

test('com redução de movimento a ficha para numa pose inclinada, que mostra a face da frente', () => {
  const a = tokenPose(0, true), b = tokenPose(37, true);
  assert.deepEqual(a, b);
  assert.equal(a.y, TOKEN.y);
  assert.ok(a.spin !== 0 && Math.abs(a.spin) < Math.PI / 2, 'face da frente visível, de lado');
});

test('que face está para a câmera: Claude e Codex se alternam a cada meia volta', () => {
  const faces = [0, Math.PI * 0.4, Math.PI * 1.1, Math.PI * 1.4, Math.PI * 2.2].map(spin => tokenPose(spin / TOKEN.spinRate, false).face);
  assert.deepEqual(faces, ['front', 'front', 'back', 'back', 'front']);
});

test('as faíscas orbitam perto da ficha, brilham e apagam em ciclo, sem alocar', () => {
  const out = { x: 0, y: 0, z: 0, scale: 0 };
  const seen = new Set();
  for (let i = 0; i < TOKEN.sparkles; i++) {
    for (let t = 0; t < 8; t += 0.4) {
      const spark = sparkleAt(i, t, false, out);
      assert.equal(spark, out, 'reaproveita o objeto de saída');
      assert.ok(Math.hypot(out.x, out.y * 0.8, out.z) <= TOKEN.sparkleRadius + 1e-9, `longe demais: ${out.x},${out.y},${out.z}`);
      assert.ok(out.scale >= 0 && out.scale <= 1, `escala ${out.scale}`);
      seen.add(out.scale > 0.5);
    }
  }
  assert.deepEqual([...seen].sort(), [false, true], 'há faíscas acesas e apagadas');
});

test('cada faísca tem a sua fase: no mesmo instante não piscam juntas', () => {
  const out = { x: 0, y: 0, z: 0, scale: 0 };
  const scales = Array.from({ length: TOKEN.sparkles }, (_, i) => sparkleAt(i, 3, false, out).scale);
  assert.ok(new Set(scales.map(s => s.toFixed(2))).size > TOKEN.sparkles / 2);
});

test('com redução de movimento as faíscas ficam paradas e discretas', () => {
  const out = { x: 0, y: 0, z: 0, scale: 0 };
  const first = Array.from({ length: TOKEN.sparkles }, (_, i) => ({ ...sparkleAt(i, 0, true, out) }));
  const later = Array.from({ length: TOKEN.sparkles }, (_, i) => ({ ...sparkleAt(i, 99, true, out) }));
  assert.deepEqual(first, later);
  assert.ok(first.every(spark => spark.scale > 0 && spark.scale <= 0.6));
});
