// GERADO por scripts/update-benchmarks.mjs a partir de nexus-ide/src/main/orch/published-benchmarks.ts. Não edite à mão.
// Números oficiais dos fabricantes, com a fonte primária; sem número publicado, a célula fica vazia (nunca estimada).
export default {
  "collectedAt": "2026-09-28",
  "source": "nexus-ide/src/main/orch/published-benchmarks.ts",
  "models": [
    {
      "key": "claude:claude-opus-5-5",
      "label": "Claude Opus 5.5",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-opus-5-5",
      "deepSWE": 74.2
    },
    {
      "key": "claude:claude-opus-5",
      "label": "Claude Opus 5",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-opus-5-system-card",
      "deepSWE": 68.8,
      "swebenchVerified": 96
    },
    {
      "key": "claude:claude-fable-5-1",
      "label": "Claude Fable 5.1",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-fable-5-1",
      "deepSWE": 67.4
    },
    {
      "key": "claude:claude-mythos-5-1",
      "label": "Claude Mythos 5.1",
      "vendor": "Anthropic",
      "source": "Fable 5.1 & Mythos 5.1 System Card",
      "sameModelAs": "claude:claude-fable-5-1"
    },
    {
      "key": "claude:claude-fable-5",
      "label": "Claude Fable 5",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-fable-5-mythos-5-system-card",
      "deepSWE": 69.7,
      "terminalBench21": 84.3,
      "swebenchVerified": 95
    },
    {
      "key": "claude:claude-opus-4-8",
      "label": "Claude Opus 4.8",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-opus-4-8-system-card",
      "deepSWE": 59,
      "terminalBench21": 82.7,
      "swebenchVerified": 88.6
    },
    {
      "key": "claude:claude-sonnet-5-5",
      "label": "Claude Sonnet 5.5",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-sonnet-5-5",
      "deepSWE": 71
    },
    {
      "key": "claude:claude-sonnet-5",
      "label": "Claude Sonnet 5",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/claude-sonnet-5-system-card",
      "terminalBench21": 80.4,
      "swebenchVerified": 85.2
    },
    {
      "key": "claude:claude-haiku-4-5",
      "label": "Claude Haiku 4.5",
      "vendor": "Anthropic",
      "source": "https://www.anthropic.com/news/claude-haiku-4-5",
      "swebenchVerified": 73.3
    },
    {
      "key": "codex:gpt-6.1-sol",
      "label": "GPT-6.1 Sol",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/introducing-gpt-6-1-sol/",
      "deepSWE": 75.2
    },
    {
      "key": "codex:gpt-6-sol",
      "label": "GPT-6 Sol",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/introducing-gpt-6-sol-and-luna/",
      "deepSWE": 68.8
    },
    {
      "key": "codex:gpt-6-luna",
      "label": "GPT-6 Luna",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/introducing-gpt-6-sol-and-luna/",
      "deepSWE": 66.6
    },
    {
      "key": "codex:gpt-6-astra",
      "label": "GPT-6 Astra",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/gpt-6-astra/",
      "deepSWE": 74.1
    },
    {
      "key": "codex:gpt-5.6-sol",
      "label": "GPT-5.6 Sol",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/gpt-5-6/",
      "deepSWE": 72.7,
      "terminalBench21": 88.8
    },
    {
      "key": "codex:gpt-5.6-terra",
      "label": "GPT-5.6 Terra",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/gpt-5-6/",
      "deepSWE": 69.6,
      "terminalBench21": 87.4
    },
    {
      "key": "codex:gpt-5.6-luna",
      "label": "GPT-5.6 Luna",
      "vendor": "OpenAI",
      "source": "https://openai.com/index/gpt-5-6/",
      "deepSWE": 67.2,
      "terminalBench21": 84.7
    },
    {
      "key": "grok:grok-4.7",
      "label": "Grok 4.7",
      "vendor": "xAI",
      "source": "https://x.ai/news/grok-4-7",
      "deepSWE": 71
    },
    {
      "key": "grok:grok-4.7-build-fast",
      "label": "Grok 4.7 Build Fast",
      "vendor": "xAI",
      "source": "https://docs.x.ai/developers/grok-4-7",
      "sameModelAs": "grok:grok-4.7"
    },
    {
      "key": "grok:grok-4.6",
      "label": "Grok 4.6",
      "vendor": "xAI",
      "source": "https://x.ai/news/grok-4-6",
      "deepSWE": 65.9
    },
    {
      "key": "grok:grok-4.5",
      "label": "Grok 4.5",
      "vendor": "xAI",
      "source": "https://x.ai/news/grok-4-5",
      "deepSWE": 53,
      "terminalBench21": 83.3
    },
    {
      "key": "glm:glm-5.3",
      "label": "GLM-5.3",
      "vendor": "Z.ai",
      "source": "https://huggingface.co/zai-org/GLM-5.3",
      "deepSWE": 66.9,
      "terminalBench21": 88.2
    },
    {
      "key": "glm:glm-5.3-flash",
      "label": "GLM-5.3 Flash",
      "vendor": "Z.ai",
      "source": "https://docs.z.ai/guides/llm/glm-5.3-flash",
      "deepSWE": 63.4,
      "terminalBench21": 84.3
    },
    {
      "key": "glm:glm-5.2",
      "label": "GLM-5.2",
      "vendor": "Z.ai",
      "source": "https://huggingface.co/zai-org/GLM-5.2",
      "deepSWE": 46.2,
      "terminalBench21": 81
    },
    {
      "key": "glm:glm-4.7",
      "label": "GLM-4.7",
      "vendor": "Z.ai",
      "source": "https://huggingface.co/zai-org/GLM-4.7",
      "swebenchVerified": 73.8
    },
    {
      "key": "glm:glm-4.5-air",
      "label": "GLM-4.5 Air",
      "vendor": "Z.ai",
      "source": "https://arxiv.org/abs/2508.06471",
      "swebenchVerified": 57.6
    },
    {
      "key": "glm:glm-4.7-flash",
      "label": "GLM-4.7 Flash",
      "vendor": "Z.ai",
      "source": "https://huggingface.co/zai-org/GLM-4.7-Flash",
      "swebenchVerified": 59.2
    },
    {
      "key": "agy:gemini-4-argon",
      "label": "Gemini 4 Argon",
      "vendor": "Google",
      "source": "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/",
      "deepSWE": 77.9
    },
    {
      "key": "agy:gemini-3.8-flash",
      "label": "Gemini 3.8 Flash",
      "vendor": "Google",
      "source": "https://deepmind.google/models/model-cards/gemini-3-8-flash/",
      "deepSWE": 73.7,
      "terminalBench21": 89.4
    },
    {
      "key": "agy:gemini-3.7-flash",
      "label": "Gemini 3.7 Flash",
      "vendor": "Google",
      "source": "https://deepmind.google/models/model-cards/gemini-3-7-flash/",
      "deepSWE": 65.3,
      "terminalBench21": 85.8
    },
    {
      "key": "agy:gemini-3.6-flash",
      "label": "Gemini 3.6 Flash",
      "vendor": "Google",
      "source": "https://deepmind.google/models/model-cards/gemini-3-6-flash/",
      "deepSWE": 49,
      "terminalBench21": 78
    },
    {
      "key": "kimi:kimi-code/k3",
      "label": "Kimi K3",
      "vendor": "Moonshot AI",
      "source": "https://huggingface.co/moonshotai/Kimi-K3",
      "deepSWE": 67.5,
      "terminalBench21": 88.3
    },
    {
      "key": "devin:swe-2",
      "label": "SWE-2",
      "vendor": "Cognition",
      "source": "https://cognition.com/blog/swe-2",
      "deepSWE": 73,
      "terminalBench21": 92.8
    },
    {
      "key": "longcat:LongCat-2.0",
      "label": "LongCat 2.0",
      "vendor": "Meituan",
      "source": "https://huggingface.co/meituan-longcat/LongCat-2.0",
      "terminalBench21": 70.8
    },
    {
      "key": "deepseek:deepseek-flash",
      "label": "DeepSeek V4.1 Flash",
      "vendor": "DeepSeek",
      "source": "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash",
      "deepSWE": 74.2,
      "terminalBench21": 90.6
    },
    {
      "key": "deepseek:deepseek-v4-pro",
      "label": "DeepSeek V4 Pro",
      "vendor": "DeepSeek",
      "source": "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813",
      "deepSWE": 62.7,
      "terminalBench21": 87.9
    },
    {
      "key": "muse:muse-spark-1.3",
      "label": "Muse Spark 1.3",
      "vendor": "Meta",
      "source": "https://dev.meta.ai/models/muse-spark/",
      "deepSWE": 75.4,
      "terminalBench21": 88.8
    },
    {
      "key": "mimo-code:xiaomi/mimo-v2.6-pro",
      "label": "MiMo V2.6 Pro",
      "vendor": "Xiaomi",
      "source": "https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL",
      "deepSWE": 71.9,
      "terminalBench21": 89.9
    },
    {
      "key": "mimo-code:xiaomi/mimo-v2.6-flash",
      "label": "MiMo V2.6 Flash",
      "vendor": "Xiaomi",
      "source": "https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL",
      "deepSWE": 67.9,
      "terminalBench21": 87.6
    },
    {
      "key": "minimax-code:minimax/MiniMax-M3.1-Flash-Preview",
      "label": "MiniMax M3.1 Flash Preview",
      "vendor": "MiniMax",
      "source": "https://datanorth.ai/news/minimax-releases-m3-1-flash-preview",
      "successorOf": "minimax-code:minimax/MiniMax-M3"
    },
    {
      "key": "minimax-code:minimax/MiniMax-M3",
      "label": "MiniMax M3",
      "vendor": "MiniMax",
      "source": "https://www.minimax.io/blog/minimax-m3",
      "terminalBench21": 66,
      "swebenchVerified": 80.5
    },
    {
      "key": "minimax-code:minimax/MiniMax-M2.7",
      "label": "MiniMax M2.7",
      "vendor": "MiniMax",
      "source": "https://www.minimax.io/blog/minimax-m3",
      "terminalBench21": 51.1,
      "swebenchVerified": 79.9
    },
    {
      "key": "minimax-code:minimax/MiniMax-M2.7-highspeed",
      "label": "MiniMax M2.7 Highspeed",
      "vendor": "MiniMax",
      "source": "https://www.minimax.io/models/text/m27",
      "sameModelAs": "minimax-code:minimax/MiniMax-M2.7"
    }
  ]
};
