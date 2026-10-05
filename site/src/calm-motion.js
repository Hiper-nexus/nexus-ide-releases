/** Movimento calmo. No Linux desktop (Omarchy/Hyprland, tela fracionária, 165 Hz) o letreiro do
 * sorteio, as partículas e o piso 3D do topo rolavam em camadas enormes e apareciam tremidos e
 * duplicados em 3 ou 4 cópias. Lá a página nasce no mesmo estilo de "Reduzir movimento": faixa parada,
 * sem partículas, sem flutuação e sem inclinação sob o ponteiro. Quem quiser tudo animado entra com
 * `?movimento=total` (a escolha fica salva); `?movimento=calmo` faz o contrário. Mac e Windows não mudam. */
export const CALM_CLASS = 'calm-motion';
export const MOTION_STORAGE_KEY = 'nexus-movimento';

const linuxDesktop = (userAgent, platform) =>
  /Linux|X11/i.test(`${platform} ${userAgent}`) && !/Android|CrOS/i.test(userAgent);

/** Puro: decide pelo pedido na URL, pela escolha salva, por "Reduzir movimento" e pelo sistema. */
export function shouldCalm({ userAgent = '', platform = '', search = '', stored = null, reducedMotion = false } = {}) {
  const asked = new URLSearchParams(search).get('movimento');
  if (asked === 'total') return reducedMotion;
  if (asked === 'calmo') return true;
  if (reducedMotion) return true;
  if (stored === 'total') return false;
  if (stored === 'calmo') return true;
  return linuxDesktop(userAgent, platform);
}

/** Lê o ambiente, marca o <html> e guarda o pedido explícito. Nunca lança. */
export function applyCalmMotion(win = globalThis.window) {
  try {
    const nav = win.navigator || {};
    let stored = null;
    try { stored = win.localStorage.getItem(MOTION_STORAGE_KEY); } catch { /* sem armazenamento */ }
    const search = win.location?.search || '';
    const calm = shouldCalm({
      userAgent: nav.userAgent || '',
      platform: nav.platform || '',
      search,
      stored,
      reducedMotion: Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
    });
    win.document.documentElement.classList.toggle(CALM_CLASS, calm);
    const asked = new URLSearchParams(search).get('movimento');
    if (asked === 'total' || asked === 'calmo') {
      try { win.localStorage.setItem(MOTION_STORAGE_KEY, asked); } catch { /* sem armazenamento */ }
    }
    return calm;
  } catch {
    return false;
  }
}

export const isCalmMotion = (doc = globalThis.document) => Boolean(doc?.documentElement?.classList.contains(CALM_CLASS));
