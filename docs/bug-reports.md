# Relatos de bug

Preparado em 01/10/2026. **FASE 1: coletar, deduplicar e triar.** O app desktop envia o relato, o servidor limpa o texto, agrupa repetidos e o admin faz a triagem por um painel. **Nada aqui executa correção.** A FASE 2 (correção automática por agente) ainda não existe; este documento deixa pronto o ponto de autorização humana que ela vai exigir (veja [Autorização humana](#autorização-humana-o-status-approved)).

> **O texto de um relato é ENTRADA NÃO CONFIÁVEL.** Qualquer pessoa autenticada escreve o que quiser em `title`, `description`, `steps` e no diagnóstico, e esse texto será lido por um admin e, no futuro, por um agente. Leia [Segurança: entrada não confiável](#segurança-entrada-não-confiável-prompt-injection) antes de ligar qualquer automação a estes dados.

## Resumo

| Item | Onde |
|------|------|
| Rotas do app (Bearer) | `src/bugs/routes.ts` |
| Rotas do painel admin | `src/bugs/admin-routes.ts` |
| Limpeza do texto (segredos, caminhos, e-mails, caracteres invisíveis) | `src/bugs/scrub.ts` |
| Esquemas Zod estritos | `src/bugs/schemas.ts` |
| Impressão digital (deduplicação) | `src/bugs/fingerprint.ts` |
| Máquina de estados | `src/bugs/transitions.ts`, `src/bugs/patch-plan.ts` |
| Consultas ao D1 | `src/bugs/store.ts` (app), `src/bugs/admin-store.ts` (painel) |
| Retenção do diagnóstico | `purgeExpiredDiagnostics` em `src/bugs/store.ts`, chamada por `cleanupExpired` em `src/index.ts` |
| Tabelas | `migrations/0007_bug_reports.sql` (`bug_reports`, `bug_report_events`) |

Respostas seguem o padrão da API: `{"ok":true,"data":{…}}` ou `{"ok":false,"error":"…"}` (mensagens em português). Datas saem em ISO 8601 (UTC). Os campos de resposta são `camelCase`.

## API do app desktop

Autenticação: sessão Bearer do app (`Authorization: Bearer <token>`). O cookie do site **não** vale aqui (401). Só pede login: quem está com o teste vencido ou a conta suspensa também pode reportar, porque o bug pode ser justamente a licença ou a cobrança.

### `POST /v1/bug-reports`

Corpo JSON de **até 64 KB**, conferido **antes** de parsear (acima disso: 413). O esquema é **estrito**: campo desconhecido em qualquer nível é 400. A gravidade não existe no corpo: nasce `medium` e o admin ajusta.

```json
{
  "title": "Terminal fecha sozinho",
  "description": "Ao abrir três painéis ao mesmo tempo o terminal fecha sem mensagem.",
  "steps": "1. Abrir 3 painéis\n2. Esperar 10 s",
  "category": "terminal",
  "impact": "blocks_work",
  "app": { "version": "0.76.110", "platform": "darwin", "arch": "arm64", "osVersion": "Darwin 27.2.0" },
  "context": { "adapter": "claude", "model": "opus", "paneCount": 3, "missionActive": true },
  "consent": { "diagnostics": true },
  "diagnostics": {
    "events": [{ "t": 1790766000123, "kind": "pty.exit", "code": "ENOENT" }],
    "errors": ["spawn falhou"]
  }
}
```

| Campo | Regra |
|-------|-------|
| `title` | texto, 5 a 120 caracteres, uma linha |
| `description` | texto, 10 a 4000 caracteres |
| `steps` | opcional, até 2000 caracteres |
| `category` | `crash`, `terminal`, `agents`, `license`, `billing`, `ui`, `performance`, `other` |
| `impact` | `annoying` ou `blocks_work` |
| `app.version` | parecido com semver (`0.76.110`, `1.2`, `1.2.3-beta.1`), até 32 |
| `app.platform` | `darwin`, `win32` ou `linux` |
| `app.arch` | letras, números, `_` e `-`, até 16 |
| `app.osVersion` | opcional, até 64 |
| `context.adapter` / `context.model` | opcionais, até 40 / 80 |
| `context.paneCount` | opcional, inteiro de 0 a 64 |
| `context.missionActive` | opcional, booleano |
| `consent.diagnostics` | **obrigatório**, booleano |
| `diagnostics` | opcional; **só é aceito se `consent.diagnostics === true`**. Até 50 `events` (`t` inteiro em ms, `kind` até 40, `code` opcional até 80) e até 20 `errors` (strings de até 200) |

Sem consentimento, um `diagnostics` enviado é **descartado em silêncio** (a resposta é 201 e nada dele é gravado).

Resposta `201`: `{"ok":true,"data":{"id":"<uuid>","status":"new"}}`.

| Status | Quando |
|--------|--------|
| 400 | JSON quebrado, campo desconhecido, limite violado, texto que fica curto demais depois da limpeza (`Dados inválidos.`) |
| 401 | sem sessão do app |
| 413 | corpo acima de 64 KB |
| 429 | mais de **5 relatos por hora** por conta. Traz `Retry-After` (segundos) e a mensagem "Você já enviou 5 relatos na última hora. Aguarde um pouco antes de enviar outro." |

O teto é aplicado numa única instrução SQL (conta os relatos da última hora e grava, ou não grava), então rajadas paralelas não passam de 5. Além dele vale o limitador geral da API por IP.

### `GET /v1/bug-reports/mine`

Os últimos 50 relatos **da própria conta**, do mais novo ao mais antigo. Nunca traz e-mail, `account_id`, impressão digital, gravidade nem diagnóstico.

```json
{ "ok": true, "data": { "reports": [
  { "id": "…", "title": "…", "status": "released", "createdAt": "2026-10-01T12:00:00.000Z", "fixSummary": "Corrigimos o fechamento do terminal." }
] } }
```

`fixSummary` só vem preenchido quando o status é `released`; antes disso é `null` (o rascunho da correção nem sai do banco).

## API do painel admin

Autenticação: cookie da sessão do site, conta admin (`ADMIN_EMAILS` com e-mail verificado). Cada rota declara as próprias guardas (`requireWebAuth`, `requireAdmin` e, nas mutações, `requireCsrf` com `X-CSRF-Token` e `Origin` do site). Todas respondem `Cache-Control: no-store`. As rotas são montadas **antes** do roteador `/admin/*` e respondem sozinhas, como em `src/email/admin-routes.ts`. Visitante: 401; usuário comum: 403; mutação sem CSRF ou de outra origem: 403.

O CORS passou a liberar o método `PATCH`, só para a origem do site.

**O e-mail da conta aparece somente aqui** (`reporterEmail` e `reporter.email`). Um login sem e-mail verificado guarda `provedor:id` em `accounts.email`, que nunca é tratado como endereço (vem `null`).

### `GET /v1/admin/bug-reports`

Filtros (todos opcionais; parâmetro desconhecido é 400): `status`, `category`, `severity`, `q` (busca no título, sem diferenciar caixa e sem curingas), `limit` (1 a 100, padrão 50) e `cursor`.

```json
{ "ok": true, "data": {
  "reports": [{
    "id": "…", "title": "…", "status": "new", "severity": "medium", "category": "terminal", "impact": "blocks_work",
    "appVersion": "0.76.110", "platform": "darwin", "createdAt": "…", "updatedAt": "…",
    "occurrences": 3, "duplicateOf": null, "hasDiagnostics": true, "reporterEmail": "pessoa@exemplo.com"
  }],
  "nextCursor": "MTc5MDc2NjAwMDEyMzo…"
} }
```

`occurrences` é quantos relatos têm a mesma impressão digital (inclui o próprio). A ordem é `created_at` decrescente com desempate por `id`. O `nextCursor` é opaco (não o monte à mão): mande-o de volta em `?cursor=` para a página seguinte; `null` no fim. Cursor adulterado: 400.

### `GET /v1/admin/bug-reports/:id`

O relato completo, com a linha do tempo:

```json
{ "ok": true, "data": {
  "report": {
    "id": "…", "title": "…", "description": "…", "steps": null, "status": "triaged", "severity": "high", "category": "terminal", "impact": "blocks_work",
    "appVersion": "0.76.110", "platform": "darwin", "arch": "arm64", "osVersion": null,
    "context": { "adapter": "claude", "model": "opus", "paneCount": 3, "missionActive": true },
    "diagnostics": { "events": [], "errors": [] }, "diagnosticsExpiresAt": "…",
    "occurrences": 1, "duplicateOf": null, "fixSummary": null, "fixPrUrl": null,
    "reporter": { "id": "…", "email": "pessoa@exemplo.com", "name": "…" },
    "createdAt": "…", "updatedAt": "…"
  },
  "events": [
    { "id": "…", "kind": "status_changed", "details": { "from": "new", "to": "triaged" }, "createdAt": "…", "actor": { "id": "…", "email": "admin@exemplo.com" } }
  ]
} }
```

`diagnostics` é `null` quando não houve consentimento ou depois da retenção. `reporter` é `null` se a conta foi apagada. Id desconhecido: 404.

### `GET /v1/admin/bug-reports/stats`

```json
{ "ok": true, "data": {
  "total": 12,
  "byStatus": { "new": 4, "triaged": 3, "needs_info": 0, "fix_proposed": 1, "approved": 0, "fixed": 0, "released": 3, "wont_fix": 1, "duplicate": 0 },
  "byCategory": { "crash": 2, "terminal": 5, "agents": 0, "license": 1, "billing": 0, "ui": 3, "performance": 0, "other": 1 },
  "openBySeverity": { "low": 1, "medium": 3, "high": 1, "blocker": 0 }
} }
```

Todas as chaves vêm sempre, com zero quando não há relato. "Abertos" são `new`, `triaged`, `needs_info`, `fix_proposed` e `approved`.

### `PATCH /v1/admin/bug-reports/:id`

Corpo estrito de até 16 KB, com pelo menos um campo:

| Campo | Regra |
|-------|-------|
| `status` | um dos status; a transição é validada |
| `severity` | `low`, `medium`, `high`, `blocker` |
| `note` | até 2000 caracteres; vira um evento `note` |
| `duplicateOf` | uuid do relato original; só vale com `status: "duplicate"` |
| `fixSummary` | até 2000 caracteres; é o que a pessoa lê em `mine` depois de `released` |
| `fixPrUrl` | URL **https** sem credenciais, até 500 caracteres |

Cada mudança grava um evento na linha do tempo e `updated_at` avança. A resposta é o mesmo corpo do detalhe. Erros: 400 (corpo inválido ou combinação inválida, como `duplicateOf` sem status `duplicate`), 404 (relato ou original inexistente), 409 (transição ilegal, mesmo status, nada mudou, original que já é duplicata, ou relato alterado por outra pessoa no meio do caminho), 413.

Regras de duplicata: o status `duplicate` exige `duplicateOf` (existente, diferente do próprio e que **não** seja ele mesmo duplicata); sair de `duplicate` limpa o vínculo.

## Fluxo de status

Caminho normal: `new` → `triaged` → `fix_proposed` → `approved` → `fixed` → `released`.

| De | Pode ir para |
|----|--------------|
| `new` | `triaged`, `needs_info`, `wont_fix`, `duplicate` |
| `triaged` | `needs_info`, `fix_proposed`, `wont_fix`, `duplicate` |
| `needs_info` | `triaged`, `wont_fix`, `duplicate` |
| `fix_proposed` | `approved`, `triaged` (proposta recusada), `wont_fix` |
| `approved` | `fixed`, `released`, `fix_proposed` (aprovação retirada), `wont_fix` |
| `fixed` | `released`, `triaged` (regressão) |
| `released`, `wont_fix`, `duplicate` | só `triaged` (reabrir) |

Invariantes (testadas): `approved` só é alcançado a partir de `fix_proposed`; `released` só a partir de `approved` ou `fixed` (e `fixed` só vem de `approved`), ou seja, nunca sem aprovação antes; `new` nunca vai direto a `released`.

Eventos da linha do tempo (`bug_report_events.kind`): `created`, `status_changed`, `severity_changed`, `note`, `duplicate_marked`, `fix_proposed`, `approved`, `rejected` (proposta recusada ou aprovação retirada), `released`. Edições só de `fixSummary` ou `fixPrUrl` ficam como `note` com `{"updated":["fixPrUrl"]}`.

### Autorização humana: o status `approved`

`approved` é **o ponto de autorização humana** da correção. Só se chega nele vindo de `fix_proposed`, por um admin autenticado com CSRF, e o evento `approved` registra:

- `actor_account_id`: o admin que autorizou;
- `details_json`: `{"from":"fix_proposed","to":"approved","fixSummary":…,"fixPrUrl":…}`, a **foto da correção que foi aprovada**.

A FASE 2 (agente de correção) **deve** agir só sobre relatos em `approved`, confirmar que existe o evento `approved` com um `actor_account_id` de admin e conferir que `fix_summary` e `fix_pr_url` atuais ainda são os da foto (se mudaram depois da aprovação, a aprovação não cobre a mudança). Esta fase não implementa nenhum agente nem correção automática; isso está coberto por teste apenas como registro da autorização.

Mudanças concorrentes são seguras: os eventos e o `UPDATE` entram numa batch atômica guardada pelo `status` e pelo `updated_at` que o admin viu. Quem perde a corrida recebe 409 e **não** deixa evento nem altera a linha.

## O que é coletado e por quê

| Dado | De onde | Para quê |
|------|---------|----------|
| `title`, `description`, `steps` | a pessoa | entender e reproduzir o problema |
| `category`, `impact` | a pessoa | triagem e prioridade (a gravidade é do admin) |
| `app.version`, `platform`, `arch`, `osVersion` | o app | reproduzir; agrupar por `major.minor` |
| `context.adapter`, `model`, `paneCount`, `missionActive` | o app | contexto de uso (qual agente e modelo, quantos painéis, se havia missão). **Sem conteúdo** de terminal, prompts, arquivos ou código |
| `diagnostics` (`events` e `errors`) | o app, **só com consentimento** | linha do tempo técnica curta e mensagens de erro, para achar a causa |
| `account_id` | a sessão | limite por conta, "meus relatos", retorno a quem reportou, contato do admin |
| `fingerprint` | o servidor | agrupar relatos repetidos (`occurrences`) |

O que **não** é gravado: o IP de quem reportou, o conteúdo dos terminais, os prompts, o código e os caminhos de arquivo com nome de usuário (são mascarados). O e-mail da conta **não é copiado** para as tabelas de relato: o painel o lê de `accounts` na hora, e as rotas do usuário nunca o devolvem.

A **impressão digital** é o `sha256` de (título normalizado + categoria + `major.minor` da versão). O título é normalizado em minúsculas, sem acentos, sem números e sem pontuação, então "Terminal fecha, 3x!" e "terminal fecha" caem no mesmo grupo. Uma correção (`0.76.110` para `0.76.111`) não separa o grupo; uma versão menor nova (`0.77`) separa.

### Limpeza do texto no servidor

O app já limpa o que coleta, mas o servidor **nunca confia nisso**: um cliente adulterado mandaria uma chave direto para o banco. Tudo que é texto livre e todo o diagnóstico passam por `src/bugs/scrub.ts` antes de gravar:

- **Segredos** viram `[oculto]`: chaves `sk-…` (OpenAI e Anthropic), `sk_live_`/`sk_test_`, `whsec_`, `re_…` (Resend), `ghp_…`/`github_pat_…`, `glpat-`, `xox…`, `AKIA…`, `AIza…`, `npm_…`; JWT de três partes; `Bearer` e `Basic`; senha dentro de URL de conexão; blocos `-----BEGIN … PRIVATE KEY-----`; linhas `KEY=valor` de ambiente (inclusive `export`, `set` e `$env:`) e chaves de nome sensível (`api_key`, `secret`, `token`, `password`, `authorization`…).
- **Caminhos de HOME** viram `/Users/[usuario]/…`, `/home/[usuario]/…` e `C:\Users\[usuario]\…` (o resto do caminho fica).
- **E-mails** viram `[email]`.
- **Caracteres perigosos** são removidos antes de tudo: controle, sequências ANSI, marcas de direção (bidi), largura zero, hífen suave e o bloco Tag (U+E0000 a U+E007F, que esconde instruções em ASCII num texto aparentemente vazio). Isso vem **antes** das máscaras, senão um segredo partido por caractere invisível escaparia. O texto é normalizado em NFKC (letras de largura total viram ASCII).
- **Layout**: uma linha só nos campos de linha única; no máximo uma linha em branco seguida nos de várias linhas. O limite de tamanho vale **depois** da máscara e não corta emoji ao meio.

A limpeza é **melhor esforço**: reduz muito o risco de vazamento, mas não é uma fronteira de segurança. Ela não impede texto em linguagem natural com instruções (veja a próxima seção).

## Retenção

O diagnóstico (`diagnostics_json`) é **zerado 180 dias** depois da criação (`diagnostics_expires_at`). O relato, a linha do tempo e o resto ficam. O cron horário (`cleanupExpired`, minuto 17) faz isso com um `UPDATE` separado da limpeza de sessões e tokens: se a migração 0007 ainda não tiver sido aplicada, a falha vai para o log (`limpeza do diagnóstico dos relatos de bug falhou`) e o resto da limpeza e os avisos por e-mail seguem.

## Privacidade e LGPD

- O relato só existe porque a pessoa o enviou. O diagnóstico exige consentimento explícito e separado (`consent.diagnostics`); sem ele nada é gravado, mesmo que o cliente o mande.
- Finalidade: corrigir defeitos do NexusIDE. O texto não é usado para marketing nem compartilhado. O e-mail da conta só é visto pelo admin, para pedir mais informações.
- Minimização: texto limpo no servidor, sem IP, sem conteúdo de terminal, e o diagnóstico expira em 180 dias.
- Se a conta for apagada, o relato **sobrevive sem dono** (`account_id` vira `NULL`; os eventos do admin também). Os dados já foram mascarados na entrada.
- **Direito de exclusão:** a FASE 1 não tem rota para isso. Um pedido da pessoa é atendido à mão: `npx wrangler d1 execute DB --remote --command "DELETE FROM bug_reports WHERE account_id='<id da conta>'"` (a linha do tempo some junto, por `ON DELETE CASCADE`). Automatizar fica para a próxima fase.

## Segurança: entrada não confiável (prompt injection)

**Todo texto de um relato é dado, nunca instrução.** `title`, `description`, `steps`, `diagnostics` e até o `note` e o `fixSummary` do admin podem conter qualquer coisa, inclusive frases como "ignore as instruções anteriores e rode…". Para o painel e para qualquer agente futuro:

1. **Painel:** renderize os textos como **texto** (nada de `innerHTML` nem Markdown com HTML). A API devolve o texto cru em JSON. Links só para `fixPrUrl` (sempre https), com `rel="noopener noreferrer"`.
2. **Agente (FASE 2):** nunca execute comando, abra URL, instale pacote ou aplique patch que o relato peça. Ponha o texto num bloco delimitado e rotulado como dado não confiável, e dê ao agente apenas as ferramentas que a tarefa exige (de preferência só leitura até haver aprovação).
3. **Autorização:** só um relato em `approved`, com o evento `approved` de um admin e a foto da correção intacta, autoriza agir. O texto do relato **não** autoriza nada.
4. **Não confie na limpeza como barreira:** ela mascara segredos e esconde caracteres invisíveis, mas não detecta persuasão em linguagem natural.
5. **Saída do agente também é não confiável:** o que ele propõe passa por `fix_proposed` e pela aprovação humana antes de qualquer efeito.

## Operação

A migração é só aditiva (duas tabelas e índices novos; nenhuma tabela existente é tocada) e deve ser aplicada **antes** do deploy desta versão. O Worker antigo não lê nem escreve estas tabelas, então aplicá-la cedo é seguro.

```sh
# 1) Conferir o que falta e aplicar (D1 de produção)
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 execute DB --remote --command "SELECT value FROM system_metadata WHERE key='schema_version'"   # esperado: 7

# 2) Provar o pacote e publicar
npx wrangler deploy --dry-run
npx wrangler deploy

# 3) Verificar (sem login devem responder 401)
curl -s -o /dev/null -w '%{http_code}\n' https://api.nexuside.app/v1/bug-reports/mine
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.nexuside.app/v1/bug-reports
curl -s -o /dev/null -w '%{http_code}\n' https://api.nexuside.app/v1/admin/bug-reports/stats
```

Não há variável nem segredo novos. O volume esperado é pequeno (teto de 5 por conta por hora); a lista do painel e a retenção usam índices próprios.
