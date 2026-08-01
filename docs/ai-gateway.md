# Gateway de IA local (OmniRoute-like)

Um provider que morre (401, cota estourada) derruba o worker mesmo com o reroute
dentro do roster — o reroute troca de *agente*, mas cada agente ainda fala direto
com o provider dele. O gateway resolve a camada de baixo: as CLIs falam com um
endpoint local que troca de provider por conta própria, e o Nexus nem vê a falha.

A integração é deliberadamente pela superfície que as CLIs **já** suportam: as
variáveis `*_BASE_URL` compatíveis com os protocolos Anthropic e OpenAI. O Nexus
não fala o protocolo do gateway, não faz proxy e não inspeciona tráfego — ele só
aponta as CLIs para lá.

## Ligar

Nas **Configurações → Orquestrador → Gateway de IA local**, informe a base URL
(ex.: `http://127.0.0.1:20128/v1`). Vazio desliga.

Como alternativa (útil em CI ou máquina headless), a variável de ambiente:

```bash
export NEXUS_AI_GATEWAY_BASE_URL=http://127.0.0.1:20128/v1
```

A configuração da UI tem prioridade; a env var é o fallback. Só `http`/`https`
são aceitos — qualquer outro esquema é ignorado com aviso e o spawn continua
normalmente (o gateway nunca derruba um pane).

### Credencial do gateway

```bash
export NEXUS_AI_GATEWAY_API_KEY=...
```

Quando definida, ela é injetada como `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` **depois**
da credencial do provider — se você roteia para o gateway, é a chave dele que
autentica o tráfego.

Quando **não** definida, a CLI continua autenticando com a credencial do provider
(assinatura OAuth ou API key da conta), e essa credencial **é enviada ao gateway**.
Isso é aceitável para um gateway local do próprio operador, e por isso é o padrão
— mas o Nexus registra um `console.warn` a cada adapter roteado para que a decisão
seja visível em vez de silenciosa.

## Quais CLIs são alcançadas

O gateway só reescreve variáveis que o adapter **declarou no próprio passthrough**.
Ele nunca inventa uma variável que a CLI não conhece.

| CLI | Var roteada | Situação |
|---|---|---|
| `claude` | `ANTHROPIC_BASE_URL` | roteada |
| `codex` | `OPENAI_BASE_URL` | roteada |
| `aider` | `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | roteada |
| `opencode` | `OPENAI_BASE_URL` | roteada |
| `glm` | `ANTHROPIC_BASE_URL` (em `static`) | **intocada** — endpoint do plano |
| `longcat` | `ANTHROPIC_BASE_URL` (em `static`) | **intocada** — endpoint do plano |
| `kimi` | `KIMI_MODEL_BASE_URL` | **fora de alcance** (ver abaixo) |
| `gemini`, `grok`, `agy` | — | não declaram base URL |

**GLM e LongCat** pinam o endpoint do próprio plano em `env.static`, que é
aplicado *depois* do gateway em `agentEnv` — apontá-los para um gateway quebraria
a identidade do provider. É garantia estrutural, não convenção.

**Kimi** fica de fora de propósito: `KIMI_MODEL_BASE_URL` é um endpoint de
*modelo*, amarrado a `KIMI_MODEL_PROVIDER_TYPE` e `KIMI_MODEL_API_KEY` no mesmo
trio. Rotear só a URL deixaria o trio incoerente. Entrar no gateway exige uma
decisão explícita sobre os três — está registrado em `GATEWAY_OUT_OF_REACH_VARS`
(`src/main/pty/gateway-env.ts`) e o log diz isso ao operador.

## Transporte não é identidade

Esta é a regra que sustenta o desenho, e quebrá-la já causou perda de login.

Cada spawn constrói **dois** envs a partir do mesmo adapter:

- **transporte** — `agentEnv(adapter, gatewayBaseUrl)`: o que a CLI realmente
  recebe, com as base URLs no gateway;
- **identidade** — `agentEnv(adapter, null)`: o que responde *"que plano é
  este?"*. É este que vai para o spawn hook decidir HOME efêmero, credencial
  nativa e classificação de terceiro.

Se o gateway vazasse para o env de identidade, `isThirdPartyClaudeFamily`
enxergaria uma `ANTHROPIC_BASE_URL` estrangeira e classificaria o **Claude de
assinatura** como provider de terceiro: HOME isolado, `carryNativeClaudeAuth`
falso e nenhum token injetado — a CLI subiria sem credencial nenhuma e pediria
`/login` no meio da missão.

Só uma das três chamadas de `shouldUseEphemeralHome` recebe `effectiveEnv`
(`mcp-server.ts`); `pty-ipc.ts` e `main-owned-pane-runtime.ts` não passam nada.
Manter o gateway fora do env de identidade é o que faz as três concordarem sem
precisar sincronizar argumentos. A regressão está coberta em
`src/main/pty/pty-manager.test.ts` (`gateway de IA local (OmniRoute-like)`).

## Observabilidade

Uma linha por adapter por processo, no log do main:

```
[gateway] claude → http://127.0.0.1:20128/v1 (ANTHROPIC_BASE_URL)
[gateway] glm: fora do gateway — endpoint do plano pinado (ANTHROPIC_BASE_URL)
[gateway] kimi: KIMI_MODEL_BASE_URL não roteada — endpoint de modelo (...)
[gateway] claude: sem NEXUS_AI_GATEWAY_API_KEY — a credencial do provider
          (assinatura/API key) será enviada ao gateway
```

Sem isso, ligar o gateway não produzia nenhum sinal: o único log existente era o
aviso de URL inválida.

## Limites conhecidos

- **Só PTY de CLI.** Chamadas que o próprio main faz a provedores (voz, quota,
  doctor) não passam pelo gateway.
- **A chave do gateway é só env var.** Ela não tem campo na UI nem entra no vault
  — a base URL é o que precisa ser descobrível; a chave é secreta e fica com o
  operador.
- **Trocar a base URL vale no próximo spawn.** Panes já abertos mantêm o env com
  que subiram.
