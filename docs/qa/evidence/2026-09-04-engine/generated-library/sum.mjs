/**
 * Soma dois números.
 *
 * Aceita apenas números finitos. Para qualquer entrada inválida
 * (não-número, NaN, ±Infinity) lança TypeError.
 *
 * @param {number} a primeiro número
 * @param {number} b segundo número
 * @returns {number} a + b
 * @throws {TypeError} se a ou b não for um número finito
 */
export function sum(a, b) {
  const isValid = (value) =>
    typeof value === 'number' && Number.isFinite(value);

  if (!isValid(a) || !isValid(b)) {
    throw new TypeError('sum espera dois números finitos');
  }

  return a + b;
}
