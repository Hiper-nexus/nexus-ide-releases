// Tag base validada na conta 3066296016. Nenhum rótulo de conversão é usado aqui.
export const GOOGLE_ADS_ID = 'AW-953176375';
export const CONSENT_KEY = 'nexus-ads-consent-v1';
const MAX_AGE = 180 * 24 * 60 * 60 * 1000;
const DENIED = { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };

export function initializeAdsConsent(win = window, doc = document) {
  // A conta, o admin, a comunidade e os previews não carregam publicidade.
  if (win.location.hostname !== 'nexuside.app' || win.location.protocol !== 'https:' || win.location.pathname !== '/') return;
  if (win.__nexusAdsConsent) return win.__nexusAdsConsent;
  const panel = doc.getElementById('ads-consent');
  const preferences = doc.getElementById('ads-preferences');
  if (!panel || !preferences) return;
  let loaded = false;
  let choice = null;
  try {
    const saved = JSON.parse(win.localStorage.getItem(CONSENT_KEY));
    if (['granted', 'denied'].includes(saved?.choice) && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) choice = saved.choice;
  } catch { /* Sem armazenamento ou escolha válida, nenhum recurso Google carrega. */ }
  if (new URLSearchParams(win.location.search).get('privacy') === 'denied') choice = 'denied';

  function loadTag() {
    // Não expor parâmetros potencialmente privados da página de origem ao código de terceiros.
    if (loaded || /[?#]/.test(doc.referrer || '')) return;
    loaded = true;
    // A tag Google compartilhada também contém este destino GA4. Não o ativar no Nexus.
    win['ga-disable-G-VJFB612907'] = true;
    win.dataLayer = win.dataLayer || [];
    win.gtag = win.gtag || function () { win.dataLayer.push(arguments); };
    // Consent Mode básico: estes comandos só são processados após o aceite.
    win.gtag('consent', 'default', { ...DENIED });
    win.gtag('consent', 'update', { ...DENIED, ad_storage: 'granted' });
    // Opt-out por página documentado pelo Google: impede a coleta automática de dados fornecidos pelo usuário.
    win.gtag('set', 'user_data', null);
    win.gtag('set', 'allow_enhanced_conversions', false);
    win.gtag('set', 'allow_google_signals', false);
    win.gtag('set', 'allow_ad_personalization_signals', false);
    win.gtag('set', 'ads_data_redaction', true);
    win.gtag('set', 'url_passthrough', false);
    win.gtag('js', new Date());
    win.gtag('config', GOOGLE_ADS_ID, {
      allow_enhanced_conversions: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: 'https://nexuside.app/',
      page_referrer: 'https://nexuside.app/',
      page_title: 'NexusIDE',
    });
    // Reutiliza o loader caso outro módulo já tenha instalado gtag.js.
    if (!doc.querySelector('script[src^="https://www.googletagmanager.com/gtag/js"]')) {
      const script = doc.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
      doc.head.append(script);
    }
  }

  function save(next) {
    choice = next;
    let persisted = false;
    try { win.localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice, expiresAt: Date.now() + MAX_AGE })); persisted = true; }
    catch { /* A escolha continua válida somente nesta página. */ }
    panel.hidden = true;
    preferences.focus();
    if (choice === 'granted') loadTag();
    // A nova página nasce sem o loader e sem pings de consentimento recusado.
    else if (loaded) {
      if (persisted) win.location.reload();
      else win.location.replace('https://nexuside.app/?privacy=denied');
    }
  }

  preferences.hidden = false;
  preferences.addEventListener('click', () => {
    panel.hidden = false;
    doc.getElementById('ads-reject').focus();
  });
  doc.getElementById('ads-accept').addEventListener('click', () => save('granted'));
  doc.getElementById('ads-reject').addEventListener('click', () => save('denied'));
  panel.hidden = choice !== null;
  if (choice === 'granted') loadTag();
  win.__nexusAdsConsent = { revoke: () => save('denied') };
  // Revogação em outra aba também interrompe a tag nesta página.
  win.addEventListener('storage', event => {
    if (loaded && (event.key === CONSENT_KEY || event.key === null)) win.location.reload();
  });
  return win.__nexusAdsConsent;
}
