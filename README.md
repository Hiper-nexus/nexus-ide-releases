# Nexus Web

Duas propriedades na Cloudflare:

- `https://nexuside.app/`: produto NexusIDE, filme original do usuário, demo ilustrativa de missão, recursos e downloads públicos.
- `https://comunidade.nexuside.app/`: dev café jogável, missões, XP e links do grupo/canal. `/comunidade` e `/sorteio` no domínio principal redirecionam à comunidade.

## Rodar

```sh
npm ci
npm run dev
npm test
npm run build
wrangler deploy --dry-run
wrangler deploy
```

Vite multipage: `index.html` e `comunidade/index.html`. O Worker escolhe o documento pelo hostname. Assets enviados: somente `dist`. Source, docs, screenshots e arquivos de revisão não são publicados.

## Conteúdo

O filme original `nexus-reel-ptbr.mp4` foi fornecido pelo usuário. O hash da cópia é idêntico ao original; poster extraído por ffmpeg. Veja `docs/media-provenance.json`.

A demo de missão não executa agentes nem acessa o microfone. O jogo salva progresso apenas no navegador, sem ranking público ou elegibilidade de sorteio. A duração do prêmio Codex segue pendente; data anunciada no grupo.

## Downloads e companheiros

`GET /api/releases` entrega JSON `{ source, checkedAt, catalog: { macos, windows } }`. Cada instalador contém `version`, `architecture`, `name`, `size`, `url`, `releaseUrl` e `publishedAt`. A consulta usa somente a API pública GitHub, sem token; cache de 10 minutos e snapshot seguro em `src/downloads/snapshot.js` se GitHub falhar. `HEAD` tem os mesmos headers sem corpo; métodos de escrita são recusados. O hostname da comunidade não expõe esse endpoint.

O catálogo aceita somente versões estáveis publicadas, com semver, URLs HTTPS do repositório oficial e nomes exatos de instalador. Drafts, prereleases, ZIP de atualização, RELEASES e nupkg são excluídos. As últimas três versões Windows ficam visíveis com instalador e notas. Atualize o snapshot antes de publicar com `npm run releases:update`.

O botão principal usa User Agent Client Hints quando disponíveis e sinais do navegador como fallback. `MacIntel` e “Intel Mac OS X” não provam arquitetura Intel; iPad em modo desktop é excluído. Mac com arquitetura desconhecida mantém escolha manual e texto Apple Silicon; Intel conhecido, Windows ARM/32 bits, Linux e mobile não recebem uma recomendação de instalador incompatível. Nenhum download começa automaticamente.

Catálogo público consultado em 30/09/2026: NexusIDE Windows x64 v0.76.148, macOS Apple Silicon v0.76.146. Nexus Shot tem download próprio Apple Silicon v0.1.13 no repositório público `Hiper-nexus/nexus-shot-releases`; nenhum instalador Windows foi encontrado nas 11 releases públicas. A seção apresenta captura, gravação e envio de arquivos, comprovados no código da ponte e nas notas publicadas. Redline é incluído pelo Forge no NexusIDE para macOS e Windows, com instalação pela seção de cotas nas configurações; não há link independente inventado. As ilustrações SVG são autoria do site e estão identificadas como fluxo ilustrativo.

## Voz, Shot e Redline

A seção de voz reproduz um exemplo escrito do ditado do NexusIDE: fases Ouvindo, Transcrevendo, Refinando e No terminal, fala transcrita e prompt entregue. Não usa `getUserMedia` e não grava nada. As afirmações vêm do código do produto: o modo CODE reescreve a fala em inglês para o agente, remove hesitações e autocorreções e preserva caminhos e comandos (`src/main/voice/code-prompt-polish.ts`); se o refino falha, o texto transcrito segue como veio; o modo CHAT mantém o português; o Jarvis abre squads, cria missões, roda comandos e envia texto a panes, com palavra de ativação e sessão contínua opcionais (`docs/voice.md`). Os três exemplos da página são ilustrativos e não são saídas gravadas de um modelo.

Shot: captura e editor funcionam sem conta; gravação, GIF e frames exigem Pro (`nexus-shot/src/windows/Gate.tsx`). Redline: painel somente leitura com uso por conta nas janelas de 5 horas e da semana, tempo até o reset, conta com mais folga e estados de espera e sessão expirada (`native/menubar-redline/quota-panel.swift`, `native/windows-tray-redline/README.md`). Os números do painel ilustrado são exemplos.

## Conta e administração

`/conta/` usa `https://api.nexuside.app`: disponibilidade em `GET /v1/public/status`, sessão em `GET /v1/web/session`, login em `/v1/web/auth/google` e `/v1/web/auth/github`. Cobrança fica desabilitada sem `ready` e `billing.available`; o preço e as condições do teste vêm do servidor. Não há cadastro ou acesso permanente Free nesta página. ChatGPT não é oferecido como login funcional.

As chamadas de API usam cookies (`credentials: include`) e mutações usam `X-CSRF-Token` da sessão. Checkout envia `{plan:'pro',attemptId}`; portal e logout enviam `{}`. Redirecionamentos aceitam somente HTTPS nos hosts exatos `checkout.stripe.com` e `billing.stripe.com`. Parâmetros da página não elevam o acesso: somente o entitlement retornado pelo servidor define trial, pro, suspended ou inactive.

`/admin/` mostra dados apenas após uma sessão com papel `admin`, com autorização obrigatória também no backend. Consulta `/v1/admin/overview` e `/v1/admin/accounts?status=…&limit=50`; ações POST por ID suspendem acesso com motivo, restauram acesso ou estendem o teste de 1 a 30 dias. A suspensão informa explicitamente que não cancela a assinatura ou cobranças Stripe. Respostas 401/403 limpam os dados exibidos. Nenhum e-mail administrativo ou regra de elevação é codificado no frontend. As respostas seguem `{ok:true,data:{…}}`, inclusive confirmação de mutações; falhas ficam em texto inline, sem alert/confirm.

## Assets e provas

Three.js MIT; modelos 3D próprios em código. Geist e VT323 sob OFL. Logos e mascotes são assets do NexusIDE. Nenhum asset ou código da Overclock, BridgeMind ou Bruno Simon foi copiado.

Pesquisa e direção: `docs/site-redesign-brief.md`. Produto/design: `PRODUCT.md`, `DESIGN.md`. Migração do backend e validação de licença continuam separadas: `docs/cloudflare-migration.md`.

## Limites operacionais

API/banco/relay ainda não foram migrados. A rota `app.nexuside.app/*` permanece com o worker companion original. O passthrough do backend só existe em `nexuside.app`; nunca no hostname da comunidade ou preview.
