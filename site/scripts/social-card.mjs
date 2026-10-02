import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#080709"/>
<rect x="48" y="48" width="48" height="48" rx="8" fill="#ff4f8b"/>
<text x="62" y="84" font-family="VT323" font-size="44" fill="#080709">N</text>
<text x="112" y="84" font-family="sans-serif" font-size="32" font-weight="600" fill="#faf7f9">nexus / dev café</text>
<text x="48" y="180" font-family="sans-serif" font-size="16" letter-spacing="3" fill="#aaa2a8">CÓDIGO. CAFÉ. COMUNIDADE.</text>
<text x="48" y="274" font-family="sans-serif" font-size="72" font-weight="600" fill="#faf7f9">Código quente.</text>
<text x="48" y="360" font-family="sans-serif" font-size="72" font-weight="600" fill="#faf7f9">Ideias fora da</text>
<text x="515" y="365" font-family="VT323" font-size="96" fill="#ff4f8b">curva.</text>
<rect x="48" y="426" width="320" height="62" rx="8" fill="#faf7f9"/>
<text x="78" y="466" font-family="sans-serif" font-size="24" font-weight="600" fill="#080709">&gt;_ Entrar no grupo ↗</text>
<text x="48" y="558" font-family="sans-serif" font-size="20" fill="#aaa2a8">Claude 20x por 1 mês + Codex 20x · sorteio no grupo</text>
<g transform="translate(860 235)"><rect x="0" y="60" width="210" height="140" rx="12" fill="#201e25" stroke="#aaa2a8" stroke-width="2"/>
<rect x="30" y="20" width="145" height="140" rx="10" fill="#ff4f8b"/><rect x="48" y="50" width="110" height="62" rx="4" fill="#080709"/>
<rect x="63" y="69" width="20" height="16" fill="#7ee2a8"/><rect x="121" y="69" width="20" height="16" fill="#7ee2a8"/>
<rect x="99" y="-14" width="7" height="38" fill="#aaa2a8"/><circle cx="102" cy="-22" r="12" fill="#ff4f8b"/>
<rect x="-17" y="165" width="48" height="55" rx="8" fill="#aaa2a8"/><rect x="177" y="165" width="48" height="55" rx="8" fill="#aaa2a8"/>
<rect x="35" y="174" width="140" height="7" fill="#faf7f9"/></g>
<path d="M48 595h1104" stroke="#201e25"/>
</svg>`;
const renderer = new Resvg(svg, { font: { loadSystemFonts: true, fontFiles: ['public/fonts/VT323-Regular.ttf'] } });
writeFileSync('public/og.png', renderer.render().asPng());

const productSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#080709"/><rect x="48" y="48" width="48" height="48" rx="8" fill="#ff4f8b"/><text x="63" y="86" fill="#080709" font-family="VT323" font-size="44">N</text><text x="114" y="83" fill="#faf7f9" font-family="Inter" font-size="30">nexus IDE</text><text x="48" y="260" fill="#faf7f9" font-family="Inter" font-size="76" font-weight="600">Sua ideia.</text><text x="48" y="352" fill="#faf7f9" font-family="Inter" font-size="76" font-weight="600">Um time de IAs.</text><text x="48" y="446" fill="#ff4f8b" font-family="Inter" font-size="76" font-weight="600">Você no comando.</text><text x="48" y="552" fill="#aaa2a8" font-family="Inter" font-size="24">Terminais reais. Agentes em paralelo. Um único cockpit.</text><path d="M1030 120v390M980 175v280M930 245v140" stroke="#ff4f8b" stroke-width="10"/><path d="M1080 225v180M1130 270v90" stroke="#faf7f9" stroke-width="10"/></svg>`;
writeFileSync('public/og-product.png',new Resvg(productSvg,{font:{loadSystemFonts:false,fontFiles:['scripts/fonts/Inter.var.ttf','public/fonts/VT323-Regular.ttf']}}).render().asPng());
