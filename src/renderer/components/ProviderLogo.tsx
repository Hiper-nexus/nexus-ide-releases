import claudeLogo from '../assets/provider-logos/claude.svg';
import codexLogo from '../assets/provider-logos/codex.svg';
import kimiLogo from '../assets/provider-logos/kimi.svg';
import grokLogo from '../assets/provider-logos/grok.svg';
import glmLogo from '../assets/provider-logos/glm.svg';
import longcatLogo from '../assets/provider-logos/longcat.svg';
import aiderLogo from '../assets/provider-logos/aider.png';
import antigravityLogo from '../assets/provider-logos/agy.svg';
import opencodeLogo from '../assets/provider-logos/opencode.svg';
import openclaudeLogo from '../assets/provider-logos/openclaude.svg';
import qwenLogo from '../assets/provider-logos/qwen.svg';
import geminiLogo from '../assets/provider-logos/gemini.svg';
import deepseekLogo from '../assets/provider-logos/deepseek.svg';
import sakanaLogo from '../assets/provider-logos/sakana.svg';
import qoderLogo from '../assets/provider-logos/qoder.svg';
import ompLogo from '../assets/provider-logos/omp.svg';
import museLogo from '../assets/provider-logos/muse.svg';
import primeAgentLogo from '../assets/provider-logos/prime-agent.svg';
import cursorAgentLogo from '../assets/provider-logos/cursor-agent.svg';

const PROVIDER_LOGOS: Record<string, { src: string; mono?: boolean }> = {
  claude: { src: claudeLogo },
  codex: { src: codexLogo, mono: true },
  kimi: { src: kimiLogo },
  grok: { src: grokLogo, mono: true },
  glm: { src: glmLogo },
  longcat: { src: longcatLogo },
  aider: { src: aiderLogo },
  agy: { src: antigravityLogo },
  opencode: { src: opencodeLogo, mono: true },
  openclaude: { src: openclaudeLogo },
  // Marcas geométricas originais do Nexus (ver NOTICE.md): cada uma carrega a
  // cor de acento do provider, então nenhuma delas é `mono` — o filtro mono
  // pinta o glifo de branco e apagaria justamente o que as distingue.
  qwen: { src: qwenLogo },
  gemini: { src: geminiLogo },
  deepseek: { src: deepseekLogo },
  sakana: { src: sakanaLogo },
  qoder: { src: qoderLogo },
  omp: { src: ompLogo },
  muse: { src: museLogo },
  'prime-agent': { src: primeAgentLogo },
  'cursor-agent': { src: cursorAgentLogo },
};

export function ProviderLogo({
  adapterId,
  label,
  fallback,
  size = 'md',
}: {
  adapterId: string;
  label: string;
  fallback?: string;
  size?: 'xs' | 'sm' | 'md';
}) {
  const logo = PROVIDER_LOGOS[adapterId];
  return (
    <span
      className={[
        'provider-logo',
        `provider-logo--${size}`,
        logo?.mono ? 'provider-logo--mono' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="img"
      aria-label={`Logo ${label}`}
    >
      {logo ? (
        <img src={logo.src} alt="" aria-hidden="true" />
      ) : (
        <span className="provider-logo__fallback" aria-hidden="true">
          {fallback || label.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}
