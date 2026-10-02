import { DRAW, drawFrame } from './draw.js';

/** O letreiro do ganhador gira só enquanto está na tela; com redução de movimento fica na frase. */
export function startDrawSign(sign) {
  if (!sign || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const phrase = sign.textContent;
  let timer = 0;
  const spin = () => {
    const began = performance.now();
    const frame = () => {
      const progress = (performance.now() - began) / DRAW.spin;
      sign.textContent = drawFrame(phrase, progress);
      timer = setTimeout(progress < 1 ? frame : spin, progress < 1 ? DRAW.tick : DRAW.hold);
    };
    frame();
  };
  new IntersectionObserver(([entry]) => {
    clearTimeout(timer);
    if (entry.isIntersecting) spin(); else sign.textContent = phrase;
  }, { threshold: 0.6 }).observe(sign);
}
