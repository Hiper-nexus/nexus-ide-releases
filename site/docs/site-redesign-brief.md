# Novo site Nexus e comunidade

## Pedido que define o trabalho
A página do grupo não deve ocupar o domínio principal. A experiência deve realmente ser gamificada, no nível de intenção do mundo explorável de Bruno Simon. Analisar o produto e os sites Overclock e BridgeMind antes de construir o principal.

## Observações dos concorrentes — 30/09/2026

### Overclock
Fonte: https://overclock.sh/ ; texto e primeira tela vistos no navegador.

O site explica o mecanismo: briefing, equipe e entrega. A demonstração, o catálogo de squads, as integrações e os links para recursos tornam o produto concreto. Casos e depoimentos conectados às fontes ajudam a sustentar confiança. A longa home também dispersa a atenção entre venda, recursos, curso e comunidade. A promessa de velocidade é uma alegação do concorrente, não uma medição que o Nexus deva repetir.

Aplicação: mostrar o processo e casos de uso, com uma CTA clara. Não copiar organização visual, textos, preços ou promessas de resultado. Não fabricar depoimentos para preencher a mesma seção.

### BridgeMind
Fonte: https://www.bridgemind.ai/ ; texto e primeira tela vistos no navegador.

A demo interativa ocupa a transição do hero para o produto e permite explorar modos, panes e prompts. O texto separa a assinatura do app do uso das contas de IA. A mensagem agrupa rotinas, código e conversas. Conteúdo de comunidade, downloads e FAQ reforça a ligação entre produto e uso diário. O efeito visual central dá presença à página, mas a experiência de produto é o argumento.

Aplicação: uma demo manipulável do fluxo Nexus, explicitamente ilustrativa, com troca de missão e foco de agente. A marca e composição permanecem Nexus.

### Bruno Simon
Fonte: https://bruno-simon.com/ ; conteúdo oficial e controles examinados.

O visitante dirige por um mundo, descobre destinos e acompanha conquistas. A experiência é a navegação, não uma decoração ao lado da copy. Nosso café anterior não cumpria essa intenção: era pequeno, sem missão, sem exploração guiada e sem progressão significativa.

Aplicação: comunidade como mundo de primeira tela, rover, checkpoints, estação de prêmios e lives, progresso e conclusão. Os objetivos do jogo não alteram chances no sorteio.

## Produto que o site precisa apresentar

| Tema | Fonte no Nexus | Tratamento público |
|---|---|---|
| Intenção → software com controle | PRODUCT.md | Hero e demonstração por etapas |
| Terminais reais e providers | README.md, adapters | Preview de panes e logos de provedores |
| Squads, missões, revisão | MissionBoard, catálogo, motor | Explorar uma missão de exemplo |
| Worktrees por feature | WorkspaceTabs e AGENTS.md | Trabalho paralelo com pastas separadas |
| Cotas e custo | UsageQuotaSection | Informações de uso sem números inventados |
| Voz e memória | Componentes e feature flags | Explicação delimitada, sem afirmar suporte universal |
| Download | Releases GitHub | macOS arm64 e Windows x64 observados |
| Planos | shared/pricing.ts | Free local; Pro comercial ainda em validação |

## Estrutura e copy principal
Hero: “Sua ideia. Um time de IAs. Você no comando.” Sub: “Transforme um pedido em trabalho organizado. Terminais reais, agentes em paralelo e uma missão que você acompanha do início à entrega.” CTA: baixar Nexus. Prova: links para versões públicas e recursos identificáveis no produto.

Ordem: hero de produto e reel do usuário → demo interativa de missão → provedores → aprofundamento em panes/worktrees/revisão/voz → caminho iniciante/operador → downloads → FAQ → comunidade em link separado.

Benefícios: ver quem está fazendo o quê; usar suas CLIs/contas; organizar o trabalho em missões; revisar a entrega dentro do fluxo. Etapas: escolher workspace, dar objetivo, acompanhar/revisar.

FAQ: é um modelo de IA? Não, é o ambiente que opera os agentes. Inclui uso dos modelos? Não, providers têm suas contas e limites. Precisa programar? Atende iniciantes e operadores. O que a demo executa? Nada real, é uma ilustração interativa. Onde baixar? Releases oficiais observadas. Onde fica o grupo? No subdomínio da comunidade.

SEO: home indexável com title NexusIDE — seu time de agentes, um único cockpit. Campanha no subdomínio separada, sem data fictícia. Layout: apresentação de produto com hero imersivo e demo manipulável. A narrativa explica o mecanismo em vez de listar cards genéricos.

## Mundo e composição
Sistema estabelecido: Nexus near-black, branco neutro para CTA, rosa para estado ativo, Geist e VT323 funcional nos sinais do jogo. No principal: Persuade. Na comunidade: Experience. Esta é uma alteração completa da composição mantendo a identidade Nexus.

Sete estruturas consideradas: centro de comando orbital; mapa de missão; atlas de agentes; bancada de oficina; lançamento guiado; território explorável; demo de cockpit em primeiro plano. A referência Bruno e a correção explícita do usuário fixam o território explorável para a comunidade. No principal, o mecanismo de missão orienta o centro de comando e o cockpit interativo.

## Mídia escolhida pelo usuário
O usuário forneceu `nexus-reel-ptbr.mp4` em 30/09, 20,63 s, 1080x1920, H.264/AAC, 13.018.993 bytes. Ele substitui a hipótese de núcleo 3D no hero principal. O filme é servido inteiro, com poster e controle de áudio. Não é chamado de gravação literal do app; é o filme de apresentação fornecido pelo dono do produto. Vídeos adicionais foram autorizados caso necessários; nenhum adicional foi necessário para esta versão.

## Validação e publicação
19 testes focados passaram. Build e deploy Cloudflare concluídos. `nexuside.app` retorna o produto (200); `comunidade.nexuside.app` retorna o jogo (200); a antiga rota `/comunidade` no principal redireciona (307). O reel público é o original (SHA idêntico), com reprodução confirmada no navegador (readyState 4, 20,63s, mute inicial), e coleta de café +25 XP foi confirmada no hostname público da comunidade. O serviço de assets respondeu 200 com o MP4 completo ao teste de Range; a reprodução nativa foi verificada, mas não se declara entrega parcial 206.

Revisão independente: oito capturas inspecionadas; três correções materiais (Enter em botões filhos, label decorativo e ícones de plataforma) foram aplicadas e consideradas resolvidas pelo revisor. O veredito final cobre essas três correções, não uma certificação geral. Sem medição formal de Core Web Vitals. Capturas públicas em `artifacts/published-product.jpg` e `artifacts/published-community.jpg`.
