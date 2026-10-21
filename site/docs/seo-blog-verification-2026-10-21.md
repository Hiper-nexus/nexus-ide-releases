# SEO e blog: implementação local verificada

## Base e escopo

- Base: `145d7cb2388b11d5903d2e8775cdc4a5d2cd33fa`, confirmada no main remoto antes e depois das mudanças em 21/10/2026. `site/` da base é idêntico ao merge da PR 149 (`7833f8410`).
- HTML de produção consultado antes/depois, SHA-256 idêntico: `45107a02746efb69043cc89d8153387935fe247e1f0f65c3a83f5631b27e5869`. Produção permanece com quatro URLs no sitemap.
- Cópia Git isolada neste workspace, branch `seo/blog-local-20261021`. Checkout original com WIP não foi editado.
- Sem push, PR, deploy, CI extra, Ads, Search Console, DNS, credenciais, permissões ou orçamento.

## Auditoria e mudanças

A home já tinha conteúdo HTML indexável, canonical, metadados sociais e dados estruturados factuais. Robots e sitemap já eram separados por hostname, com noindex para conta/admin e redirects permanentes. Esses fundamentos foram preservados.

Foram adicionados:

- `/blog/`: índice editorial e política de autoria/correção.
- `/blog/criar-saas-com-ia/`: escopo, critérios de aceite, testes, dados e operação para um SaaS inicial.
- `/blog/reduzir-consumo-tokens-programando-com-ia/`: contexto, divisão de tarefas e medição por entrega aceita.
- `/blog/ia-escritora-revisora-modelos-por-papel/`: responsabilidades, revisão da mudança real e validação da estratégia de escrever com menor custo e revisar com maior capacidade.

Cada página tem título/descrição/canonical próprios, Open Graph/Twitter, breadcrumbs, H1 único e links de navegação. Os artigos têm sumário, fontes públicas, links cruzados, autoria institucional NexusIDE e data editorial visível. JSON-LD usa Blog/BlogPosting/BreadcrumbList. `dateModified` corresponde à atualização editorial em 21/10/2026; `datePublished` foi omitido porque a publicação ainda não ocorreu. Nenhum número de preço, benchmark ou economia foi inventado. Links internos e informações do repositório privado não foram publicados nos artigos.

Os quatro HTMLs são entradas explícitas do Vite. Conteúdo, sumários e links estão presentes no build sem depender de JavaScript. Os CTAs levam à seção oficial de downloads, sem tratar clique como instalação ou teste. O sitemap do produto passa de quatro para oito URLs, mantendo todas as anteriores; o da comunidade permanece igual. O novo blog retorna 404 no host da comunidade para evitar uma segunda cópia.

Não há traduções reais: hreflang não foi adicionado. llms.txt e schema especial de IA não são requisitos do Google. SEO não garante indexação, posição ou citação por IA: [orientação oficial](https://developers.google.com/search/docs/appearance/ai-features). O schema de artigos segue [a documentação do Google](https://developers.google.com/search/docs/appearance/structured-data/article).

## Verificações

- Ciclo inicial: os cinco testes novos falharam antes da implementação (páginas, descoberta, sitemap e host ausentes), depois passaram.
- Comando final: `GNUPGHOME=/tmp/nexus-seo-gnupg npm --prefix site test`: **440 testes, 440 passaram, zero falhas/skips**. Inclui os 435 testes anteriores, consentimento, conversão de download, instalação, catálogo e redirects.
- `npm --prefix site run build`: passou. Aviso do chunk existente da comunidade acima de 500 kB; esta tarefa não altera esse código.
- `node --check` dos arquivos Worker e Vite alterados; `git diff --check`: passaram.
- Os quatro HTMLs em `dist/blog/` têm JSON-LD válido, um H1 e nenhum marcador de geração pendente. Verificação de links locais, âncoras e assets passou, sem IDs duplicados.
- Chromium headless com perfil próprio em `/tmp`, somente preview em `127.0.0.1:4187`; nenhum acesso às abas/perfil do navegador do usuário. Quatro páginas do blog + home + benchmarks em 300, 320, 760, 1150, 1151, 1280 e 1440 px: **42 combinações**, sem overflow horizontal ou sobreposição da navegação. Requisições externas bloqueadas durante essa checagem; o erro esperado da API de planos da home nesse teste não é erro do blog.
- Revisão independente por outro agente, somente leitura: nenhum achado acionável; 31 testes focados também passaram. A revisão não substitui testes de leitor de tela nem validação do Worker real depois de publicar.
- Ambiente: dependências fixadas do site instaladas na cópia isolada, sem mudança de lockfile. GPG usou diretório temporário próprio para evitar qualquer leitura/escrita no perfil real. Não foi instalada a árvore de dependências do app Electron; site é pacote JavaScript independente, sem comando próprio de typecheck.

Fontes editoriais públicas conferidas: [uso responsável de agentes](https://docs.github.com/en/copilot/responsible-use/agents), [contagem de tokens](https://platform.claude.com/docs/en/build-with-claude/token-counting), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Recomendações práticas são orientação editorial, não resultados medidos do NexusIDE.

## Plano de PR e publicação — pendente de autorização coordenada

1. Apresentar este diff e os artefatos ao coordenador; obter autorização específica antes de push/PR/publicação. A negativa anterior sobre uma PR extra de CI não foi retentada.
2. Com autorização, reconfirmar main e produção; integrar apenas os arquivos desta tarefa, resolver eventuais mudanças concorrentes e repetir suíte/build/revisão se houver mudança de código.
3. Abrir uma única PR do blog/SEO, sem CI extra, e anexá-la à tarefa. Não promover uma revisão de árvore antiga como aprovação de um candidato diferente.
4. Depois de merge e autorização de deploy, usar cópia limpa do commit aprovado, `npm ci`, `npm test`, `npm run build` e o procedimento de deploy do site documentado no AGENTS.md. Atualizações do catálogo são um passo separado e precisam ser inspecionadas; não misturar um snapshot alterado não revisado no deploy.
5. Validar em produção HTTP 200/HTML das quatro páginas, canonical/JSON-LD, sitemap com oito URLs, robots e redirects, além de integridade dos fluxos de download e consentimento. A tarefa separada de Search Console poderá reenviar o sitemap existente depois dessa prova HTTP.

Pendência externa: autorização coordenada para PR e publicação. Nenhuma ação foi negada pelo auto-review nesta etapa; erros iniciais de sandbox/rede foram resolvidos com execuções locais/read-only autorizadas. Produção não contém ainda o blog.
