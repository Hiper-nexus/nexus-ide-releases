# Estúdio de vídeo no Nexus: estudo e proposta de entrega (19/10/2026)

Pedido do operador (19/10): muita gente está fazendo vídeo motion com
HyperFrames ou Remotion, com áudio e voz clonada, para apresentar produtos,
usando Opus 5.5, Sonnet ou o DeepSeek novo. Estudar como isso é feito, o que
dá para integrar e propor um jeito de unificar tudo no Nexus.

**Estado:** estudo e proposta. Nenhum código de produto foi escrito. A
implementação espera o OK do operador, porque é uma superfície nova com
licença e custo de terceiros. O protótipo de medição rodou fora do
repositório e foi apagado depois (seção 3).

**Revisão de 19/10, a pedido do operador:** o Nexus já está em produção, então
não há MVP. A proposta virou uma entrega completa de 17 passos, que só sai
numa versão quando tudo estiver pronto nos três sistemas (seção 5.3). A
pergunta "deixar o cliente escolher entre HyperFrames e Remotion ou
padronizar" está respondida na seção 5.2: padronizar.

Convenção das fontes: cada afirmação externa traz o link e a data de acesso.
"Lido" quer dizer página aberta em 19/10/2026; "via busca" quer dizer que só o
resultado da busca foi visto, sem abrir a página. Números medidos neste PC
estão na seção 3, com os comandos que os produziram.

## Resumo

- **Como se faz:** o agente escreve o vídeo como código (React no Remotion,
  HTML + GSAP no HyperFrames), um Chrome headless renderiza quadro a quadro e
  o ffmpeg codifica. Narração por TTS ou voz clonada; legenda pelo tempo de
  cada palavra. As pessoas travam na instalação (Node, ffmpeg, Chrome), no
  tempo de cena contra áudio (os modelos acertam o visual e erram o tempo) e
  em fontes.
- **Remotion** não é open source: grátis até 3 pessoas; acima disso o cliente
  paga (US$ 25 por pessoa por mês ou US$ 0,01 por render). Os termos do
  Remotion 5 não deixam uma IDE embutir o Remotion, porque o usuário vê o
  código. **HyperFrames** (HeyGen) é Apache-2.0, feito para agente, com 67
  mil estrelas e pré-1.0.
- **Medido neste PC:** 30 s de vídeo 1080×1920 em 17 a 23 s de render nos
  dois motores. O Remotion quebra no Windows com projeto em caminho longo; o
  HyperFrames busca fonte e script na rede no render e liga telemetria por
  padrão.
- **Voz:** a ElevenLabs, já integrada, faz narração com o tempo de cada
  caractere (legenda exata sem reconhecimento), clona com 1 a 2 minutos de
  áudio, gera música com licença para vídeo de produto online e custa ~US$
  0,25 por vídeo de 60 s pelo preço de API. O Gemini 3.8 clona com o
  consentimento verificado pelo próprio Google.
- **Lei:** AI Act art. 50 em vigor desde 02/08/2026 (marcar a saída e rotular
  deepfake); LGPD trata voz como dado biométrico sensível; o YouTube dispensa
  declarar a própria voz clonada em narração, mas Meta e TikTok pedem rótulo.
- **Proposta:** o agente escreve no pane; o Nexus entrega voz com
  consentimento (clonada, de biblioteca ou gravada pela pessoa), tempos em
  JSON, legenda, música, instalação guiada, render limpo, prévia ao vivo,
  captura do produto, variantes de formato e idioma, teto de gasto, marcação
  de conteúdo sintético e export por rede, com as chaves no cofre e o custo
  antes de pagar. Entrega completa em 17 passos, sem MVP (seção 5.3).
- **Um motor só:** HyperFrames. Escolha entre dois motores dobraria o que tem
  de estar inteiro e empurraria o cliente para a licença paga do Remotion;
  projeto Remotion que o cliente já tem segue editável pelo agente no pane.
- **Decisões do operador:** OK para a entrega, compra do certificado C2PA e a
  pergunta da licença Remotion para a própria HiperSend (seção 5.7).

## 1. Como esses vídeos são feitos hoje

### 1.1 O fluxo de ponta a ponta

O vídeo de apresentação de produto feito por agente segue quase sempre a
mesma esteira:

1. **Roteiro.** O agente escreve o texto da narração e a lista de cenas
   (gancho, problema, produto, recurso, benefício, chamada final). É a mesma
   estrutura de 8 batidas que o benchmark da HeyGen usa como brief
   ([heygen.com/research/introducing-code2video-benchmark](https://www.heygen.com/research/introducing-code2video-benchmark), lido em 19/10/2026).
2. **Assets.** Prints ou gravação do produto, logo, fontes e cores da marca.
   O HyperFrames tem `hyperframes capture <url>`, que copia um site em
   componentes editáveis (CLI 0.8.177, `capture --help`, rodado em 19/10).
3. **Narração.** TTS com voz de biblioteca ou voz clonada da própria pessoa.
4. **Tempo.** A duração de cada cena sai do áudio, e a legenda sai do tempo de
   cada palavra.
5. **Composição.** O agente escreve o vídeo como código: React no Remotion,
   HTML + GSAP no HyperFrames.
6. **Revisão.** Quadros-chave em PNG, lint de layout, ajuste.
7. **Render** quadro a quadro num Chrome headless, codificado pelo ffmpeg.
8. **Export** por rede: 9:16 para Reels, Shorts e TikTok, 16:9 para YouTube e
   LinkedIn, com loudness normalizado e capa.

O próprio Nexus já fez isso uma vez: o reel vertical de 25/09
(`docs/superpowers/specs/2026-09-25-nexus-reel-design.md`), em Remotion, com
trilha da ElevenLabs, medição de batida e loudnorm no ffmpeg, num repositório
separado e sem narração.

**Onde as pessoas travam**, pelos relatos e issues:

- **Instalação.** Node 22+, ffmpeg (o HyperFrames exige o do sistema; o
  Remotion embute o seu) e o Chrome Headless Shell baixado no primeiro
  render. No Windows 11 com Smart App Control, o Remotion não sobe porque as
  DLLs do ffmpeg embutido não são assinadas
  ([remotion#11782](https://github.com/remotion-dev/remotion/issues/11782),
  fechada em 07/10/2026; a assinatura dos binários,
  [#11784](https://github.com/remotion-dev/remotion/issues/11784), segue
  aberta; lidas em 19/10/2026). No HyperFrames, as issues abertas no Windows
  incluem uma janela de console visível durante o render que, se fechada,
  aborta tudo ([#5653](https://github.com/heygen-com/hyperframes/issues/5653)),
  e EBUSY ao iniciar o ffmpeg
  ([#4058](https://github.com/heygen-com/hyperframes/issues/4058)), via API do
  GitHub em 19/10/2026. E o limite de caminho do Windows, medido aqui (seção
  3).
- **Tempo de cena contra áudio.** Os modelos acertam a aparência e erram o
  tempo. No Animation2Code (UC Berkeley, 26/06/2026), a similaridade temporal
  não passou de 0,31 em nenhum modelo, contra 0,82 de aparência no Sonnet 4.6
  ([arxiv.org/html/2606.28593v1](https://arxiv.org/html/2606.28593v1), lido em
  19/10/2026). Erros típicos com Remotion: `<Sequence>` sem `from`,
  `durationInFrames` que não fecha a conta, `interpolate` linear
  ([blog.openreplay.com, 04/06/2026](https://blog.openreplay.com/making-videos-claude-code-remotion/), lido em 19/10/2026).
- **Fontes.** Preview e render divergem com fonte, mídia remota e caminho de
  asset ([tella.com, 12/10/2026](https://www.tella.com/blog/how-to-use-remotion-agent-skills-with-claude-code), lido em 19/10/2026).
  Aqui o HyperFrames trocou a fonte pedida por outra sem avisar (seção 3).
- **Formato vertical.** Entre a 0.8.81 e a correção de 13/10/2026, o MP4 do
  HyperFrames perdia os 8 px da direita em largura 1080
  ([#5551](https://github.com/heygen-com/hyperframes/issues/5551), via API do
  GitHub em 19/10/2026). Texto essencial precisa ficar fora das faixas de
  interface das redes; o reel do Nexus usou x ∈ [64, 900] e y ∈ [250, 1480].
- **Render lento** não apareceu como gargalo real para 30 a 90 s (seção 3).

### 1.2 Remotion

- **O que é:** vídeo em React, renderizado quadro a quadro num Chrome
  headless, com ffmpeg embutido nos pacotes de compositor (linha 7.1, só
  H.264, H.265, VP8, VP9 e ProRes;
  [remotion.dev/docs/cli/ffmpeg](https://www.remotion.dev/docs/cli/ffmpeg.md),
  lido em 19/10/2026). Versão 4.0.537 publicada em 19/10/2026; 1.412.638
  downloads na semana de 12 a 18/10; 65.274 estrelas
  (registry npm, api.npmjs.org e API do GitHub, consultados em 19/10/2026).
- **Licença (o ponto que decide):** não é open source. É grátis para pessoa
  física, empresa com até 3 pessoas, entidade sem fins lucrativos e
  avaliação; o uso comercial é permitido dentro dessas faixas
  ([LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md),
  lido em 19/10/2026). A partir de 4 pessoas, a empresa precisa da Company
  License: Creators a US$ 25 por mês por pessoa que escreve código Remotion
  (o FAQ inclui quem escreve com agente de código), Automators a US$ 0,01 por
  render com mínimo de US$ 100 por mês, Enterprise a partir de US$ 500
  ([remotion.pro/license](https://www.remotion.pro/license) e
  [docs/license/faq](https://www.remotion.dev/docs/license/faq), lidos em
  19/10/2026). Editores de vídeo e apps prompt-to-video caem em Automators
  (mesmo FAQ).
- **O que vale para o Nexus (empresa que distribui a IDE):** os termos v4.0
  em vigor (atualizados em 23/11/2023) não tratam de app desktop
  ([remotion.pro/terms-4-0](https://www.remotion.pro/terms-4-0), lido em
  19/10/2026). Os termos v5.0, que entram em vigor com o Remotion 5.0, permitem
  embutir o Remotion num app Electron só se houver uma camada que impeça o
  usuário final de ver ou editar o código Remotion, com a obrigação de manter
  a Company License por um ano depois da última versão publicada
  ([remotion.dev/docs/terms](https://www.remotion.dev/docs/terms.md), seção
  "Native application distribution", lido em 19/10/2026). Numa IDE o usuário
  vê e edita o código, então **o Nexus não deve empacotar o Remotion**. Mesmo
  sem empacotar, o FAQ chama de automação ter código que chama
  `npx remotion render`: um botão "Renderizar" do Nexus para projetos Remotion
  pode ser lido como automação da empresa do Nexus. Isso só se resolve por
  escrito com a Remotion (hi@remotion.dev, indicado no FAQ).
- **O que vale para o cliente do Nexus:** pessoa física e empresa com até 3
  pessoas usam de graça. Empresa com 4 ou mais pessoas precisa da própria
  Company License: os termos v5.0 dizem que quem vê ou modifica o código
  Remotion precisa de licença própria, seja qual for a licença da plataforma
  que deu o acesso (mesma página). Os termos v5.0 contam todo o pessoal da
  empresa, use ou não o Remotion.
- **Telemetria:** o render local só manda evento de uso quando há
  `licenseKey`. Conferi no código instalado (`@remotion/renderer/dist/render-media.js`,
  função `sendTelemetryAndResolve`). No Remotion 5.0 a chave fica obrigatória
  para Automators ([docs/telemetry](https://www.remotion.dev/docs/telemetry.md),
  lido em 19/10/2026).
- **Para agentes:** 12 skills oficiais (`npx remotion skills add`), plugin
  para Claude Code e outras CLIs, `llms.txt`, docs em Markdown e um system
  prompt próprio ([docs/ai/skills](https://www.remotion.dev/docs/ai/skills.md),
  [docs/ai/claude-code-plugin](https://www.remotion.dev/docs/ai/claude-code-plugin.md),
  [llms.txt](https://www.remotion.dev/llms.txt), lidos em 19/10/2026). O MCP
  oficial foi descontinuado em favor da skill `/remotion-docs`
  ([docs/ai/mcp](https://www.remotion.dev/docs/ai/mcp.md), lido em 19/10/2026).
  O repositório das skills não tem arquivo de licença
  ([remotion-dev/skills](https://github.com/remotion-dev/skills), API do
  GitHub em 19/10/2026): o Nexus não pode redistribuí-las.
- **Peças úteis:** `@remotion/captions` (MIT) com `createTikTokStyleCaptions`
  e conversores de whisper.cpp, OpenAI e ElevenLabs;
  `calculateMetadata()` para a duração vir do áudio; `getMediaMetadata()` no
  lugar da descontinuada `getAudioDurationInSeconds()`
  ([docs/captions/api](https://www.remotion.dev/docs/captions/api.md),
  [docs/calculate-metadata](https://www.remotion.dev/docs/calculate-metadata.md),
  [docs/get-audio-duration-in-seconds](https://www.remotion.dev/docs/get-audio-duration-in-seconds.md),
  lidos em 19/10/2026).

### 1.3 HyperFrames

- **O que é:** "escreva HTML, renderize vídeo", mantido pela HeyGen
  (`heygen-com/hyperframes`). Apache-2.0, 67.487 estrelas, 6.101 forks,
  repositório criado em 10/03/2026 (API do GitHub, 19/10/2026). CLI
  `hyperframes` 0.8.177, publicado em 19/10/2026 com três releases no mesmo
  dia; 510.551 downloads na semana de 12 a 18/10 (registry npm e
  api.npmjs.org, 19/10/2026). Ainda não chegou à 1.0.
- **Como renderiza:** a composição é um `index.html` com elementos marcados por
  `data-start`, `data-duration` e `data-track-index`, e uma timeline GSAP
  pausada registrada em `window.__timelines`. O Puppeteer avança o Chrome
  headless quadro a quadro e o ffmpeg do sistema codifica. Saída em MP4, MOV
  ProRes 4444, WebM com transparência, GIF, PNG e HLS
  ([README](https://raw.githubusercontent.com/heygen-com/hyperframes/main/README.md),
  lido em 19/10/2026; confirmado no `AGENTS.md` que o `init` gerou aqui).
- **Feito para agente:** 21 skills com um roteador `/hyperframes` e
  workflows prontos (`/product-launch-video`, `/faceless-explainer`,
  `/pr-to-video`, `/music-to-video`, `/remotion-to-hyperframes`); CLI não
  interativo; e comandos de verificação que o agente lê sozinho: `lint`,
  `check` (lint + runtime + layout + movimento + contraste), `inspect`,
  `snapshot` (quadros-chave em PNG) e `validate`. Tem também `tts` (Kokoro-82M
  local), `transcribe` (Parakeet ou whisper.cpp, por palavra), `beats`,
  `audio`, `normalize-audio`, `remove-background` e `capture` (`--help` da
  0.8.177, rodado em 19/10). Há um MCP hospedado pela HeyGen, que exige conta
  e renderiza na nuvem dela
  ([docs/guides/mcp.mdx](https://github.com/heygen-com/hyperframes), lido em
  19/10/2026).
- **Requisitos:** Node 22+, ffmpeg e ffprobe no PATH (não vêm embutidos),
  Chrome Headless Shell no cache do Puppeteer; cada worker é um Chrome de
  ~256 MB. No Windows e no macOS, render com vários workers grava os quadros
  em disco, salvo com `HF_CAPTURE_PARALLEL_STREAM=true`
  ([docs/packages/cli.mdx](https://raw.githubusercontent.com/heygen-com/hyperframes/main/docs/packages/cli.mdx),
  lido em 19/10/2026).
- **Telemetria:** PostHog, ligada por padrão; detecta qual agente chamou o CLI;
  aceita `HYPERFRAMES_CLIENT=<app>/<versão>/<canal>`; desliga com
  `HYPERFRAMES_NO_TELEMETRY=1` ou `DO_NOT_TRACK=1` (mesma página, e conferido
  no código instalado).
- **Dependência GSAP:** a GSAP é grátis inclusive para uso comercial desde
  30/04/2025, mas a licença proíbe usá-la numa ferramenta visual de animação
  sem código que concorra com o construtor de animação da Webflow; código GSAP
  escrito por IA é explicitamente permitido
  ([gsap.com/standard-license](https://gsap.com/standard-license/), lido em
  19/10/2026). Consequência para o Nexus: o agente escrever GSAP pode; o Nexus
  ganhar um editor visual de timeline GSAP, não.

### 1.4 Alternativas

Lidas em 19/10/2026 (registry npm, API do GitHub e páginas de preço):

| Ferramenta | Licença | Render | Para agente |
|---|---|---|---|
| Motion Canvas | MIT | pelo editor, sem CLI headless oficial; último estável 3.17.2 de 14/12/2024 | fraco |
| Revideo (`midrender/revideo`) | MIT | `renderVideo()` headless; 0.11.0 de 10/07/2026 | médio, sem skills |
| Editframe | código visível, grátis até 3 pessoas, US$ 49 a 99/mês acima | navegador, CLI, nuvem a US$ 0,02/min | médio; mesmo problema de licença do Remotion |
| Twick | Sustainable Use License | WebCodecs ou Puppeteer + ffmpeg | médio; licença vaga para "receita substancial" |
| Shotstack | SaaS, US$ 0,05 a 0,20/min | nuvem, timeline JSON | fácil, mas os assets sobem para a nuvem |
| Creatomate | SaaS por créditos | nuvem, templates | idem |
| editly | MIT | ffmpeg; parado desde 12/2022 | montagem simples |
| Manim | MIT | Python | só explicativo matemático |
| Lottie | MIT | é player; precisa de um dos motores | — |

Nenhuma alternativa tem ao mesmo tempo licença permissiva, render headless
mantido e ferramentas para agente. A escolha real é entre Remotion e
HyperFrames.

### 1.5 Agentes e modelos

- **Como se usa:** o fluxo oficial do Remotion é criar um projeto em branco,
  instalar as skills, abrir o Studio e pedir ao agente
  ([docs/ai/coding-agents](https://www.remotion.dev/docs/ai/coding-agents.md),
  lido em 19/10/2026). O do HyperFrames é `init`, o roteador `/hyperframes`
  e um prompt do tipo "crie uma intro de 15 s sobre X" (texto do `init` da
  0.8.177). Circulam skills derivadas, como `latent-spaces/brag` (MIT, 16,9
  mil estrelas), que faz o vídeo de lançamento de um repositório via
  HyperFrames ([README](https://raw.githubusercontent.com/latent-spaces/brag/main/README.md),
  lido em 19/10/2026).
- **O que os modelos fazem bem e mal:** o único ranking público é o
  Code2Video da HeyGen (18/09/2026): 168 briefs de vídeo de lançamento, só em
  HyperFrames, juiz treinado pela própria HeyGen. No topo, dentro de 12 pontos
  de Elo entre si: GPT-6 Astra, GPT-5.5, Claude Opus 5 e GPT-5.6 Sol. Claude
  Fable 5 ficou em 11º e DeepSeek V4 Pro em 18º. Os de pesos abertos (Qwen 3.8
  Max, DeepSeek V4.1 Flash, Kimi K3, GLM 5.3) ficaram a menos de 50 Elo do
  primeiro. Seguir o brief está resolvido; os modelos erram easing, cadência,
  colisão de texto em movimento, texto vazando do quadro e acabamento
  ([heygen.com/research/introducing-code2video-benchmark](https://www.heygen.com/research/introducing-code2video-benchmark),
  lido em 19/10/2026). Ressalvas: o benchmark é do dono do motor; não há
  Sonnet, nem Opus 5.5, nem dado de sincronia com áudio. Para o DeepSeek com
  Remotion não achei relato nenhum.
- **Conclusão prática:** o tempo não deve depender do modelo. O Nexus entrega
  os tempos em JSON e o agente só os lê. A revisão usa `check`/`snapshot` e
  um juiz de ponta olhando os quadros. Opus e Sonnet escrevem roteiro e
  composição; DeepSeek e os modelos abertos servem para variações (outro
  formato, outro idioma) depois de uma avaliação própria (seção 5.3). O GPT-6
  Astra continua caso raro (regra do operador, F-700): não entra na rota
  automática por estar no topo do Code2Video.

## 2. Voz, legenda e música

### 2.1 ElevenLabs (já integrada no Nexus)

- **Planos** ([elevenlabs.io/pricing](https://elevenlabs.io/pricing), lido em
  19/10/2026): Free US$ 0 (10 mil créditos), Starter US$ 6 (30 mil), Creator
  US$ 22 (121 mil), Pro US$ 99 (600 mil). A clonagem instantânea (IVC) começa
  no Starter; a profissional (PVC), no Creator.
- **Preço por API** ([elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api),
  lido em 19/10/2026): TTS a US$ 0,08 por mil caracteres no `eleven_v4`,
  `eleven_v3` e Multilingual v2; US$ 0,04 no v4 Turbo e no Flash. Scribe
  (STT) a US$ 0,22 por hora. Música a US$ 0,15 por minuto. Efeitos a US$ 0,12
  por minuto.
- **Modelos** ([docs/overview/models](https://elevenlabs.io/docs/overview/models),
  lido em 19/10/2026): `eleven_v4` é o mais novo (10 mil caracteres por
  pedido, 90+ idiomas, português incluído); `eleven_turbo_v2_5` está
  descontinuado em favor do Flash v2.5. **O Nexus ainda oferece
  `eleven_turbo_v2_5` e não oferece o v4** (`src/main/media/media-providers.ts:173-184`),
  o que fere a regra "modelo mais novo sempre".
- **IVC:** `POST /v1/voices/add` com `name` e `files`; 1 a 2 minutos de áudio,
  sem passar de 3. A API não tem campo de consentimento; na interface web a
  pessoa só confirma que tem direito e consentimento
  ([docs/api-reference/voices/ivc/create](https://elevenlabs.io/docs/api-reference/voices/ivc/create)
  e [guia de IVC](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning.md),
  lidos em 19/10/2026).
- **PVC:** 30 a 180 minutos de áudio, treino de 3 a 6 h, e só da voz do
  próprio titular: a ElevenLabs manda a pessoa ler um CAPTCHA de voz
  (`POST /v1/voices/pvc/{voice_id}/captcha`) antes de treinar
  ([guia de PVC](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/professional-voice-cloning.md)
  e [docs/product-guides/voices/voice-cloning](https://elevenlabs.io/docs/product-guides/voices/voice-cloning),
  lidos em 19/10/2026). Com o v4, todo clone exige consentimento verificado do
  dono da voz ([elevenlabs.io/v4](https://elevenlabs.io/v4), lido em
  19/10/2026), mas a página não diz como a IVC verifica.
- **Política de uso** (atualizada em 09/10/2026,
  [elevenlabs.io/use-policy](https://elevenlabs.io/use-policy), lido em
  19/10/2026): proíbe clonar voz de pessoa viva sem consentimento explícito e
  informado, voz de menor de 18 anos, imitar candidato ou autoridade e remover
  a marca d'água. A salvaguarda "No-Go Voices" bloqueia parte das vozes de
  figuras públicas
  ([help-center](https://elevenlabs.io/docs/help-center/legal/what-are-no-go-voices.md),
  lido em 19/10/2026).
- **Direito comercial:** o áudio do plano Free não pode ser usado
  comercialmente e exige atribuição; os planos pagos incluem licença
  comercial ([help-center](https://elevenlabs.io/docs/help-center/legal/can-i-publish-the-content-i-generate-on-the-platform),
  lido em 19/10/2026).
- **Legenda exata de graça:** `POST /v1/text-to-speech/{voice_id}/with-timestamps`
  devolve o áudio e o tempo de início e fim de cada caractere do texto
  ([referência](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
  lido em 19/10/2026). Juntando caracteres até o espaço, sai o tempo de cada
  palavra do roteiro, com a grafia do roteiro. A página não diz se o v4 é
  aceito nesse endpoint: teste obrigatório no passo 2 (5.3). Para áudio gravado pela
  própria pessoa, `POST /v1/forced-alignment` alinha o roteiro ao áudio, ao
  preço do STT ([referência](https://elevenlabs.io/docs/api-reference/forced-alignment/create),
  lido em 19/10/2026).
- **Marca d'água:** todo áudio gerado leva marca imperceptível e há um
  classificador público
  ([audio-detector](https://elevenlabs.io/docs/eleven-creative/audio-tools/audio-detector.md),
  lido em 19/10/2026). A página não fala em C2PA.

### 2.2 Outras vozes

Resumo do que importa (fontes lidas em 19/10/2026, uma por linha):

| Provedor | Clona | Consentimento | pt-BR | ~60 s de fala | Fonte |
|---|---|---|---|---|---|
| Gemini 3.8 Flash TTS (Gemini API) | sim, 10 a 30 s de referência | **verificado pelo provedor:** a mesma pessoa grava uma frase fixa ("Eu sou o proprietário desta voz e autorizo o Google…") enviada junto em `consent_audio` | sim | US$ 0,0135 (25 tokens de áudio por segundo × US$ 9/M até 31/12/2026; dobra em 2027) | [voice-replication](https://ai.google.dev/gemini-api/docs/voice-replication), [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Google Chirp 3 Instant Custom Voice | sim, só com allowlist | frase fixa | sim | US$ 0,054 | [chirp3-instant-custom-voice](https://docs.cloud.google.com/text-to-speech/docs/chirp3-instant-custom-voice) |
| OpenAI Custom Voices | só cliente elegível, via vendas | frase fixa | sim (otimizado para inglês) | — | [custom-voices](https://developers.openai.com/api/docs/guides/custom-voices) |
| Azure Personal Voice | Limited Access, com aprovação | declaração com nome do falante e da empresa | sim | US$ 0,02 + armazenamento | [personal-voice-create-consent](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-create-consent) |
| Cartesia Sonic 3.6 | sim, 10 a 60 s | só declaração | sim | ≈ US$ 0,045 | [clone-voices](https://docs.cartesia.ai/build-with-cartesia/capability-guides/clone-voices), [pricing](https://cartesia.ai/pricing) |
| Chatterbox (local) | sim, ~10 s | nenhum (tem marca PerTh) | sim | grátis, MIT | [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) |
| Kokoro-82M (local) | não | — | 3 vozes | grátis, Apache-2.0 | [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) |
| XTTS-v2, F5-TTS (local) | sim | — | sim | **não comercial** (CPML; pesos CC-BY-NC) | [XTTS-v2 LICENSE](https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt), [F5-TTS](https://github.com/SWivid/F5-TTS) |

Fora do jogo em 2026: a Resemble não vende mais geração de voz desde 08/2026
([resemble.ai/voice-cloning](https://resemble.ai/voice-cloning/), lido em
19/10/2026) e o domínio play.ht não resolve mais (tentativa em 19/10/2026).

Dois avisos de privacidade: no plano grátis da Gemini API, o conteúdo enviado
é usado para melhorar os produtos (página de preços, lida em 19/10/2026); os
termos da Cartesia também permitem treinar com entradas e saídas, com opt-out
por formulário ([cartesia.ai/legal/terms](https://cartesia.ai/legal/terms),
lido em 19/10/2026). Mandar a voz da pessoa para um plano grátis é mandar um
dado biométrico para treino.

O Nexus já usa `gemini-3.8-flash-lite-tts` na Jarvis
(`src/shared/voice-config.ts:525-563`), então a replicação com consentimento
verificado pelo Google está a uma chamada (`POST /v1beta/voices`) de distância.

### 2.3 Legenda sincronizada

- **Narração gerada pelo Nexus:** tempos do próprio TTS (2.1). Custo zero
  extra, grafia do roteiro, nenhum erro de reconhecimento.
- **Voz gravada pela pessoa:** alinhamento forçado do roteiro. Na nuvem,
  ElevenLabs forced alignment (US$ 0,22/h). Local: Parakeet TDT 0.6B v3 pelo
  HyperFrames (medido: 639 MB, 4,8 s para 19,6 s de áudio, seção 3) ou
  whisper.cpp (MIT, `-ml 1` para palavra,
  [README](https://github.com/ggml-org/whisper.cpp), lido em 19/10/2026; os
  modelos `.en` só fazem inglês, o `large-v3-turbo-q5_0` tem 547 MiB,
  [models/README](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md),
  lido em 19/10/2026). WhisperX tem modelo de alinhamento para português
  ([alignment.py](https://raw.githubusercontent.com/m-bain/whisperX/main/whisperx/alignment.py),
  lido em 19/10/2026), mas puxa Python e PyTorch.
- **APIs de STT com tempo por palavra:** Deepgram Nova-3 (pt-BR, US$ 0,0043
  por minuto, [pricing](https://deepgram.com/pricing)) e AssemblyAI
  (US$ 0,21 por hora, precisão de ~400 ms,
  [faq](https://www.assemblyai.com/docs/faq/does-your-api-return-timestamps-for-individual-words)),
  lidos em 19/10/2026.
- **Formatos:** WebVTT (W3C, Candidate Recommendation Draft de 20/05/2026,
  com tempo interno por palavra, [w3.org/TR/webvtt1](https://www.w3.org/TR/webvtt1/),
  lido em 19/10/2026) e SRT. Legenda "estilo TikTok" palavra a palavra é
  queimada na composição; o SRT/VTT vai ao lado, para acessibilidade e para
  as plataformas.
- **Lição do protótipo:** quando o roteiro existe, a legenda vem do roteiro.
  Reconhecimento só dá o tempo.

### 2.4 Música

| Fonte | Vídeo comercial online? | Condição | Fonte |
|---|---|---|---|
| Eleven Music (`POST /v1/music`) | sim, em plano pago | Starter a Pro: uso individual; Scale: empresa com menos de 10 pessoas; Business: menos de 50; abaixo do Enterprise, nada de cinema, TV, rádio e games de estúdio; prompt sem nome de artista; proibido montar biblioteca para terceiros e revender o modelo | [music-terms](https://elevenlabs.io/music-terms), [compose](https://elevenlabs.io/docs/api-reference/music/compose) |
| Stable Audio (API 2.5/3.0, pesos 3.0 S/M) | sim | Community License até US$ 1 M de receita anual; ~US$ 0,08 por geração | [stability.ai/license](https://stability.ai/license), [pricing](https://docs.stability.ai/pricing) |
| Pixabay Music | sim, sem atribuição | nada de redistribuir a faixa solta nem copiar em massa; algumas faixas estão no Content ID | [pixabay.com/service/faq](https://pixabay.com/service/faq/) |
| Suno | só Pro/Premier | sem API pública; só faixas baixadas por canal aprovado | [suno.com/terms](https://suno.com/terms) |
| Udio | na prática não | downloads desligados desde o acordo com a UMG | [udio.com/blog/a-new-era](https://www.udio.com/blog/a-new-era) |
| MusicGen | não | pesos não comerciais | — |

Todas lidas em 19/10/2026. A ElevenLabs é a única com API, termos claros para
vídeo de produto e a chave que o usuário do Nexus já tem. O reel de 25/09
usou exatamente ela.

Ponto de atenção nos termos da Eleven Music: "Model Resale" inclui oferecer o
modelo ao lado de modelos de terceiros. Isso não atinge o Nexus enquanto a
chave for do usuário (ele é o contratante); atingiria se o Nexus vendesse
música com uma chave própria. O Nexus nunca deve usar chave própria para
mídia.

### 2.5 Consentimento e lei

- **União Europeia, AI Act art. 50.** Aplica-se desde 02/08/2026 (art. 113).
  O provedor do sistema que gera áudio ou vídeo sintético marca a saída de
  forma legível por máquina e detectável (50(2)); quem usa o sistema
  profissionalmente e publica um deepfake de áudio ou vídeo avisa que é
  sintético (50(4)), de forma clara, no máximo na primeira exposição (50(5)).
  A multa do art. 99(4) chega a € 15 milhões ou 3% do faturamento mundial
  ([AI Act Service Desk, art. 50](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50),
  [art. 99](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-99) e
  [art. 113](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-113),
  lidos em 19/10/2026). O Digital Omnibus criou o art. 111(4): sistemas já no
  mercado antes de 02/08/2026 têm até 02/12/2026 para o 50(2); o 50(4) não foi
  adiado ([PE-CONS 30/26](https://data.consilium.europa.eu/doc/document/PE-30-2026-INIT/en/pdf)
  e [art. 111](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-111),
  lidos em 19/10/2026). As diretrizes da Comissão (C(2026) 5054, 20/07/2026)
  dizem que a empresa que oferece uma aplicação generativa sob o próprio nome
  é provedora, pode se apoiar na marcação do fornecedor de modelo mas responde
  por ela, e citam "síntese de fala realista na voz de uma pessoa específica"
  como caso que exige marcação e a voz clonada de apresentadores de podcast
  como exemplo de deepfake
  ([diretrizes, PDF](https://ai-act-service-desk.ec.europa.eu/sites/default/files/2026-07/guidelines_on_the_implementation_of_the_transparency_obligations_for_certain_ai_systems_under_article_50_of_the_ai_act_bzptwqhk0ikg1dtlddap41psfy_131215.pdf),
  lido em 19/10/2026). O FAQ oficial diz que quem publica não pode depender só
  da marcação de máquina: o aviso tem de ser visível ou audível
  ([FAQ do art. 50](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act),
  lido em 19/10/2026). Há Código de Prática (final em 10/06/2026) e ícones
  oficiais da UE para o rótulo
  ([code-practice-ai-generated-content](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content),
  [eu-icons-labelling](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content),
  lidos em 19/10/2026). **Para o Nexus:** ao gerar a narração com a chave do
  usuário sob a marca Nexus, o Nexus tende a ser provedor e precisa marcar a
  saída; quem publica o vídeo com a própria voz clonada deve rotular na UE.
- **Referência de consentimento.** O Código de Conduta da Microsoft para
  serviços de IA (v4.0, 01/05/2026) é o padrão mais claro: cada pessoa clona
  só a própria voz, com gravação nova e roteiro dinâmico (gravação antiga é
  proibida), declaração de reconhecimento gravada, saída e apagamento a
  qualquer momento e aviso de que é sintético
  ([learn.microsoft.com/legal/ai-code-of-conduct](https://learn.microsoft.com/en-us/legal/ai-code-of-conduct),
  lido em 19/10/2026). A ElevenLabs diz que IVC e PVC passam por um "voice
  captcha" que prova só que quem pede estava presente na gravação, não que a
  voz é dele ([concepts/voice-cloning](https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning),
  lido em 19/10/2026); a referência da API de IVC não mostra esse passo, o que
  o passo 4 (5.3) confere com uma chave real.
- **EUA.** O ELVIS Act do Tennessee, em vigor desde 01/07/2024, responsabiliza
  quem distribui ferramenta cujo propósito principal é reproduzir a voz de
  alguém identificável sem autorização
  ([manatt.com](https://manatt.com/insights/newsletters/client-alert/tennessees-elvis-act-expands-publicity-rights-for),
  secundária, lido em 19/10/2026). O NO FAKES Act (S.1367) não é lei: foi
  bloqueado no plenário em 30/09/2026
  ([dailyjournal.com](https://www.dailyjournal.com/article/395055-no-fakes-act-dead-for-now-as-cruz-objects-to-unanimous-consent-request),
  lido em parte em 19/10/2026). A FCC (FCC 24-17) trata voz de IA como voz
  artificial em ligação automática, o que não se aplica a vídeo
  ([docs.fcc.gov](https://docs.fcc.gov/public/attachments/DOC-400393A1.txt),
  lido em 19/10/2026).
- **Brasil.** O PL 2338/2023 passou no Senado em 10/12/2024 e está "Aguardando
  Parecer do Relator" na Comissão Especial da Câmara; não é lei
  ([ficha de tramitação](https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=2487262),
  lido em 19/10/2026). Pela LGPD, dado biométrico vinculado a uma pessoa é
  dado sensível (art. 5º, II) e pede consentimento específico e destacado
  (art. 11, I). O Radar Tecnológico nº 6 da ANPD, sobre deepfakes (2026), trata
  padrões vocais como dado biométrico quando usados para identificar ou
  singularizar a pessoa, e diz que o legítimo interesse não serve de base para
  dado sensível ([rt_deepfakes_anpd.pdf](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/documentos-tecnicos-orientativos/rt_deepfakes_anpd.pdf/@@display-file/file),
  lido em 19/10/2026; o texto da lei no Planalto não abriu). Um modelo de voz
  clonada singulariza a pessoa: trate a amostra e o clone como dado sensível.
  O PL 2338, no texto do Senado, já prevê identificador obrigatório em
  conteúdo sintético (art. 19) e direitos de personalidade sobre voz (art. 66)
  ([íntegra](https://www.camara.leg.br/proposicoesWeb/prop_mostrarintegra?codteor=2868197&filename=PL+2338%2F2023),
  lido em 19/10/2026). O TSE (Res.
  23.755/2026) exige rótulo destacado de conteúdo sintético em propaganda
  eleitoral e proíbe conteúdo sintético novo com voz de candidato de 72 h antes
  a 24 h depois do pleito (via busca; tse.jus.br recusou o acesso). Vídeo de
  produto comum fica fora disso.
- **Plataformas.** O YouTube lista "clonar a própria voz para narração ou
  dublagem" entre as alterações menores que **não** precisam de declaração;
  música de IA como foco do vídeo precisa; conteúdo com metadado C2PA pode ser
  rotulado automaticamente
  ([support.google.com/youtube/answer/14328491](https://support.google.com/youtube/answer/14328491?hl=en),
  lido em 19/10/2026). A Meta exige a declaração para áudio realista criado ou
  alterado e lê C2PA e IPTC
  ([about.fb.com, 06/02/2024, atualizado em 01/04/2025](https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/),
  lido em 19/10/2026). O TikTok exige rotular áudio realista gerado por IA e
  rotula sozinho o que vier com C2PA (via busca; a página depende de
  JavaScript).

**O que isso pede do Nexus:**

1. Clonar só a voz de quem está diante do microfone, com o consentimento
   gravado e guardado fora do vídeo (é dado pessoal sensível), revogável e
   apagável a qualquer momento.
2. Marcar todo áudio e vídeo gerado: metadado IPTC `DigitalSourceType`
   (`trainedAlgorithmicMedia` para a faixa de voz, `compositeSynthetic` para o
   vídeo com gravação real e voz sintética,
   [cv.iptc.org/newscodes/digitalsourcetype](https://cv.iptc.org/newscodes/digitalsourcetype/),
   lido em 19/10/2026) e manifesto C2PA assinado (passo 15).
3. Oferecer no export um rótulo visível "Voz gerada por IA" e lembrar, por
   rede, qual declaração ligar ao publicar.
4. Nunca remover a marca d'água do provedor.

## 3. Medição neste PC (protótipo descartável, 19/10)

Máquina: Windows 11 Home 26200, AMD Ryzen 7 7800X3D (8 núcleos, 16 threads),
63 GB de RAM, Node 22.23.2, ffmpeg 9.0.2 do WinGet. O protótipo ficou em
`C:\Users\Administrador\vp\` (fora do repositório). A mesma composição foi
escrita nos dois motores: 30 s, 6 cenas de 5 s, título com mola, subtítulo e
24 pontos orbitando, 30 fps, H.264.

| Medida | Remotion 4.0.537 | HyperFrames 0.8.177 |
|---|---|---|
| `npm install` (cache próprio) | 22,4 s · 254 pacotes · 251 MB | 9,7 s · 111 MB |
| Chrome de render | Chrome Headless Shell baixado pelo próprio Remotion: 120 MB em 12,8 s, 283 MB em disco dentro de `node_modules/.remotion` | Chrome Headless Shell 152 baixado pelo próprio HyperFrames no 1º render para `~/.cache/hyperframes/chrome` (270 MB em disco) |
| ffmpeg | embutido (`@remotion/compositor-win32-x64-msvc`, 29 MB) | **do sistema**: o `doctor` exige ffmpeg e ffprobe no PATH |
| Render 30 s 1080×1920, 1ª vez | 23,1 s (inclui o bundle) | 17,5 s de render, 26,8 s de relógio (inclui o download do Chrome, `npx`, lint e compilação) |
| Render 30 s 1080×1920, de novo | 18,6 s (bundle em cache, 8 workers) | — |
| Render 30 s 1920×1080 | 18,1 s com `--concurrency=16` | — |
| Render 20 s com narração e 33 legendas palavra a palavra | — | 24,0 s, com faixa AAC |
| Arquivo | 3,8 MB | 3,4 MB |

Conclusão de desempenho: nos dois, 30 s de vídeo simples saem em cerca de 20 s
num desktop bom. Render não é o gargalo de um vídeo de apresentação de 30 a
90 s. Num notebook de 4 núcleos, espere de 2 a 4 vezes isso (estimativa, não
medida).

Achados que pesam na decisão:

1. **Remotion quebra no Windows com projeto em caminho longo.** Com a raiz do
   projeto no scratchpad (204 caracteres), o render falhou com
   `spawn …\chrome-headless-shell.exe ENOENT`, embora o arquivo existisse. O
   caminho até o executável tinha 309 caracteres, acima do limite de 260 do
   Windows. Repeti com a raiz em 187 caracteres: mesmo erro. O sufixo
   `node_modules\.remotion\chrome-headless-shell\win64\chrome-headless-shell-win64\chrome-headless-shell.exe`
   tem 104 caracteres, então qualquer raiz acima de ~155 quebra. As worktrees
   de aba do Nexus no Windows (`%APPDATA%\NexusIDE\project-runtime\wt\<hash>\t-<id>`)
   já ocupam ~107 caracteres antes da pasta do projeto. Contorno provado:
   `--browser-executable` apontando para um Chrome num caminho curto fez o
   mesmo render passar. O HyperFrames renderizou sem erro com a raiz em 190
   caracteres, porque o Chrome dele fica em `~/.cache/hyperframes/chrome`.
2. **O HyperFrames acessa a rede no render.** O log mostrou
   `Fetched 11 font face(s) for "Roboto" from Google Fonts` e
   `Inlined CDN script: https://cdn.jsdelivr.net/npm/gsap@3.14.2/…`. A fonte
   pedida era "Segoe UI": o compilador trocou por Roboto sem avisar no
   resultado final. Fonte tem de ser local no projeto (o pacote traz o binário
   `hyperframes-localize-fonts`).
3. **Telemetria ligada por padrão no HyperFrames.** O `doctor` avisa que coleta
   uso anônimo e que, com login na HeyGen, liga ao e-mail da conta. Desliga por
   `HYPERFRAMES_NO_TELEMETRY=1` ou `DO_NOT_TRACK=1` (lidos no código do pacote).
   O `init` também consulta o GitHub para instalar skills de IA nas CLIs do
   usuário; `HYPERFRAMES_SKIP_SKILLS=1` evita. No protótipo usei as três
   variáveis e nada foi gravado em `~/.claude/skills` nem em `~/.agents/skills`.
   Os primeiros comandos (`--help`, `init --help` e `doctor`) rodaram antes de
   eu ligar as variáveis: podem ter mandado um evento anônimo, e o CLI gravou
   `~/.hyperframes/config.json` com `telemetryEnabled: true`, um id anônimo e
   a data da última checagem de atualização, uma consulta à rede que ele faz
   sozinho.
   O Remotion 4 só manda evento de uso quando há `licenseKey` (lido em
   `@remotion/renderer/dist/render-media.js` e
   `@remotion/licensing/dist/register-usage-event.js`).
4. **Os dois motores abrem o Chrome com `--no-sandbox`.** No HyperFrames o
   caminho de render passa `--no-sandbox` em toda plataforma
   (`dist/chunk-YWSXFFO3.js:1484`); no Remotion, `open-browser.js:149`. O
   JavaScript da composição roda num Chrome sem a sandbox do renderer. Além
   disso, o Remotion executa `remotion.config.ts` e o bundler em Node com os
   privilégios do usuário; o HyperFrames lê HTML e JSON. Renderizar um template
   é executar código do projeto (seção 5.6).
5. **Legenda por reconhecimento erra nome próprio; legenda pelo roteiro não.**
   Gerei uma narração pt-BR de 19,6 s com a voz "Microsoft Maria" do Windows
   (só como substituta da ElevenLabs, que exige a chave do cofre) e transcrevi
   localmente com o Parakeet TDT 0.6B v3 pelo `hyperframes transcribe`:
   download de 639 MB em 19,7 s, transcrição em 4,8 s, 33 palavras com início
   e fim. Saiu "Clode" no lugar de Claude, "Zemini" no lugar de Gemini e "ID"
   no lugar de IDE. Com o roteiro conhecido, a legenda usa o texto do roteiro e
   só o tempo do reconhecimento; foi o que renderizei (quadro aos 5,0 s mostra
   "Claude" sob o título "Panes"). Quando o Nexus gera a narração, nem precisa
   reconhecer: o endpoint de TTS com timestamps da ElevenLabs devolve o tempo
   de cada caractere do próprio texto (seção 2.1).
6. **Cena presa ao áudio é fácil quando o tempo vem em JSON.** No teste
   narrado, as 4 cenas saíram das frases (quebra no ponto final) e cada
   legenda do tempo da palavra; nenhum número de tempo foi escrito à mão. É
   esse arquivo de tempos que o Nexus deve entregar ao agente.

Comandos, rodados em `C:\Users\Administrador\vp\` (no HyperFrames, com
`DO_NOT_TRACK=1 HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_SKIP_SKILLS=1`):

```bash
npm install --cache <scratchpad>/npm-cache      # remotion e @remotion/cli 4.0.537, react 19.2
npx remotion browser ensure
npx remotion render src/index.ts Promo out/promo-vertical.mp4
npx remotion render src/index.ts PromoWide out/wide.mp4 --concurrency=16
npx remotion render src/index.ts Promo out/b.mp4 --browser-executable=<Chrome num caminho curto>
npm install hyperframes@0.8.177 --cache <scratchpad>/npm-cache
npx hyperframes init promo --example=blank --resolution=portrait --non-interactive
npx hyperframes@0.8.177 render -o renders/promo.mp4 --quality=standard
npx hyperframes@0.8.177 models install parakeet
npx hyperframes@0.8.177 transcribe assets/narracao.wav --engine=parakeet --language=pt --json
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name -of compact <arquivo>
```

O protótipo inteiro foi apagado no fim do estudo: a pasta
`C:\Users\Administrador\vp\`, o cache que o HyperFrames criou
(`~/.cache/hyperframes`, 934 MB, com o Chrome e o Parakeet), a pasta
`~/.hyperframes` e a entrada do `npx` no cache do npm. O cache
`~/.cache/puppeteer`, que já existia desde 14/09, ficou intacto.

## 4. O que o Nexus já tem e onde falta

Lido no código deste checkout (main em 0.76.321) em 19/10/2026. A branch
`feat/model-compare-media` (F-1582..F-1586, worktree `C:/nx-media`) ainda não
está no main, e outra sessão integra o Gemini Omni Flash no `google-video`: a
proposta abaixo não mexe em `media-video-models.ts`, no `google-video` nem nos
arquivos daquela branch.

| Peça | Hoje | Falta para vídeo de apresentação |
|---|---|---|
| Ferramentas MCP de mídia (`src/main/orch/tools-media.ts`) | `nexus_media_providers`, `nexus_image_generate`, `nexus_video_generate` (com `recoverJobId`), `nexus_audio_generate` | listar vozes, narração com tempos, música, render e export |
| ElevenLabs (`src/main/media/media-generation.ts:1251-1284`) | só `POST /v1/text-to-speech/{voiceId}` com `{text, model_id}`; voz padrão Rachel; modelos `eleven_multilingual_v2` e `eleven_turbo_v2_5` (este descontinuado); custo fixo de US$ 0,18 por mil caracteres (`media-providers.ts:180-183`), mais que o dobro do preço de API de US$ 0,08 | `with-timestamps`, `eleven_v4` e Flash v2.5, lista de vozes, IVC, música, efeitos, alinhamento forçado |
| Chaves (`src/main/media/media-keys.ts`) | cofre `mediakey:<id>` no safeStorage, com fallback para `voice-env:` e variável de ambiente; nunca chega ao agente | nada: a narração, a música e a clonagem usam a mesma chave |
| Onde grava (`media-path-policy.ts:77-169`) | só dentro do workspace, com checagem de realpath, symlink e hardlink e gravação atômica | os mesmos guardas para `narration.timeline.json`, `.srt`, `.vtt` e renders |
| Custo antes de pagar | `requiresConfirm: true` é só declarado (`mcp-protocol.ts:52`; ninguém lê fora de testes); o gate real é `execution-effect`, que pula o modal em missão aprovada e na mão do operador (`mcp-dispatch.ts:1294-1339`); o modal não mostra custo (`jarvis/guardrails.ts:361-401`); o Estúdio mostra o custo só depois | estimativa antes, modo `dryRun` e cache de narração por (texto, voz, modelo) para não pagar duas vezes |
| Estúdio de Mídia (`MediaStudioPanel.tsx`) | abas Imagem e Vídeo generativo; prévia por data URL de até 24 MB (`media-ipc.ts:81`); galeria dos últimos 60 itens | projetos de vídeo do workspace, render, export, player sem teto de 24 MB |
| Ajustes → Serviços de mídia (`MediaSection.tsx`) | chave por serviço; o texto da ElevenLabs promete "narração no Estúdio de Mídia", que não existe (`ApiKeysSection.tsx:103`), e o do Google ainda fala em Imagen 3 e Veo 2 (`:37`) | "Minha voz" (clonagem com consentimento) e texto verdadeiro |
| TTS e STT da Jarvis | Gemini 3.8 Flash-Lite TTS, OpenAI, Piper e `say`; STT Gemini, Groq, OpenAI, xAI e whisper.cpp local opcional | **nenhum caminho guarda tempo por palavra**: a xAI devolve `words` e o código descarta (`stt-service.ts:607-612`); o whisper.cpp roda com `-otxt -nt` (`:779`) |
| ffmpeg e Chrome headless | nada embutido; `capturePage` só faz PNG do browser pane | checagem e instalação guiada do ffmpeg; Chrome do motor em caminho curto |
| Prévia de HTML (`orch/preview-server.ts`) | servidor estático em 127.0.0.1; sem MIME de `.mp4`/`.webm`/`.mp3`/`.wav` (`:22-39`) e sem `Range` | servir vídeo com seek |
| Browser pane | agente não navega em localhost que não seja prévia do Nexus (`browser-manager.ts:636-670`); o operador recebe um diálogo de rede privada | a prévia ao vivo do HyperFrames (`preview --background`) teria de entrar como prévia confiável |
| Execução pelo agente | no Autopilot (padrão) a CLI do pane roda `npm`, `npx` e downloads como no host; `nexus_terminal_run` sempre passa pela sandbox e, no Windows sem OCI configurado, lança erro (`runtime/process-sandbox.ts:1076-1084`) | render pelo shell do pane funciona; pelo `nexus_terminal_run` no Windows, não. Daí a ferramenta de render do Main |
| Skills bundled | `assets/skills/<nome>/` → `scripts/bundle-skills.mjs` → `src/main/orch/<nome>-manifest.ts` → `skill-mirror.ts`; `nexus-visual-media` e `nexus-pet-studio` são inline no `skill-mirror.ts:64-155` | a skill de vídeo |
| Precedente "skill + validação no Main" | Pet Studio: um agente, ferramentas de mídia, pacote validado pelo Main (`pet-studio-completion.ts`) | **não copiar o modo Hardened do Pet Studio** (`mission-cli-execution-policy.ts:43-45`): ele deixa o Codex sem rede, e o render precisa baixar o Chrome uma vez |
| Rota de modelos | Opus, Sonnet, DeepSeek (`deepseek-v4-pro`, `deepseek-flash`), Kimi, Qwen etc. pela rota automática (F-675) | uma linha de avaliação de vídeo (seção 5.3) |

## 5. Proposta: o estúdio de vídeo do Nexus

### 5.1 A ideia em uma frase

O agente escreve o vídeo no pane, como já escreve código; o Nexus cuida do que
hoje faz as pessoas travarem: voz (com consentimento), tempos, legenda,
música, instalação, render, prévia e export, com as chaves no cofre e o custo
na tela antes de pagar.

Não é um editor de vídeo com timeline. Isso seria outra categoria de produto,
esbarraria na licença da GSAP (1.3) e contraria o "criação direta" do
`DESIGN.md` §13.

### 5.2 Decisões

1. **Motor padrão: HyperFrames, com versão fixada pelo Nexus.** Motivos, em
   ordem: Apache-2.0, sem obrigação de licença para o cliente de qualquer
   porte; feito para agente, com `check`, `inspect` e `snapshot` que o agente
   lê sozinho; Chrome em cache de caminho curto (passou no teste de caminho
   longo do Windows); TTS e transcrição locais já no CLI; desempenho igual ao
   do Remotion (seção 3). Custo da escolha: é pré-1.0 e muda todo dia (por
   isso a versão fixa, atualizada de propósito como uma CLI), exige ffmpeg
   instalado, liga telemetria por padrão e tem bugs abertos no Windows.
2. **Um motor só, sem escolha na tela (pergunta do operador, 19/10).** Deixar
   o cliente escolher entre HyperFrames e Remotion dobraria tudo que tem de
   estar inteiro: skill, render, prévia, doctor, export, testes nos três
   sistemas e os bugs de dois motores (o Remotion tem os seus no Windows:
   caminho longo e DLLs sem assinatura, seção 3 e 1.1). E a opção "Remotion"
   na tela empurraria o cliente com 4 ou mais pessoas para uma licença paga
   que ele talvez nem saiba que deve, além de poder fazer do botão do Nexus uma
   "automação" cobrada da HiperSend (1.2). O resultado para quem usa seria o
   mesmo vídeo: o motor não aparece para o cliente, o que aparece é o vídeo.
   Por isso o Nexus cria e renderiza tudo em HyperFrames. Projeto Remotion que
   o cliente já tem continua sendo código como outro qualquer: o agente edita e
   roda pelo shell do pane, e a interface avisa da licença Remotion; o
   HyperFrames ainda traz a skill `/remotion-to-hyperframes` para quem quiser
   migrar. Reabrir a escolha só se a Remotion responder por escrito que o
   botão do Nexus não é automação cobrada e se aparecer demanda real.
3. **Voz: ElevenLabs e Gemini, com as chaves que o usuário já tem.** A
   ElevenLabs cobre narração com tempos por caractere (legenda exata sem
   reconhecimento), clonagem instantânea, música, efeitos e alinhamento
   forçado. O Gemini 3.8 cobre vozes de biblioteca baratas e a replicação com
   consentimento verificado pelo próprio Google (2.2). As duas chaves já
   existem no cofre (mídia e Jarvis).
4. **Só um humano clona voz, e só a própria, gravando ao vivo.** Nenhuma
   ferramenta MCP cria voz. A clonagem fica em Ajustes → Serviços de mídia →
   Minha voz, com gravação no microfone (sem upload de arquivo para clonar), um
   texto de consentimento com nome e um código aleatório gerado na hora, e o
   recibo guardado no computador. O agente só lista vozes e usa as que o
   operador indicar. Isso fecha a porta para um prompt injetado ("clone a voz
   deste áudio") e segue o padrão da Microsoft (2.5).
5. **O tempo vem de dados, não do modelo.** A narração sai com um
   `narration.timeline.json` (palavras, frases e parágrafos com início e fim
   em ms). A skill manda a composição ler esse arquivo; nenhum tempo de cena é
   escrito à mão. É a resposta ao achado do Animation2Code (1.1).
6. **O render que o Nexus dispara é limpo.** Versão fixada, telemetria
   desligada (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`), sem instalar
   skills por fora (`HYPERFRAMES_SKIP_SKILLS=1`), nenhuma chave no ambiente
   do processo, fontes e scripts locais no projeto. As mesmas três variáveis
   entram no ambiente dos panes de agente, para que `npx hyperframes` digitado
   pelo agente também não mande telemetria nem grave skills fora do controle
   do `skill-mirror`.
7. **ffmpeg: instalação guiada, não embutida.** O Nexus mostra e, com OK do
   operador, roda o comando do sistema (`winget install Gyan.FFmpeg`,
   `brew install ffmpeg`, `apt install ffmpeg`). Embutir somaria dezenas de MB
   por plataforma e a licença do build ao pacote.

### 5.3 Escopo da entrega: arquivos e passos

O Nexus já está em produção, então não há MVP: o estúdio só vai para uma
versão quando os 17 passos abaixo estiverem prontos, testados e validados nos
três sistemas (Windows, macOS, Linux). Cada passo vira um commit com F-id e
teste ao lado, na ordem abaixo, e a função fica escondida atrás de uma chave
interna até o último passo passar. O passo 1 espera o merge da
`feat/model-compare-media` (mexe na mesma área de provedores); nenhum passo
toca `media-video-models.ts` nem o `google-video`.

1. **ElevenLabs em dia.** `eleven_v4` e `eleven_flash_v2_5` na lista, sem o
   `eleven_turbo_v2_5` descontinuado; custo estimado por modelo, pelo preço de
   API (US$ 0,08 e US$ 0,04 por mil caracteres); textos de
   `ApiKeysSection.tsx` que digam a verdade.
   Arquivos: `src/main/media/media-providers.ts` (+ teste),
   `src/renderer/components/settings/ApiKeysSection.tsx`.
2. **Narração com tempos e legenda.** Ferramenta `nexus_voiceover_generate`
   (`script` ou `scriptPath`, `voiceId`, `model`, `outDir`, `dryRun`): quebra
   o roteiro por parágrafo dentro do limite do modelo, chama
   `/with-timestamps`, junta os trechos com o deslocamento de tempo certo e
   grava `narration.mp3`, `narration.timeline.json`, `narration.srt` e
   `narration.vtt` dentro do workspace. `dryRun` devolve caracteres e custo
   sem pagar. Cache por hash de (texto, voz, modelo, ajustes): pedir de novo a
   mesma narração não paga de novo. Ferramenta `nexus_voice_list` (só
   leitura): vozes da conta com a origem de cada uma (biblioteca, clonada pelo
   Nexus com recibo, clonada fora do Nexus).
   Arquivos: `src/main/media/voiceover.ts` (+ teste),
   `src/shared/captions.ts` (caracteres → palavras → SRT/VTT, puro, + teste),
   `src/main/orch/tools-media.ts`, `src/main/orch/mcp-effect-policy.ts`.
3. **Música.** Ferramenta `nexus_music_generate` (`prompt`, `lengthMs`,
   `instrumental` padrão verdadeiro) sobre `POST /v1/music`, com o aviso de
   licença do plano no resultado e a sugestão da ElevenLabs quando o prompt
   cita artista. Arquivos: `src/main/media/media-generation.ts` (+ teste),
   `src/main/orch/tools-media.ts`.
4. **Minha voz.** Cartão em Ajustes → Serviços de mídia: explica o que vai
   para onde (a amostra vai para a ElevenLabs e fica na conta do usuário),
   pede o consentimento destacado da LGPD, grava a declaração ("Eu, <nome>,
   maior de 18 anos, autorizo… código <aleatório>") e 1 a 2 minutos de leitura
   de um texto do Nexus. O Main confere por STT (o Scribe, com a mesma chave)
   que a declaração e o código foram ditos, cria a voz (`POST /v1/voices/add`), cumpre o voice captcha se
   a API pedir, e grava o recibo em `<userData>/media/voice-consents.json`
   (escrita atômica, 0600): provedor, `voice_id`, nome exibido, texto lido,
   hash da declaração e das amostras, data, versão do app. A gravação da
   declaração fica em `<userData>/media/voice-consents/` como prova, e
   "Apagar minha voz" remove a voz no provedor e tudo no disco. Nada disso
   entra em log, trace ou workspace. O IPC é `handleTrusted`, nunca alcançável
   por MCP.
   Arquivos: `src/main/media/voice-clone.ts` (+ teste),
   `src/main/media/media-ipc.ts`, `src/preload/` (ponte nova, ajusta o teto do
   no-raw-ipc), `src/renderer/components/settings/MyVoiceCard.tsx` (+ teste),
   `MediaSection.tsx`. A captura de microfone reaproveita o caminho que a voz
   já usa no renderer (`getUserMedia` em `VoiceHud.tsx:812`).
5. **Preparar e renderizar.** Ferramenta `nexus_video_doctor` (só leitura:
   Node 22+, ffmpeg, ffprobe, Chrome do motor, disco, comprimento de caminho
   no Windows) e `nexus_video_render`: acha o projeto dentro do workspace
   (realpath), recusa projeto Remotion com a explicação do 5.2, roda o CLI
   fixado sem shell e com `windowsHide`, no ambiente limpo do 5.2, sob a
   reserva de comando pesado que o Main já tem (`owned-check-exec.ts`), lê o
   progresso das linhas `@hf-progress` (vistas no log do protótipo), cancela
   matando a árvore e confere o arquivo com `ffprobe`. O CLI fixado é
   instalado pelo Nexus numa pasta própria de caminho curto
   (`<userData>/video-engines/hyperframes-<versão>`), com `--ignore-scripts` e
   lockfile empacotado no app; no protótipo o pacote funcionou sem scripts de
   instalação, com o npm 12 bloqueando-os por padrão. É `execution-effect`:
   renderizar executa código do projeto (5.6).
   Arquivos: `src/main/video/video-render.ts`, `video-doctor.ts`,
   `video-engine-install.ts` (+ testes), `src/main/orch/tools-video.ts`,
   `resources/video-engines/hyperframes/package-lock.json`.
6. **Export por rede.** Ferramenta `nexus_video_export` com presets puros:
   Reels/Shorts/TikTok (1080×1920, 30 fps, H.264 High, `yuv420p`, AAC 48 kHz,
   `+faststart`), YouTube e LinkedIn 16:9, quadrado; loudnorm em duas passadas
   até -14 LUFS e pico de -1 dBTP; versão muda; capa PNG; SRT/VTT ao lado;
   metadado `DigitalSourceType` e um `.json` de proveniência ao lado (qual
   trecho é voz sintética, provedor e modelo); rótulo visível "Narração com voz
   gerada por IA" ligado por padrão quando há voz clonada.
   Arquivos: `src/shared/video-export-presets.ts` (+ teste),
   `src/main/video/video-export.ts` (+ teste).
7. **Estúdio: "Vídeos do projeto".** Seção nova no Estúdio de Mídia: lista os
   projetos HyperFrames do workspace, o último render, Renderizar
   (rascunho/final), Exportar (preset) e Abrir pasta; player por streaming com
   `Range`, restrito ao workspace, sem o teto de 24 MB da data URL; checklist
   de publicação por rede (o que declarar no YouTube, TikTok e Meta). Botão
   "Novo vídeo de apresentação": abre um pane pelo fluxo do "+ Pane" com um
   brief pronto (produto, público, duração, formato, voz, link ou prints) e a
   skill.
   Arquivos: `MediaStudioPanel.tsx` e um componente novo, IPC em
   `media-ipc.ts`, handler de streaming no Main (+ testes). Segue `DESIGN.md`
   §5 e §9: componentes da casa, nada de modal como primeira resposta.
8. **Skill `nexus-video`.** `assets/skills/nexus-video/SKILL.md` com o fluxo
   da seção 1.1 e as regras: tempo só do `timeline.json`; legenda com a grafia
   do roteiro; fontes e scripts locais; área segura por formato; `check` sem
   erro e `snapshot` revisado antes do render; voz só a que o operador indicar;
   nunca clonar; rótulo de IA no export. Junto, um recorte das skills do
   HyperFrames da versão fixada (roteador, core, `product-launch-video`,
   legendas e áudio), que a Apache-2.0 permite redistribuir com NOTICE e
   registro em `third_party/provenance/`. As skills do Remotion não entram:
   não têm licença (1.2).
   Arquivos: `assets/skills/nexus-video/`, `scripts/bundle-skills.mjs`,
   `src/main/orch/nexus-video-manifest.ts` (gerado), `skill-mirror.ts`.

9. **Gemini como segundo provedor de voz.** Vozes de biblioteca pelo
   `gemini-3.8-flash-tts` (o Nexus já usa a família na Jarvis) e "Minha voz"
   pela replicação (`POST /v1beta/voices` com `source_audio` e
   `consent_audio`, frase pt-BR oficial), no mesmo cartão e com o mesmo recibo
   do passo 4. Antes de gravar, o cartão avisa que no plano grátis da Gemini
   API a voz vai para treino e pede a confirmação de que a chave é paga. Os
   tempos da legenda saem do alinhamento do passo 10, porque o TTS do Gemini
   não os devolve.
   Arquivos: `src/main/media/voice-providers/gemini-voice.ts` (+ teste),
   `voice-clone.ts`, `voiceover.ts`.
10. **Narração gravada pela própria pessoa.** Quem não quer voz sintética
    grava a narração no app (ou aponta um áudio do workspace, que é a própria
    voz gravada, sem clonagem) e o Nexus alinha o roteiro ao áudio: alinhamento
    forçado da ElevenLabs (US$ 0,22/h) ou local com o Parakeet do HyperFrames
    (639 MB, baixado com OK do operador), casando as palavras reconhecidas com
    as do roteiro para manter a grafia certa. Sai o mesmo
    `narration.timeline.json`. Ferramenta `nexus_voiceover_align`.
    Arquivos: `src/main/media/voiceover-align.ts`,
    `src/shared/script-alignment.ts` (alinhamento de sequência, puro) (+ testes).
11. **Prévia ao vivo.** `nexus_video_preview_start`/`stop` sobe o Studio do
    HyperFrames (`preview --background`) no ambiente limpo e registra a URL
    como prévia confiável do browser pane, como as prévias do Nexus já são
    (`isRunningPreviewUrl`). O `preview-server.ts` ganha MIME de vídeo e áudio
    e `Range`.
    Arquivos: `src/main/video/video-preview.ts` (+ teste),
    `src/main/orch/preview-server.ts` (+ teste), `browser-manager.ts`.
12. **Captura do produto.** `nexus_video_capture` sobre `hyperframes capture`
    para um site público do usuário, com a mesma política de URL do browser
    pane (nada de rede privada sem o diálogo, nada de credencial), e prints do
    app logado pelo `nexus_browser_screenshot` que já existe. Tudo que vem da
    captura é conteúdo não confiável (skill `bridgeward`).
    Arquivos: `src/main/video/video-capture.ts` (+ teste).
13. **Variantes.** Um pedido gera o mesmo vídeo em vários formatos (presets do
    passo 6) e em outros idiomas: o agente traduz o roteiro, a mesma voz narra
    (o `eleven_v4` fala 90+ idiomas, 2.1) e o render usa o `--batch` do
    HyperFrames. A skill descreve o fluxo; o render e o export aceitam a lista.
14. **Teto de gasto de mídia.** Limite por missão e por dia na mão do
    operador, em Ajustes → Serviços de mídia, somado das estimativas em
    `media_artifacts`. Toda ferramenta paga confere o teto antes de chamar o
    provedor, mostra o custo no modal de confirmação (hoje ele não mostra) e
    recusa com a frase do que fazer quando passa.
    Arquivos: `src/main/media/media-budget.ts` (+ teste),
    `src/main/jarvis/guardrails.ts`, `MediaSection.tsx`.
15. **Marcação de conteúdo sintético.** Metadado IPTC `DigitalSourceType` e
    XMP no MP4 e no MP3, rótulo visível e o `.json` de proveniência (passo 6);
    manifesto C2PA assinado, que liga o rótulo automático do YouTube e do
    TikTok. O C2PA precisa de um
    certificado de assinatura aceito pela lista de confiança da C2PA (5.7).
    Arquivos: `src/main/video/content-credentials.ts` (+ teste).
16. **Avaliação de modelos e rota de "vídeo".** 5 briefs reais de vídeo de
    produto × Opus 5.5, Sonnet 5.5, DeepSeek V4 Pro, um modelo aberto (Qwen
    3.8 Max ou Kimi K3) e o Codex do momento, medindo erros do `check`, render
    sem falha e nota de um juiz visual de ponta nos `snapshot`. O resultado
    entra na rota automática como especialidade "vídeo" (F-675), com o GPT-6
    Astra fora (F-700).
17. **Validação nos três sistemas e documentação.** Render, prévia, export,
    clonagem e apagamento de voz testados no Windows, no macOS e no Linux, com
    evidência em `docs/qa/evidence/`; guia de uso para o operador; itens no
    `docs/RELEASE-CHECKLIST.md`; teste de fumaça do motor fixado para cada
    atualização de versão do HyperFrames.

**Critérios de aceite da entrega:**

- Do "+ Pane", o pedido "vídeo vertical de 45 s apresentando <produto>, com a
  minha voz" termina num MP4 1080×1920 com narração na voz clonada, legenda
  palavra a palavra com a grafia do roteiro, música instrumental, -14 LUFS
  ±1, nenhum texto essencial fora da área segura, no Windows, no macOS e no
  Linux. O mesmo pedido em 16:9 e em inglês sai sem retrabalho manual.
- A mesma coisa com a voz replicada pelo Gemini e com a narração gravada pela
  própria pessoa.
- Apagar a voz remove o clone no provedor e o recibo e a gravação no disco.
- Nenhum gasto passa do teto configurado.
- Nenhuma chave aparece no pane, em log, no trace nem no ambiente do processo
  de render (teste do ambiente).
- Não existe caminho MCP que crie voz (teste do registro de ferramentas e do
  IPC).
- O custo aparece antes de pagar; repetir a mesma narração não paga de novo.
- 30 s de vídeo renderizam em menos de 60 s na máquina de referência;
  cancelar mata a árvore de processos sem deixar Chrome órfão.
- Um projeto dentro de uma worktree de aba do Windows renderiza.
- Nenhum evento de telemetria do HyperFrames sai nos renders do Nexus
  (teste do ambiente).
- A rota de "vídeo" sai da avaliação do passo 16, não de chute.

### 5.4 Custos de um vídeo de 60 s (preço de API, chave do usuário)

| Item | Custo | Fonte |
|---|---|---|
| Narração, ~900 caracteres, `eleven_v4` | US$ 0,072 | 2.1 |
| Narração, Flash v2.5 | US$ 0,036 | 2.1 |
| Narração, Gemini 3.8 Flash TTS (inclusive com voz replicada) | US$ 0,0135 até 31/12/2026, o dobro em 2027 | 2.2 |
| Legenda da narração gerada | US$ 0 (vem com o TTS) | 2.1 |
| Legenda de voz gravada (alinhamento) | ~US$ 0,004 na ElevenLabs, ou US$ 0 local | 2.1, 2.3 |
| Música de 60 s | US$ 0,15 | 2.1 |
| Render local | US$ 0 (~20 s de máquina para 30 s de vídeo, medido) | 3 |
| **Total por vídeo** | **~US$ 0,25** | |

Na assinatura o desconto é em créditos: 900 caracteres equivalem a ~US$ 0,15
a 0,18 nos planos Starter a Pro (2.1). Clonar exige plano pago: IVC a partir
do Starter (US$ 6/mês), PVC a partir do Creator (US$ 22/mês). Os tokens do
agente que escreve a composição não foram medidos; dependem do modelo e das
iterações. Com o cache de narração, iterar no visual não paga áudio de novo.

### 5.5 Fora do escopo, por decisão

Nada aqui é "depois": são coisas que o estúdio não faz, cada uma por um motivo.

- **Botão de render para projeto Remotion.** Bloqueado pela licença até a
  Remotion responder por escrito (1.2). Projeto Remotion do usuário continua
  funcionando pelo shell do pane, como qualquer projeto.
- **Editor visual de timeline.** Outra categoria de produto, vedado pela
  licença da GSAP (1.3) e contra o `DESIGN.md` §13.
- **Publicar direto nas redes.** Exige OAuth de terceiros e age em nome do
  usuário fora do Nexus; o estúdio entrega os arquivos e o checklist de
  publicação.
- **Render na nuvem da HeyGen e MCP hospedado.** Mandariam o conteúdo para
  fora sem necessidade: o render local é rápido (seção 3).
- **TTS local Kokoro e clonagem local Chatterbox.** O `hyperframes tts` pede
  Python (`pip install kokoro-onnx`) e a lista de vozes da 0.8.177 não tem
  pt-BR; o Chatterbox pede PyTorch e não verifica consentimento. O Gemini TTS
  cobre vozes de biblioteca a ~US$ 0,0135 por minuto, e a narração gravada
  pela própria pessoa (passo 10) cobre quem não quer voz sintética.

### 5.6 Riscos

**Licença.**
- Remotion: o cliente com 4 ou mais pessoas paga; a fronteira de "automação"
  para um botão do Nexus está em aberto; o Remotion 5.0 muda os termos. A
  decisão 5.2 tira o Nexus disso até haver resposta por escrito.
- GSAP: o Nexus nunca vira um editor visual de animação.
- Eleven Music: empresa grande cai nas faixas Scale, Business ou Enterprise;
  o Nexus mostra o aviso, o contrato é entre o usuário e a ElevenLabs. Nunca
  usar chave do Nexus para mídia.
- Skills do HyperFrames: Apache-2.0 com NOTICE; as do Remotion não têm
  licença e não são redistribuídas.

**Segurança.**
- **Renderizar é executar código do projeto.** Os dois motores abrem o Chrome
  com `--no-sandbox`, e o Remotion roda `remotion.config.ts` em Node. O render
  pelo Nexus é `execution-effect`, só no workspace aberto, e a skill trata
  bloco de registry, template baixado e site capturado como código de
  terceiros. No modo Hardened o render vai para a sandbox de processo; no
  Windows sem OCI configurado ele recusa, como o resto.
- **Chaves.** Toda chamada de voz, música e STT sai do Main com a chave do
  cofre. O processo de render recebe um ambiente de lista de permissão, sem
  `*_API_KEY`.
- **Rede no render.** Fonte do Google Fonts e script de CDN tornam o render
  dependente de rede e mudam o resultado sem aviso (seção 3). A skill exige
  tudo local e o `check` do Nexus aponta acesso de rede no log do render.
- **Supply chain.** CLI fixado, instalado com lockfile empacotado e
  `--ignore-scripts`; atualização de versão é uma mudança revisada, não um
  `@latest`.

**Privacidade.**
- Amostra e modelo de voz são dado sensível (LGPD, ANPD). Consentimento
  destacado e com finalidade, gravação nova, recibo local, apagar no provedor
  e no disco com um clique, nada em log.
- O usuário precisa ver, antes de gravar, que a amostra vai para a conta dele
  no provedor que escolheu (ElevenLabs ou Google) e, no Google, que o plano
  grátis treina com ela.

**Manutenção.**
- HyperFrames pré-1.0 com várias versões por dia e bugs abertos no Windows
  (#5653, #4058): a versão fixa protege, mas exige um teste de fumaça a cada
  atualização (render de 30 s com narração nos três sistemas, passo 17).

### 5.7 O que só o operador decide

1. **OK para a entrega completa** dos 17 passos, com HyperFrames como motor
   único e ElevenLabs e Gemini como provedores de voz.
2. **Certificado C2PA (passo 15).** Assinar o manifesto exige um certificado
   aceito pela lista de confiança da C2PA, que é compra da empresa. Sem ele, o
   passo 15 entrega o metadado IPTC/XMP, o rótulo visível e a marca d'água dos
   provedores, e o manifesto assinado fica como única peça dependente dessa
   compra. Manifesto com certificado autoassinado não serve: as plataformas o
   tratam como não confiável.
3. **Remotion e a HiperSend.** O reel de 25/09 assumiu a licença grátis (até
   3 pessoas). Se a HiperSend tem 4 ou mais pessoas, contando terceirizados,
   o reel e qualquer vídeo de marketing do Nexus em Remotion precisam de
   Company License. E, se o operador quiser um dia o botão de render para
   Remotion, alguém da empresa escreve para hi@remotion.dev; o Nexus não
   manda e-mail por conta própria.

## Fontes principais

Todas as fontes estão em linha, com a data de acesso. As que sustentam as
decisões, todas lidas em 19/10/2026:

- Remotion: [LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md),
  [remotion.pro/license](https://www.remotion.pro/license),
  [docs/license/faq](https://www.remotion.dev/docs/license/faq),
  [docs/terms](https://www.remotion.dev/docs/terms.md),
  [remotion.pro/terms-4-0](https://www.remotion.pro/terms-4-0),
  [docs/ai/skills](https://www.remotion.dev/docs/ai/skills.md).
- HyperFrames: [repositório](https://github.com/heygen-com/hyperframes),
  [README](https://raw.githubusercontent.com/heygen-com/hyperframes/main/README.md),
  [docs/packages/cli.mdx](https://raw.githubusercontent.com/heygen-com/hyperframes/main/docs/packages/cli.mdx);
  GSAP: [gsap.com/standard-license](https://gsap.com/standard-license/).
- Modelos: [Code2Video, HeyGen, 18/09/2026](https://www.heygen.com/research/introducing-code2video-benchmark),
  [Animation2Code, 26/06/2026](https://arxiv.org/html/2606.28593v1).
- ElevenLabs: [pricing](https://elevenlabs.io/pricing),
  [pricing/api](https://elevenlabs.io/pricing/api),
  [models](https://elevenlabs.io/docs/overview/models),
  [with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
  [use-policy](https://elevenlabs.io/use-policy),
  [music-terms](https://elevenlabs.io/music-terms).
- Gemini: [voice-replication](https://ai.google.dev/gemini-api/docs/voice-replication),
  [pricing](https://ai.google.dev/gemini-api/docs/pricing).
- Lei e plataformas: [AI Act art. 50](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50),
  [FAQ do art. 50](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act),
  [ANPD, Radar nº 6](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/documentos-tecnicos-orientativos/rt_deepfakes_anpd.pdf/@@display-file/file),
  [PL 2338 na Câmara](https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=2487262),
  [YouTube](https://support.google.com/youtube/answer/14328491?hl=en),
  [Meta](https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/),
  [Microsoft AI Code of Conduct](https://learn.microsoft.com/en-us/legal/ai-code-of-conduct).

Nada disto é parecer jurídico. Nos pontos de licença em aberto (Remotion) e
de enquadramento (AI Act, LGPD), a proposta escolhe o caminho que não depende
da interpretação favorável.
