# Reel vertical de apresentação do Nexus — design (25/09)

## Objetivo

Um vídeo curto para Reels, Shorts e TikTok que apresenta o Nexus no estilo do
showreel de motion design do Coolify que o operador anexou
(`.nexus/attachments/mission-context/muh2pvox-cad6a7ffd697afe0-tIF9mWDot1-MS62v.mp4`),
com a identidade do Nexus, textos em PT-BR e os dois públicos do `PRODUCT.md`
em camadas: quem não programa vê a ideia virar entrega; quem opera CLIs vê o
cockpit por baixo.

## O que a referência mostrou

Análise quadro a quadro (ffprobe + painéis a 2 e 4 fps):

- 15 s, 1920×1080, 60 fps, trilha de 128 BPM. 15 s são 32 batidas, ou seja,
  8 compassos: um compasso por capítulo, com os cortes nos ataques.
- Um HUD fixo emoldura tudo: cantoneiras, "SHOWREEL '26 / MOTION DESIGN —
  COOLIFY", timecode, "1920×1080 · 60 FPS · 128 BPM", capítulo embaixo à
  esquerda e domínio com barra de progresso embaixo à direita.
- Oito capítulos: tipografia cinética (YOUR SERVERS / DATA / RULES), terminal
  3D digitando o instalador, logo pixel ganhando volume, pipeline
  (git push → Build → Deploy → Live, com palavras gigantes), esfera 3D de
  ícones com contador (163 → 370+), globo de pontos (Any server. Any cloud.),
  montagem tipográfica (FREE SSL, letreiro split-flap, OPEN SOURCE) e tela
  final.
- Aproveitamos estrutura, ritmo e linguagem de motion. Marca, logo, copy e
  trilha são do Coolify e não entram.

## Decisões do operador (25/09)

- **Destino:** Reels / Shorts / TikTok → vertical 9:16.
- **Idioma:** PT-BR.
- **Público:** os dois, em camadas.
- **Tela final:** só a marca. Sem chamada, sem URL.
- **Áudio:** trilha original gerada + versão muda.
- **Abordagem:** Remotion (React/CSS renderizado quadro a quadro). O operador
  leu a condição da licença (grátis para pessoa física e empresa de até 3
  funcionários).
- **Tagline:** "Da ideia à entrega, com uma frota de agentes."
- **Onde mora:** `/Users/cleofasrocha/dev/nexus-reel`, com git próprio, fora do
  nexus-ide. Nesta sessão `~` aponta para uma home efêmera; use sempre o
  caminho absoluto.

## Escopo

**Dentro:** um vídeo PT-BR 9:16 em duas variantes (com áudio e mudo), uma capa
PNG e o projeto pronto para re-renderizar depois de trocar um texto.

**Fora:** versão em inglês, versão 16:9, chamada ou URL, narração, legendas
queimadas, variante 30 fps e a publicação nas redes.

## Formato

- 1080×1920, 60 fps, H.264 High, `yuv420p`, AAC 48 kHz estéreo, `+faststart`.
- 11 compassos a 128 BPM = 44 batidas = 20,625 s. O quadro da batida `k` é
  `round(offset + k × fps × 60 / bpm)`; a 128 BPM e offset 0, uma batida vale
  28,125 quadros e o total fica em 1238 quadros. BPM e offset vêm da trilha
  medida (ver Áudio), então a duração é derivada em `timing.ts`, nunca uma
  constante solta.
- **Área segura** para todo texto essencial: x ∈ [64, 900] e y ∈ [250, 1480].
  Fica fora do topo das plataformas, da faixa de legenda e som embaixo e da
  coluna de botões à direita. O HUD é decorativo e pode ficar coberto.

## Roteiro

Fonte da verdade no código: `src/timing.ts` (batidas) e `src/copy.ts` (textos).
Tempos em segundos a 128 BPM, antes do ajuste fino pela trilha medida.

| # | Batidas | Tempo | HUD | O que acontece |
|---|---|---|---|---|
| 00 | 0–1 | 0,00–0,47 | 01 · IDEIA | Um pixel rosa acende no centro, a mira do HUD se desenha. VT323: "SISTEMA ONLINE". |
| 01 | 1–7 | 0,47–3,28 | 01 · IDEIA | Palavras gigantes, uma a cada 2 batidas: **DESCREVA.** (UM APP · UM SITE · UMA CORREÇÃO) → **DELEGUE.** (UMA EQUIPE DE AGENTES DE IA) → **RECEBA.** (ENTREGA COM EVIDÊNCIA). Saída de RECEBA. em glitch. |
| 02 | 7–12 | 3,28–5,63 | 02 · PEDIDO | A tela Início entra em perspectiva 3D: "O que você quer criar?", o campo digita *"Um app de agenda pra minha barbearia, com lembrete no WhatsApp."*, chips Corrigir algo · Criar uma tela · Publicar, "Equipe da criação · 3 agentes · Claude · Codex". Cursor clica em **Iniciar criação** (b10,5); a tela colapsa num ponto de luz (b11–12). |
| 03 | 12–16 | 5,63–7,50 | 03 · MARCA | O NexusMark se monta pixel a pixel na grade 13×13 (anel, satélites, núcleo aceso em b13,5), ganha volume por camadas extrudadas, entra "Nexus" e a tagline. |
| 04 | 16–22 | 7,50–10,31 | 04 · MISSÃO | Pipeline vertical Pedido → Plano → Código → Revisão → Entrega; cada nó acende numa batida (rosa rodando, verde pronto), com o cartão da missão "Agenda da barbearia" e um log curto de agentes. Palavra gigante troca: Planejado. (b17) Construído. (b18,5) Revisado. (b20) **Entregue.** (b21, verde). |
| 05 | 22–28 | 10,31–13,13 | 05 · CAMADAS | A virada. A tela se separa em 3 camadas empilhadas em 3D (Início / Quadro / Terminais, cada uma com rótulo), a câmera mergulha até a última (b24–25) e revela o grid de terminais: Claude · Orquestrador, Codex · Executor, Kimi · Revisor, Grok · Scout, todos transmitindo ao mesmo tempo, borda rosa nos ocupados. Legenda: **"Por baixo, terminais de verdade."** (PTYs REAIS · UM AGENTE POR PANE). |
| 06 | 28–32 | 13,13–15,00 | 06 · FROTA | Os logos saem dos panes e formam uma esfera 3D girando (logos + nomes de CLI em mono). Contador sobe de 1 a **17**: "CLIs de IA num só lugar" (DETECTA AS QUE VOCÊ JÁ TEM INSTALADAS). |
| 07 | 32–36 | 15,00–16,88 | 07 · FAILOVER | A esfera colapsa num anel de 4 contas em volta do NexusMark. A barra de cota de uma enche, marca LIMITE (âmbar, b34), um arco passa para a próxima (rosa, b34,5) e a conversa retoma (verde, b35). Texto: **Qualquer CLI.** (b32,5) **Qualquer conta.** (b33,5, "conta" em rosa), sub FAILOVER AUTOMÁTICO · RETOMA COM --resume. |
| 08 | 36–40 | 16,88–18,75 | 08 · RECURSOS | Montagem: **FALE.** em tela rosa com ícone pixel de microfone (VOZ: DITE, PERGUNTE, COMANDE) → letreiro split-flap que troca CLAUDE → CODEX → KIMI → GROK → **CONTROLE.** sólido + **TOTAL.** em contorno (ASSUMA QUALQUER PANE, A QUALQUER MOMENTO). |
| 09 | 40–44 | 18,75–20,63 | 09 · FIM | Flash branco, NexusMark sobre a grade de construção 13×13 (medida "13 × 13" em mono), "Nexus", a tagline e, em VT323, "MULTIAGENTE · MULTI-CLI · MULTI-CONTA". Sem chamada. |

Camadas: 00–04 é a camada de quem não programa (pedido → entrega); 05 é a
virada; 06–08 é a camada técnica.

**Veracidade.** "17 CLIs" é a contagem de `src/adapters/builtin/*.json` na
0.76.96 (conferida em 25/09); o app usa "17 provedores" no Redline. Voz,
multi-conta com failover e retomada via `--resume` e o Keychain estão no
`README.md`. A barbearia, os logs e os cartões são ilustrativos. O vídeo não
diz "open source" nem "grátis": o repositório no GitHub responde 404
(privado) e o app tem licença e cobrança (`src/main/license-sync.ts`,
`docs/billing-stripe.md`). "Entrega com evidência" segue o princípio 8 do
`PRODUCT.md`: nunca anunciar entrega validada sem verificação.

## Sistema visual

Tokens copiados do `DESIGN.md` (tema `nexus-pink-city`) para `src/theme.ts`:
`--bg #080709`, `--bg-elevated #111013`, `--bg-bar #0d0b0f`, `--text #faf7f9`,
`--text-dim #aaa2a8`, `--text-faint #928b90`, `--border rgb(255 255 255 / .08)`,
`--accent #ff4f8b`, `--live #3ce08d`, `--warn #e5c07b`. Nenhum hex fora de
`theme.ts`.

- **Cor é sinal.** Rosa só no que está vivo: o pixel do boot, o nó rodando,
  os panes ocupados, a conta que assume, o núcleo do logo. Verde = pronto,
  âmbar = limite, branco = tipografia principal. O fundo é preto neutro, sem o
  roxo da referência.
- **Brilho é pontuação.** Bloom só no elemento vivo. Glitch com separação de
  cores em no máximo 3 transições (saída de RECEBA., 07 → 08 e um toque na
  montagem). Nada de glow em tudo: é a anti-referência "brinquedo gamer RGB"
  do `PRODUCT.md`.
- **Atmosfera:** vinheta radial, grão animado por quadro em opacidade baixa,
  grade de pontos com parallax e poeira de luz derivando.
- **Tipografia:** Inter variável (headlines 800–900, tracking -0,04 em; UI
  recriada em 400–650 como no app). O tamanho das palavras gigantes é
  calculado com `fitText` (`@remotion/layout-utils`) para caber na largura
  segura, com teto de 190 px: "CONSTRUÍDO." sai menor que "FALE.". JetBrains
  Mono no HUD, logs, terminais, dados e medidas (maiúsculas espaçadas, 18–24
  px). VT323 só em 2 lugares, um por tela: "SISTEMA ONLINE" e a linha final.
- **UI recriada em código**, não em screenshot, a partir da interface real:
  `docs/qa/evidence/2026-09-07-autopilot-ui/after-home.png` (Início) e o
  cabeçalho de pane (`pane 2 · Claude · Orquestrador`, chips de custo e
  papel). Nítida em qualquer zoom da câmera.
- **HUD vertical:** cantoneiras a 40 px das bordas; texto mono de 18–20 px a
  ~55% de opacidade. Topo à esquerda "NEXUS // CENTRO DE COMANDO" e
  "SHOWREEL '26"; topo à direita timecode `HH:MM:SS:FF` vivo e
  "1080×1920 · 60 FPS · 128 BPM"; embaixo à esquerda o capítulo
  ("05 / 09 · CAMADAS"); embaixo à direita "NEXUS" com barra de progresso.
- **Motion:** palavras entram subindo com blur → nítido e mola sem overshoot;
  saem com rastro de movimento ou glitch. Todo corte cai na batida; entre as
  batidas há micro-movimento (contadores, cursor, linhas de log). Só estado
  rodando pulsa. Transições: colapso em ponto de luz (02 → 03), mergulho de
  câmera (05), morph esfera → anel (06 → 07), flash branco (08 → 09).

## Áudio

**Trilha.** ElevenLabs `music_v2` via `compose_music`, `force_instrumental`,
21 000 ms, eletrônica escura instrumental a 128 BPM (baixo analógico
pulsante, bateria seca, arpejos). Plano de composição com os blocos presos ao
roteiro:

| Bloco | ms | Papel |
|---|---|---|
| A | 0–5 625 | intro pulsante, hi-hats que combinam com a digitação, riser no último compasso |
| B | 5 625–10 313 | ataque na marca e groove com bateria e baixo |
| C | 10 313–13 125 | breakdown com filtro abrindo e sub-drop: o mergulho das camadas |
| D | 13 125–18 750 | energia total; stabs nas batidas da montagem |
| E | 18 750–21 000 | impacto final e cauda de reverb, fade até 20 625 |

**Medição da batida.** Um script do projeto decodifica a faixa com ffmpeg
para PCM, calcula o envelope de onsets e estima BPM e offset por
autocorrelação. Esses valores entram em `timing.ts`. Tolerância: cada corte de
capítulo a no máximo ±2 quadros (±33 ms) do ataque mais próximo. Se a faixa
não tiver tempo estável dentro disso, gera-se outra com seed diferente.

**Efeitos sonoros.** ElevenLabs `text_to_sound_effects`, `mp3_44100_128` (o
plano Starter não libera 192 kbps nem PCM). Conjunto pequeno reaproveitado:
power-on do boot; impacto curto das palavras (×3); teclado mecânico rápido;
clique de UI; whoosh reverso do colapso; blips 8-bit da montagem do logo;
tick de UI (×5 nos nós); whoosh grave do mergulho; glitch curto (×2–3);
alerta e confirmação do failover; flaps do letreiro; impacto final com reverb.

**Mixagem e masterização.** O Remotion posiciona trilha e efeitos por quadro
(`<Audio>` dentro de `<Sequence>`). Depois, `loudnorm` em duas passadas no
ffmpeg até -14 LUFS integrados e pico verdadeiro ≤ -1 dBTP, remuxando sem
re-encodar o vídeo. A versão muda é o mesmo vídeo com `-an`.

**Custo e licença.** Plano ElevenLabs Starter ativo, com ~87,8 mil créditos
livres em 25/09. Planos pagos incluem licença comercial, inclusive de música
(central de ajuda e página de preços da ElevenLabs, consultadas em 25/09). O
custo é confirmado antes de cada geração.

## Arquitetura do projeto

```text
/Users/cleofasrocha/dev/nexus-reel/
├── package.json           # remotion + @remotion/cli + @remotion/layout-utils 4.0.529, react, react-dom, typescript, vitest (versões exatas)
├── remotion.config.ts
├── public/
│   ├── fonts/             # Inter.var.ttf, JetBrainsMono.var.ttf, VT323-Regular.ttf + OFL-1.1.txt
│   ├── logos/             # subconjunto de provider-logos + NOTICE.md
│   └── audio/             # trilha e efeitos gerados
├── scripts/
│   └── measure-beats.ts   # ffmpeg → PCM → onsets → BPM/offset
├── src/
│   ├── Root.tsx           # registra a composição NexusReel (1080×1920, 60 fps, duração derivada)
│   ├── Reel.tsx           # sequência dos capítulos + HUD + trilha
│   ├── timing.ts          # BPM, offset, batida → quadro, tabela de capítulos
│   ├── copy.ts            # todos os textos PT-BR
│   ├── theme.ts           # tokens do DESIGN.md
│   ├── layout.ts          # área segura + caixas de texto essenciais por capítulo
│   ├── hud/               # Hud, Timecode, cantoneiras
│   ├── fx/                # Grain, Vignette, DotGrid, Dust, Glitch, Flash, CollapseToPoint
│   ├── ui/                # InicioCard, PaneTerminal, MissionCard, NexusMark3D, SplitFlap
│   ├── lib/               # sphere.ts, typewriter.ts, timecode.ts, splitflap.ts
│   ├── audio/             # Soundtrack (trilha + efeitos por quadro)
│   └── chapters/          # C00Boot … C09Fim, um componente por capítulo
└── out/                   # entregáveis (fora do git)
```

- Cada capítulo recebe o quadro local e lê batidas de `timing.ts`; nenhum
  número mágico de quadro dentro de componente.
- A esfera é matemática pura em `lib/sphere.ts` (pontos de Fibonacci, rotação,
  projeção em perspectiva, ordenação de trás para frente) desenhada com DOM e
  SVG. Sem WebGL: render determinístico e sem depender de GPU no Chrome
  headless.
- O Remotion baixa o Chrome Headless Shell no primeiro render. Se o download
  falhar, `--browser-executable` aponta para o Chrome instalado em
  `/Applications/Google Chrome.app`.
- Render mestre: `remotion render NexusReel` em H.264, CRF 16, `yuv420p`, AAC
  320 kbps. A qualidade alta dá folga para a recompressão das plataformas.

## Assets e procedência

- **Fontes:** `src/renderer/styles/fonts/` do nexus-ide, com
  `third_party/licenses/OFL-1.1.txt` e
  `third_party/provenance/fonts-inter-jetbrains.json`.
- **NexusMark:** geometria (anel, núcleo, satélites na grade 13×13) portada de
  `src/renderer/components/NexusMark.tsx`.
- **Logos das CLIs:** subconjunto de `src/renderer/assets/provider-logos/` que
  cobre os 17 adaptadores (claude, codex, kimi, grok, qwen-color,
  deepseek-color, opencode, aider, devin, glm, longcat, agy, mimo-code, muse,
  openclaude), copiado com o `NOTICE.md`. É o mesmo uso nominativo do app:
  identificar a CLI compatível, sem sugerir afiliação.
- **Áudio:** gerado para este vídeo (ver Áudio). Nada da trilha da referência.

## Testes (TDD — teste antes do código)

Vitest nas partes puras:

- `timing`: batida → quadro com BPM e offset; capítulos contíguos, sem buraco
  nem sobreposição, somando 44 batidas; total de quadros derivado; mudar
  BPM/offset desloca tudo de forma coerente.
- `sphere`: `n` pontos unitários (|v| ≈ 1); rotação preserva a norma; escala
  da projeção cai com a profundidade; ordenação de trás para frente.
- `typewriter`: texto cresce de forma monotônica, está completo no quadro
  final e nunca corta caractere acentuado (fatia por code point).
- `timecode`: quadro → `HH:MM:SS:FF` a 60 fps.
- `splitflap`: sequência de letras entre duas palavras determinística por
  quadro.
- `layout`: toda caixa de texto essencial de todo capítulo cabe na área
  segura.

A parte visual é verificada por imagem (abaixo), não por asserção de markup.

## Verificação antes de entregar

1. Quadros-chave de cada capítulo (`remotion still`) montados em painéis e
   comparados com este roteiro e com a referência.
2. Os mesmos quadros com as áreas de interface do Reels e do TikTok
   sobrepostas: nenhum texto essencial embaixo delas.
3. `ffprobe` do mestre: 1080×1920, 60 fps, H.264, `yuv420p`, AAC 48 kHz,
   duração igual à derivada de `timing.ts`.
4. `ebur128`: -14 LUFS ±1 integrados e pico verdadeiro ≤ -1 dBTP.
5. Cortes de capítulo a ≤ ±2 quadros dos ataques medidos na trilha.
6. Painel final a 2 fps, igual ao feito para a referência, entregue ao
   operador.

## Entregáveis

Em `/Users/cleofasrocha/dev/nexus-reel/out/`:

- `nexus-reel-ptbr.mp4` — com áudio.
- `nexus-reel-ptbr-mudo.mp4` — sem faixa de áudio.
- `nexus-reel-capa.png` — capa do Reels, tirada da tela final.

E o projeto: trocar um texto em `src/copy.ts` e rodar um comando re-renderiza
tudo.

## Riscos

- **Licença do Remotion:** grátis até 3 funcionários; acima disso, licença
  de empresa. O operador está ciente.
- **Tempo instável na música gerada:** medido e tolerado a ±2 quadros; fora
  disso, nova geração.
- **Recompressão das plataformas:** o Instagram pode converter para 30 fps e
  re-encodar. O mestre em CRF 16 dá folga, e o movimento continua legível a
  30 fps.
- **Marcas de terceiros:** os logos das CLIs são marcas dos donos; uso
  nominativo, como no app.
- **Download do Chrome Headless Shell:** depende de rede; o fallback é o
  Chrome instalado.

## Fora deste design (próximos)

- Versão em inglês (troca de `copy.ts` + re-render).
- Versão 16:9 para X e LinkedIn (novo layout por capítulo).
- Chamada ou URL na tela final, quando houver endereço público.
