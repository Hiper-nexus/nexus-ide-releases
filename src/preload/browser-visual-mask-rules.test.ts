import { describe, expect, it } from 'vitest';
import { isMediaTag, isSensitiveVisualText, sensitiveBlockAncestor, shouldMaskMedia, type MaskBlockNode } from './browser-visual-mask-rules';

function node(tagName: string, parentElement: MaskBlockNode | null = null, childElementCount = 1): MaskBlockNode {
  return { tagName, parentElement, childElementCount };
}

describe('visual secret text detection', () => {
  it.each([
    'sk_live_51HabcdefghijKLMNOPQRstuv',
    'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
    'whsec_8b1fabcdefghijklmnopqrstuvwxyz12',
    'xoxb-1234567890-abcdefghijkl',
    'xapp-1-A0123456789-abcdefghijk',
    'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY12',
    'API key',
    'Token de acesso',
    'Webhook secret',
    'Bearer abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuv',
  ])('flags %s', text => { expect(isSensitiveVisualText(text)).toBe(true); });

  it.each([
    'Pedido confirmado com sucesso',
    'Total R$ 1.299,90',
    'Salvar alterações',
    '   ',
    '',
    'https://example.com/produtos/lista',
    'rootpage-Brasil skin-vector',
  ])('leaves %j visible', text => { expect(isSensitiveVisualText(text)).toBe(false); });

  it('fails closed on a giant text blob instead of scanning it', () => {
    expect(isSensitiveVisualText('palavra '.repeat(10_000))).toBe(true);
  });

  it('stays linear on a hostile unbroken run of word characters', () => {
    const started = performance.now();
    expect(isSensitiveVisualText('a'.repeat(40_000))).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('sensitive block ancestor', () => {
  it('hides the whole table row when a cell labels a secret', () => {
    const table = node('TABLE'); const row = node('TR', table, 2); const cell = node('TD', row);
    expect(sensitiveBlockAncestor(cell)).toBe(row);
    const bold = node('B', cell);
    expect(sensitiveBlockAncestor(bold)).toBe(row);
  });

  it('hides a definition pair through its list', () => {
    const list = node('DL', node('DIV'), 2);
    expect(sensitiveBlockAncestor(node('DT', list))).toBe(list);
    expect(sensitiveBlockAncestor(node('DD', list))).toBe(list);
  });

  it('keeps a list item whole and climbs out of inline wrappers', () => {
    const item = node('LI', node('UL', null, 9), 1);
    expect(sensitiveBlockAncestor(node('SPAN', node('A', item)))).toBe(item);
  });

  it('escalates a label/value block pair to its small row parent only', () => {
    const row = node('DIV', node('SECTION'), 2);
    expect(sensitiveBlockAncestor(node('DIV', row))).toBe(row);
    const crowded = node('DIV', node('SECTION'), 12);
    const label = node('P', crowded);
    expect(sensitiveBlockAncestor(label)).toBe(label);
  });

  it('never escalates into a broad page container', () => {
    const paragraph = node('P', node('ARTICLE', node('BODY'), 3));
    expect(sensitiveBlockAncestor(paragraph)).toBe(paragraph);
    const body = node('BODY');
    expect(sensitiveBlockAncestor(node('SPAN', body))).toBe(body);
  });

  it('returns null only when there is no element at all', () => {
    expect(sensitiveBlockAncestor(null)).toBeNull();
  });
});

describe('media masking policy', () => {
  it('recognizes embedded media case-insensitively and ignores icons', () => {
    for (const tag of ['img', 'SVG', 'video', 'picture', 'canvas', 'iframe']) expect(isMediaTag(tag)).toBe(true);
    expect(isMediaTag('DIV')).toBe(false);
    expect(shouldMaskMedia({ width: 300, height: 200 })).toBe(true);
    expect(shouldMaskMedia({ width: 16, height: 16 })).toBe(false);
    expect(shouldMaskMedia({ width: 8, height: 120 })).toBe(true);
  });
});
