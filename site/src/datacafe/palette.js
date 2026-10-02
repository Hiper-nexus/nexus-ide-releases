/** Paleta do Data Café, derivada dos tokens do DESIGN.md (Pink City ao entardecer). */
export const PALETTE = {
  bg: 0x080709, bar: 0x0d0b0f, surface: 0x111013, lift: 0x201e25,
  ink: 0xfaf7f9, muted: 0xaaa2a8, pink: 0xff4f8b, dusk: 0xff6f91, ember: 0xffb27a,
  green: 0x7ee2a8, gold: 0xe5c07b, whatsapp: 0x25d366, red: 0xff4d4d,
  floor: 0x2b2731, floorLine: 0x3a3441, wall: 0x2a2330, wallDark: 0x1c1820, trim: 0xff4f8b,
  rack: 0x2a2631, rackEdge: 0x3d3745, door: 0x1f1c25, ledOff: 0x2c2830, ledOn: 0x7ee2a8,
  wood: 0x4a3432, woodTop: 0x6b4a44, steel: 0x9b939c, kraft: 0xc99a64,
  skin: 0xe8b8a0, hoodie: 0xff4f8b, hoodieDark: 0xd63a72, pants: 0x2a2433, shoe: 0xfaf7f9, hair: 0x2a1c1f,
  leaf: 0x5bb68f, leafDark: 0x3f8f6c, pot: 0x3a2f38,
};

export const hex = color => `#${color.toString(16).padStart(6, '0')}`;
