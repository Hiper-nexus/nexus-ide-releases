/** Menu do topo no celular: abre/fecha o mesmo `.nav-links` do desktop.
 * Puro o bastante para testar; o DOM entra por parâmetro. */

export function setMobileNavOpen(header, toggle, open) {
  const next = Boolean(open);
  header.classList.toggle('nav-open', next);
  toggle.setAttribute('aria-expanded', String(next));
  toggle.setAttribute('aria-label', next ? 'Fechar menu' : 'Abrir menu');
}

/** Liga o botão hamburger a um `<header class="nav">`. Sem botão, não faz nada. */
export function initMobileNav(root = document) {
  const header = root.querySelector('header.nav');
  const toggle = root.querySelector('.mobile-nav-toggle');
  const links = root.querySelector('.nav-links');
  if (!header || !toggle || !links) return null;

  if (!links.id) links.id = 'nav-menu';
  toggle.setAttribute('aria-controls', links.id);
  setMobileNavOpen(header, toggle, false);

  const close = () => setMobileNavOpen(header, toggle, false);
  toggle.addEventListener('click', () => {
    setMobileNavOpen(header, toggle, toggle.getAttribute('aria-expanded') !== 'true');
  });
  links.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', close));
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      close();
      toggle.focus();
    }
  });
  return { header, toggle, close };
}
