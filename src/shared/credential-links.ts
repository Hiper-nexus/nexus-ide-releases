export interface CredentialLink {
  label: string;
  url: string;
}

const ENV_LINKS: Record<string, CredentialLink> = {
  ANTHROPIC_API_KEY: {
    label: 'Claude Console',
    url: 'https://platform.claude.com/settings/keys',
  },
  ANTHROPIC_AUTH_TOKEN: {
    label: 'Token do upstream',
    url: 'https://z.ai/model-api',
  },
  CLAUDE_API_KEY: {
    label: 'Claude Console',
    url: 'https://platform.claude.com/settings/keys',
  },
  ELEVENLABS_API_KEY: {
    label: 'ElevenLabs',
    url: 'https://elevenlabs.io/app/settings/api-keys',
  },
  GEMINI_API_KEY: {
    label: 'Google AI Studio',
    url: 'https://aistudio.google.com/app/apikey',
  },
  GOOGLE_API_KEY: {
    label: 'Google AI Studio',
    url: 'https://aistudio.google.com/app/apikey',
  },
  GROQ_API_KEY: {
    label: 'GroqCloud',
    url: 'https://console.groq.com/keys',
  },
  MOONSHOT_API_KEY: {
    label: 'Kimi Platform',
    url: 'https://platform.kimi.ai/',
  },
  OPENAI_API_KEY: {
    label: 'OpenAI Platform',
    url: 'https://platform.openai.com/api-keys',
  },
  REPLICATE_API_TOKEN: {
    label: 'Replicate',
    url: 'https://replicate.com/account/api-tokens',
  },
  XAI_API_KEY: {
    label: 'xAI Console',
    url: 'https://console.x.ai/',
  },
};

const PROVIDER_LINKS: Record<string, CredentialLink> = {
  claude: ENV_LINKS.ANTHROPIC_API_KEY,
  codex: ENV_LINKS.OPENAI_API_KEY,
  'google-image': ENV_LINKS.GEMINI_API_KEY,
  'google-video': ENV_LINKS.GEMINI_API_KEY,
  'openai-image': ENV_LINKS.OPENAI_API_KEY,
  'replicate-image': ENV_LINKS.REPLICATE_API_TOKEN,
  'replicate-video': ENV_LINKS.REPLICATE_API_TOKEN,
  'xai-image': ENV_LINKS.XAI_API_KEY,
  'xai-video': ENV_LINKS.XAI_API_KEY,
  elevenlabs: ENV_LINKS.ELEVENLABS_API_KEY,
  glm: {
    label: 'Z.AI Platform',
    url: 'https://z.ai/model-api',
  },
  'glm-flash': {
    label: 'Z.AI Platform',
    url: 'https://z.ai/model-api',
  },
  grok: ENV_LINKS.XAI_API_KEY,
  kimi: ENV_LINKS.MOONSHOT_API_KEY,
  longcat: {
    label: 'LongCat Platform',
    url: 'https://longcat.chat/platform',
  },
};

const UPSTREAM_LINKS: Record<string, CredentialLink> = {
  anthropic: ENV_LINKS.ANTHROPIC_API_KEY,
  deepseek: {
    label: 'DeepSeek Platform',
    url: 'https://platform.deepseek.com/api_keys',
  },
  glm: PROVIDER_LINKS.glm,
  'glm-flash': PROVIDER_LINKS['glm-flash'],
  longcat: PROVIDER_LINKS.longcat,
  minimax: {
    label: 'MiniMax Platform',
    url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  mimo: {
    label: 'MIMO Platform',
    url: 'https://platform.mimo.xiaomi.com/',
  },
  moonshot: ENV_LINKS.MOONSHOT_API_KEY,
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/settings/keys',
  },
  qwen: {
    label: 'Alibaba Cloud DashScope',
    url: 'https://dashscope.console.aliyun.com/apiKey',
  },
  sakana: {
    label: 'Sakana API',
    url: 'https://api.sakana.ai/',
  },
};

export function credentialLinkForEnv(envVar: string | null | undefined): CredentialLink | null {
  return envVar ? ENV_LINKS[envVar] ?? null : null;
}

export function credentialLinkForProvider(
  providerId: string | null | undefined,
): CredentialLink | null {
  return providerId ? PROVIDER_LINKS[providerId] ?? null : null;
}

export function credentialLinkForUpstream(
  upstreamId: string | null | undefined,
): CredentialLink | null {
  return upstreamId ? UPSTREAM_LINKS[upstreamId] ?? null : null;
}

export function credentialLinkForKeySlot(opts: {
  envVar?: string | null;
  providerId?: string | null;
  upstreamId?: string | null;
}): CredentialLink | null {
  const upstreamLink =
    opts.upstreamId && opts.upstreamId !== 'anthropic'
      ? credentialLinkForUpstream(opts.upstreamId)
      : null;
  return (
    upstreamLink ??
    credentialLinkForEnv(opts.envVar) ??
    credentialLinkForProvider(opts.providerId) ??
    null
  );
}
