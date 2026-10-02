# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Comunidade de vibe coding e operadores de agentes de IA. O produto NexusIDE atende iniciantes com uma ideia e desenvolvedores que precisam controlar CLIs, missões, revisão e trabalho em paralelo. Assunção para esta versão do site: atender os dois com uma demonstração prática; a pergunta de foco foi enviada ao usuário e permanece aberta.

## Product Purpose
O principal apresenta o NexusIDE, ajuda a entender seu fluxo e oferece os instaladores públicos. A comunidade é uma propriedade separada com jogo explorável, convite ao WhatsApp e canal de lives.

## Operating Context
NexusIDE é um app desktop baseado em Electron. A fonte do produto é `/Users/cleofasrocha/dev/nexus-ide/PRODUCT.md` e a implementação atual. Site: Vite, HTML/CSS/JS, Three.js e Cloudflare Workers Static Assets.

## Capabilities and Constraints
Terminais PTY, adapters multi-CLI, squads/missões/handoffs, worktrees, custos/cotas e voz têm implementação no produto. Nenhum depoimento, ganho de velocidade ou receita foi autorizado como prova. A API pública e a licença em produção ainda precisam ser validadas; o site não oferece checkout fictício. A seção de planos lê preço, dias e limites de `GET /v1/public/status` sem fixar números no HTML, não existe plano gratuito permanente e a contratação só é oferecida quando o servidor confirma disponibilidade. Os instaladores públicos observados são macOS Apple Silicon e Windows x64; Linux não foi observado como download publicado.

## Benchmarks e comparação (páginas públicas)
`/benchmarks/` é gerada de `nexus-ide/src/main/orch/published-benchmarks.ts` (`npm run benchmarks:update`): só números oficiais dos fabricantes, cada um com a fonte e a data da coleta; célula vazia = não publicado, nunca estimada; modelo que só herda nota ou é variante do mesmo modelo vira nota, não linha. O "Radar da comunidade" na página é uma intenção declarada como não existente: o Nexus não coleta nada para isso, e qualquer coleta futura é opt-in, sem conteúdo de prompt/código, sem identificador e só publicada com amostra mínima. `/comparacao/` só afirma o que o PRÓPRIO site de cada concorrente publica, com o link e a data da conferência ("não informado" nunca vira "não tem"); um teste barra adjetivo de superioridade e fonte fora do domínio do concorrente. Revisar a comparação a cada trimestre ou quando um concorrente mudar preço/planos.

## Brand Commitments
Nexus, PT-BR, Pink City e estética dev. Referência do usuário: Bruno Simon, experiência realmente explorável e gamificada. Não aceitar um pequeno canvas como substituto dessa experiência. Concorrentes para pesquisa: Overclock e BridgeMind. Comunidade em `comunidade.nexuside.app`; produto em `nexuside.app`.

## Evidence on Hand
PRODUCT.md, README.md, DESIGN.md e módulos de produto atuais do NexusIDE. Logos de providers e mascotes são assets do produto. Releases públicas no GitHub. Demonstrações no website devem ser identificadas como ilustração e não executar agentes ou acessar o microfone. Voz: o ditado em modo CODE vira prompt em inglês sem hesitações, o modo CHAT mantém o português e o Jarvis executa ações no app. Shot: captura e anotação sem conta; gravação no Pro. Redline: leitura de cotas por conta, sem acesso a credenciais. Decisão de 01/10/2026: o Nexus Pro inclui o Shot e o Redline sem custo adicional, e os dois passarão a exigir a licença do Nexus; enquanto esse vínculo não estiver nos instaladores publicados, o site anuncia a inclusão no Pro e não promete o bloqueio.

## Product Principles
- Separar produto, comunidade e campanha.
- Deixar o visitante experimentar a ideia antes do download.
- Explicar autonomia com etapas e evidências, sem promessa de infalibilidade.
- Usar as próprias assinaturas/chaves dos providers conforme suporte do app.

## Accessibility & Inclusion
Keyboard, touch, contrast AA, redução de movimento, alternativa textual e navegação fora do canvas.
