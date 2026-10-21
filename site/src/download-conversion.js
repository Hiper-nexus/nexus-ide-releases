// Ação 7860037868: secundária, ONE_PER_CLICK, valor zero BRL. Validada na conta 3066296016.
export const NEXUS_DOWNLOAD_SEND_TO = 'AW-953176375/G6imCOzR-qMdELeiwcYD';
// Mede intenção de baixar o NexusIDE; nunca representa instalação ou início de teste.
export function isNexusDownload(href, base) {
  let url;
  try { url = new URL(href, base); } catch { return false; }
  if (url.search || url.hash || url.username || url.password) return false;
  if (url.origin === 'https://nexuside.app') return /^\/download\/(macos|mac|windows|win|linux-deb|linux-rpm|linux-zip)$/.test(url.pathname);
  return url.origin === 'https://github.com'
    && /^\/Hiper-nexus\/nexus-ide-releases\/releases\/download\/v\d+\.\d+\.\d+\/(NexusIDE-[A-Za-z0-9._-]+\.(dmg|exe|zip)|nexus-ide[A-Za-z0-9._-]*\.(deb|rpm))$/.test(url.pathname);
}

export function initializeDownloadConversion({ win = window, doc = document, sendTo, canMeasure }) {
  // Sem ID/rótulo oficial dedicado ao Nexus, nenhum listener de conversão é instalado.
  if (!/^AW-953176375\/[A-Za-z0-9_-]+$/.test(sendTo || '') || typeof canMeasure !== 'function') return;
  if (win.__nexusDownloadConversion) return;
  win.__nexusDownloadConversion = true;
  doc.addEventListener('click', event => {
    if (!event.isTrusted || event.defaultPrevented || !canMeasure() || typeof win.gtag !== 'function') return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || !isNexusDownload(anchor.href, win.location.href)) return;
    // Mantém o link e o comportamento nativo, inclusive downloads em outra aba.
    // A entrega é best effort: falha do Google nunca bloqueia o instalador.
    try { win.gtag('event', 'conversion', { send_to: sendTo, value: 0, currency: 'BRL', transport_type: 'beacon' }); }
    catch { /* O download continua normalmente. */ }
  });
}
