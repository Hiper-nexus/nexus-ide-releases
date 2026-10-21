# Nexus Web

Duas propriedades na Cloudflare:

- `https://nexuside.app/`: produto NexusIDE, filme original do usuário, demo ilustrativa de missão, recursos e downloads públicos.
- `https://comunidade.nexuside.app/`: dev café jogável, missões, XP e links do grupo/canal. `/comunidade/` no domínio principal serve a mesma página (espelho com `Link: rel=canonical` para o subdomínio, para quem não consegue abrir o subdomínio por filtro de rede ou DNS); `/comunidade` sem barra, subcaminhos e `/sorteio` redirecionam ao subdomínio.

## Rodar

```sh
npm ci
npm run dev
npm test
npm run build
wrangler deploy --dry-run
wrangler deploy
```

Vite multipage: `index.html`, `comunidade/index.html`, `conta/index.html` e `admin/index.html`. O Worker escolhe o documento pelo hostname; `/conta/` e `/admin/` existem somente em `nexuside.app`, com `noindex` no HTML e no cabeçalho, e nunca são servidos no host da comunidade. Assets enviados: somente `dist`. Source, docs, screenshots e arquivos de revisão não são publicados.

## Conteúdo

O filme original `nexus-reel-ptbr.mp4` foi fornecido pelo usuário. O hash da cópia é idêntico ao original; poster extraído por ffmpeg. Veja `docs/media-provenance.json`.

A demo de missão não executa agentes nem acessa o microfone. O jogo salva progresso apenas no navegador, sem ranking público ou elegibilidade de sorteio. A duração do prêmio Codex segue pendente; data anunciada no grupo.

## Downloads e companheiros

`GET /api/releases` entrega JSON `{ source, checkedAt, catalog: { macos, windows } }`. Cada instalador contém `version`, `architecture`, `name`, `size`, `url`, `releaseUrl` e `publishedAt`. A consulta usa somente a API pública GitHub, sem token; cache de 10 minutos e snapshot seguro em `src/downloads/snapshot.js` se GitHub falhar. `HEAD` tem os mesmos headers sem corpo; métodos de escrita são recusados. O hostname da comunidade não expõe esse endpoint.

O catálogo aceita somente versões estáveis publicadas, com semver, URLs HTTPS do repositório oficial e nomes exatos de instalador. Drafts, prereleases, ZIP de atualização, RELEASES e nupkg são excluídos. As últimas três versões Windows ficam visíveis com instalador e notas. Atualize o snapshot antes de publicar com `npm run releases:update`.

O botão principal usa User Agent Client Hints quando disponíveis e sinais do navegador como fallback. `MacIntel` e “Intel Mac OS X” não provam arquitetura Intel; iPad em modo desktop é excluído. Mac com arquitetura desconhecida mantém escolha manual e texto Apple Silicon; Intel conhecido, Windows ARM/32 bits, Linux e mobile não recebem uma recomendação de instalador incompatível. Nenhum download começa automaticamente.

Catálogo público consultado em 30/09/2026: NexusIDE Windows x64 v0.76.148, macOS Apple Silicon v0.76.146. Nexus Shot tem download próprio Apple Silicon v0.1.13 no repositório público `Hiper-nexus/nexus-shot-releases`; nenhum instalador Windows foi encontrado nas 11 releases públicas. Desde 02/10/2026 a mesma release v0.1.13 traz os pacotes Linux x64 em beta (`nexus-shot_0.1.13_amd64.deb`, `nexus-shot-0.1.13-1.x86_64.rpm` e `SHA256SUMS-linux-x64.txt`, gerados no Ubuntu 22.04); a seção do Shot liga direto a eles. Desde 19/10/2026 a release v0.1.15 traz o primeiro instalador Windows x64 do Shot, em beta e sem assinatura digital (`Nexus.Shot_0.1.13_x64-setup.exe` e `SHA256SUMS-windows-x64.txt`; o número é o da base do port para Windows, e a gravação pede o ffmpeg do sistema). A seção liga direto a ele, e "Instalação e notas do Shot" aponta para a v0.1.15, cujas notas cobrem macOS, Windows e Linux. No mesmo dia o botão do macOS passou do DMG da v0.1.13 para o da v0.1.15 (`Nexus.Shot_0.1.15_aarch64.dmg`, notarizado), a versão que o auto-update já entregava a quem tinha o Shot instalado. A seção apresenta captura, gravação e envio de arquivos, comprovados no código da ponte e nas notas publicadas. Redline é incluído pelo Forge no NexusIDE para macOS e Windows, com instalação pela seção de cotas nas configurações; não há link independente inventado. No Linux o Redline é a bandeja dentro do próprio app (ligada por padrão a partir da 0.76.175), sem instalador à parte. As ilustrações SVG são autoria do site e estão identificadas como fluxo ilustrativo.

## Planos no site

A seção `#planos` da principal fica entre o manifesto e os downloads, com dois blocos de hierarquia diferente: o período de teste como porta de entrada e o Nexus Pro como oferta principal. `src/plans/` valida `GET /v1/public/status` (tipos, moeda `brl`, intervalo `month`, inteiros positivos) e define os estados `consultando`, `disponivel`, `indisponivel` e `erro`; `src/product.js` só liga o módulo ao DOM, com timeout na chamada e sem `innerHTML` com dado do servidor. Preço, dias e limites não são fixados no HTML: sem confirmação do servidor a seção informa que os valores estão sendo consultados; se a API falhar ou `billing.available` for falso, informa que a contratação está indisponível e que nenhuma cobrança será iniciada. Não existe plano gratuito permanente. Modelos de IA continuam cobrados à parte, por cada provedor.

## Voz, Shot e Redline

A seção de voz reproduz um exemplo escrito do ditado do NexusIDE: fases Ouvindo, Transcrevendo, Refinando e No terminal, fala transcrita e prompt entregue. Não usa `getUserMedia` e não grava nada. As afirmações vêm do código do produto: o modo CODE reescreve a fala em inglês para o agente, remove hesitações e autocorreções e preserva caminhos e comandos (`src/main/voice/code-prompt-polish.ts`); se o refino falha, o texto transcrito segue como veio; o modo CHAT mantém o português; o Jarvis abre squads, cria missões, roda comandos e envia texto a panes, com palavra de ativação e sessão contínua opcionais (`docs/voice.md`). Os três exemplos da página são ilustrativos e não são saídas gravadas de um modelo.

Shot: captura e editor funcionam sem conta; gravação, GIF e frames exigem Pro (`nexus-shot/src/windows/Gate.tsx`). Redline: painel somente leitura com uso por conta nas janelas de 5 horas e da semana, tempo até o reset, conta com mais folga e estados de espera e sessão expirada (`native/menubar-redline/quota-panel.swift`, `native/windows-tray-redline/README.md`). Os números do painel ilustrado são exemplos.

## Conta e administração

`/conta/` usa `https://api.nexuside.app`: disponibilidade em `GET /v1/public/status`, sessão em `GET /v1/web/session`, login em `/v1/web/auth/google` e `/v1/web/auth/github`. Cobrança fica desabilitada sem `ready` e `billing.available`; o preço e as condições do teste vêm do servidor. Não há cadastro ou acesso permanente Free nesta página. ChatGPT não é oferecido como login funcional.

O retorno do Stripe em `/conta/?checkout=success` só informa: a página consulta a sessão de novo, com espera entre as tentativas, até o servidor confirmar o acesso Pro e então orienta abrir o NexusIDE com a mesma conta. `?checkout=cancel` avisa apenas que nenhuma cobrança foi iniciada. `?plano=pro` destaca o bloco do plano e mais nada. Nenhum parâmetro de URL eleva acesso: somente o entitlement do servidor define trial, pro, suspended ou inactive.

As chamadas de API usam cookies (`credentials: include`) e mutações usam `X-CSRF-Token` da sessão. Checkout envia `{plan:'pro',attemptId}`; portal e logout enviam `{}`. Redirecionamentos aceitam somente HTTPS nos hosts exatos `checkout.stripe.com` e `billing.stripe.com`. Parâmetros da página não elevam o acesso: somente o entitlement retornado pelo servidor define trial, pro, suspended ou inactive.

A CSP do Worker permite `connect-src 'self' https://api.nexuside.app` e mais nada, que é o que habilita as chamadas da conta, do admin e da seção de planos.

`/admin/` mostra dados apenas após uma sessão com papel `admin`, com autorização obrigatória também no backend. Consulta `/v1/admin/overview` e `/v1/admin/accounts` (situação, parte do e-mail e cursor; 50 por página, com “Carregar mais”). Cada conta traz `lastSeenAt`, a última entrada gravada no login, ou vazio. Ações POST por ID suspendem acesso com motivo, restauram acesso ou estendem o teste de 1 a 30 dias. A suspensão informa explicitamente que não cancela a assinatura ou cobranças Stripe. Respostas 401/403 limpam os dados exibidos. Nenhum e-mail administrativo ou regra de elevação é codificado no frontend. As respostas seguem `{ok:true,data:{…}}`, inclusive confirmação de mutações; falhas ficam em texto inline, sem alert/confirm.

## Assets e provas

A faixa de CLIs da principal lista os adaptadores que vêm no NexusIDE (`src/adapters/builtin/*.json` no repositório do app): 15 CLIs e dois provedores por API. A contagem de modelos vem de `resources/model-catalog.json` e traz a data do catálogo; atualize os dois ao publicar. Os logos vêm de `src/renderer/assets/provider-logos/` do app e a origem de cada um está em `public/providers/NOTICE.md`.

Three.js MIT; modelos 3D próprios em código. Geist e VT323 sob OFL. Logos e mascotes são assets do NexusIDE. Nenhum asset ou código da Overclock, BridgeMind ou Bruno Simon foi copiado.

Pesquisa e direção: `docs/site-redesign-brief.md`. Produto/design: `PRODUCT.md`, `DESIGN.md`. Migração do backend e validação de licença continuam separadas: `docs/cloudflare-migration.md`.

## Limites operacionais

API/banco/relay ainda não foram migrados. A rota `app.nexuside.app/*` permanece com o worker companion original. O passthrough do backend só existe em `nexuside.app`; nunca no hostname da comunidade ou preview.

## Google Ads e consentimento (21/10/2026)

A home de produção carrega somente a tag base `AW-953176375`, confirmada na conta `3066296016`.
`src/ads-consent.js` usa Consent Mode básico: nenhum loader ou ping Google antes de um aceite
explícito, nem após recusa. A preferência local vence em 180 dias; o rodapé permite reabrir a escolha
e revogar. Revogar recarrega a página sem a tag. `ad_user_data`, `ad_personalization` e
`analytics_storage` continuam negados; conversões aprimoradas e sinais de personalização ficam desligados.
A tag compartilhada contém o destino GA4 `G-VJFB612907`: a propriedade `ga-disable-G-VJFB612907`
é definida antes do loader para bloquear esse destino no Nexus. `user_data: null` desativa a coleta
automática de dados fornecidos pelo usuário nesta página. A URL enviada é a raiz canônica, sem query/hash; referrer configurado sem parâmetros. Se a página de origem contiver query/hash, o loader é bloqueado. A política pública descreve o tratamento.
A CSP Google só é permitida na home do domínio oficial, sem inline/eval ou curingas. Conta, admin,
comunidade e previews não inicializam a integração. Os testes de consentimento integram `npm test`.

A ação secundária `7860037868` (“Nexus IDE | Clique em download”) usa somente o destino oficial
`AW-953176375/G6imCOzR-qMdELeiwcYD`, valor 0 BRL e ONE_PER_CLICK. `download-conversion.js`
observa cliques reais em links de instaladores oficiais, sob consentimento. Âncoras de seção, o seletor
Linux genérico, checksums, notas de versão e downloads do Shot ficam fora. O handler não cancela a
navegação; o envio via beacon é best effort e falhas de medição nunca impedem o download. QA usa
mocks, sem registrar conversão real. O clique de download continua sendo uma navegação
para um instalador GitHub (os links podem ser atualizados por `src/downloads/ui.js`); ele não prova
instalação nem ativação. O teste começa no primeiro login verificado, confirmado pela API, e não no
clique em “Começar meu teste”. Para medir início de teste ou ativação no Google Ads, configure novas ações exclusivas do
Nexus e valide seus IDs/rótulos antes de instrumentar; não reutilize ações de outros produtos. Medir
ativação dentro do desktop exige um escopo próprio e consentimento compatível.
