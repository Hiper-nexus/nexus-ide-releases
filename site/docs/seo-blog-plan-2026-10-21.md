# Plano local de SEO e blog

Base confirmada: `145d7cb2388b11d5903d2e8775cdc4a5d2cd33fa` (`main` remoto em 21/10/2026). A árvore `site/` não mudou desde `7833f8410` (PR 149). HTML, robots e sitemap de produção consultados por leitura. Checkout original com alterações concorrentes preservado; cópia Git própria neste workspace.

### Task 1: Blog indexável

- [x] Criar `/blog/` e três guias em `site/blog/<slug>/index.html`, com conteúdo legível sem JavaScript.
- [x] Registrar HTMLs no `site/vite.config.js`, reaproveitar `site/src/pages.js` e tokens em `site/src/blog.css`.
- [x] Título, descrição, canonical e metadados sociais individuais, Blog/BlogPosting e breadcrumbs factuais, autoria institucional e data visíveis.
- [x] Fontes públicas, passos concretos, limitações e links internos; sem métricas ou preços inventados, nem links para repositório privado.

### Task 2: Descoberta e rotas

- [x] Ligar blog na navegação/rodapé de home e benchmarks.
- [x] Acrescentar as quatro URLs reais em `site/worker/public-seo.js`, somente no sitemap do produto, mantendo as existentes.
- [x] Restringir blog ao host do produto e preservar redirects existentes.
- [x] Manter robots e noindex; sem hreflang sem traduções, llms.txt ou token de verificação.

### Task 3: Evidências e publicação coordenada

- [x] Testes antes da implementação; suíte do site com GPG isolado; build e conferência de HTML/links gerados.
- [x] Revisão independente e registro das evidências/limitações.
- [x] Entregar arquivos/diff e plano de PR/deploy ao coordenador; nenhum push, PR, CI extra ou deploy nesta etapa.

Restrições: não operar Ads/Search Console; não alterar consentimento, medição de download, instalação, catálogo, autenticação, DNS, tokens, permissões, proteções ou orçamento. CTA leva à seção oficial de downloads; clique não prova instalação nem teste. Custos de IA separados.
