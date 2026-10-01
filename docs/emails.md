# Avisos por e-mail (Resend)

Preparado em 01/10/2026. **Estado atual: desligado.** O código, a migração e os testes estão prontos, mas nada é enviado até o passo 4 de [Conectar o Resend](#conectar-o-resend). Com `EMAIL_ENABLED="false"` (o padrão do `wrangler.jsonc`) o cron horário não consulta o banco nem chama o Resend para este fim.

## O que é enviado e quando

Só e-mails ligados ao teste de 15 dias. Cada conta recebe no máximo um e-mail de cada tipo, e quem está na janela de mais de um tipo recebe só o mais urgente.

| Tipo | Quando sai | Assunto |
|------|-----------|---------|
| `welcome` | nas primeiras 24 h depois de criar a conta | Bem-vindo ao NexusIDE: seu teste de 15 dias começou |
| `trial_ending_3d` | o teste termina em mais de 24 h e até 3 dias | Seu teste do NexusIDE termina em 3 dias (ou 2) |
| `trial_ending_1d` | o teste termina em até 24 h | Seu teste do NexusIDE termina em 24 horas |
| `trial_ended` | o teste terminou há até 7 dias | Seu teste do NexusIDE terminou |

Quem **não** recebe nada: conta Pro (assinatura ou código de licença), administrador, conta suspensa, conta que usou o link de descadastro e conta sem e-mail entregável (o login sem e-mail verificado guarda `provedor:id` em `accounts.email`, que nunca é tratado como endereço).

O texto não escreve preço e não promete nada além do que existe (ele diz que nada é cobrado sem a confirmação da pessoa). O prazo do teste e o limite de agentes vêm de `TRIAL_DAYS` e `TRIAL_MAX_AGENTS`. Para mostrar o valor nos avisos de fim de teste, passe `priceLabel` na função `template()` de `src/email/dispatch.ts` (o modelo já aceita e escapa o texto).

**Ao ligar pela primeira vez:** as janelas limitam quem recebe. Na primeira execução saem os avisos de quem se cadastrou nas últimas 24 h, de quem tem o teste terminando nos próximos 3 dias e de quem teve o teste terminado nos últimos 7 dias. Quem teve o teste encerrado há mais de 7 dias não recebe nada. Ao todo são até 50 e-mails por execução (por urgência); o que sobrar sai nas execuções horárias seguintes.

## O que o cron faz

A cada hora (minuto 17) o Worker limpa o que expirou (`cleanupExpired`) e, depois, roda `sendDueNotices`, dentro do mesmo `waitUntil`. Uma falha de e-mail é registrada e nunca desfaz nem esconde a limpeza.

- **Desligado** (`EMAIL_ENABLED` diferente de `"true"`, ou falta `RESEND_API_KEY` ou `NOTICE_SECRET`): não faz nada. Nenhuma consulta, nenhuma chamada, nenhuma marca.
- **Ligado:** uma consulta ao D1 reaproveita a mesma classificação de acesso do painel admin (`src/classified.ts`), pré-filtra pelas janelas acima e traz até 50 contas, as mais urgentes primeiro (24 h, terminou, 3 dias, boas-vindas). Cada envio leva `Idempotency-Key: <conta>:<tipo>` e, quando o Resend aceita, a marca vai para `account_notices` (em blocos de 10, para gastar poucas consultas D1).
- **Falha que passa sozinha** (429, 5xx, rede, prazo de 10 s): não marca e tenta de novo na hora seguinte. Três seguidas interrompem o lote.
- **Falha definitiva** (outros 4xx): não marca e registra uma linha por execução, sem endereço e sem chave. `401`/`403` (chave recusada, domínio não verificado) interrompem o lote inteiro. Um endereço que o Resend recusa (422) volta a ser tentado a cada hora enquanto a janela do aviso durar; olhe o log se o mesmo erro se repetir.
- **Queda entre enviar e marcar:** o Resend recusa o reenvio repetido pela chave de idempotência por 24 h, então a pessoa não recebe duas vezes. Se o corpo mudou entre as tentativas (o "faltam N dias"), o Resend responde 409 `invalid_idempotent_request`; o Worker entende que o envio anterior saiu e só marca.
- Se não for possível gravar as marcas, o lote para em vez de continuar enviando sem registro.

## Conectar o Resend

Faça nesta ordem. Até o passo 4 nada é enviado.

### 0. Aplicar a migração 0006 em produção (antes de tudo)

```sh
npx wrangler d1 migrations apply DB --remote
```

A migração cria `account_notices`, a coluna `accounts.notices_opt_out` e aceita a ação `test_notice` na auditoria. Aplique **antes** do deploy desta versão e antes de ligar. Com o e-mail desligado o Worker não depende dela para os avisos. Contas que já existem entram com os avisos ligados; quem não quiser usa o link de descadastro de cada e-mail.

### 1. Criar a conta no Resend

Crie a conta em <https://resend.com>.

### 2. Adicionar e verificar o domínio `nexuside.app`

No painel do Resend: Domains → Add Domain → `nexuside.app`. O Resend mostra os registros DNS exatos (SPF e DKIM, mais o registro de retorno). Cadastre-os na zona DNS do domínio, espere o status **Verified** e só então siga. Recomendado: um registro `_dmarc` (por exemplo `v=DMARC1; p=none`) para acompanhar a entrega antes de endurecer a política.

O remetente padrão é `NexusIDE <avisos@nexuside.app>` (`EMAIL_FROM` em `wrangler.jsonc`); qualquer endereço do domínio verificado serve. Respostas vão para esse endereço, então crie a caixa ou o alias se quiser lê-las.

### 3. Criar a chave e cadastrar os dois segredos

No Resend: API Keys → Create → permissão **Sending access**, restrita ao domínio `nexuside.app`. Depois:

```sh
npx wrangler secret put RESEND_API_KEY      # cole a chave do Resend
openssl rand -base64 32                     # gera o segredo dos links de descadastro
npx wrangler secret put NOTICE_SECRET       # cole o valor gerado
```

`secret put` publica uma versão nova na hora, mas isso não envia nada enquanto `EMAIL_ENABLED` for `"false"`.

`NOTICE_SECRET` assina os links de descadastro e precisa ter pelo menos 32 caracteres (o comando acima gera 44); com um segredo menor o envio não liga. **Não o troque sem necessidade:** todo e-mail já enviado carrega um link assinado com ele, e trocar o segredo faz esses links passarem a responder "link inválido". Guarde o valor num cofre.

### 4. Ligar e publicar

Em `wrangler.jsonc`, troque `"EMAIL_ENABLED":"false"` por `"EMAIL_ENABLED":"true"` e publique:

```sh
npx wrangler deploy
```

A próxima execução do cron (minuto 17) já envia o que estiver na janela. Se o domínio ainda não estiver verificado ou a chave estiver errada, o Resend responde 401/403, o lote para sem marcar nada, e o envio retoma sozinho na hora seguinte à correção.

## Testar

Logo depois do passo 4, confira a ligação com o envio de teste do painel admin: `POST /v1/admin/notices/test`. Ele manda o aviso `trial_ending_3d` **só para o e-mail de quem chamou** (com um link de descadastro válido da própria conta), não marca nada em `account_notices` e registra `test_notice` em `admin_audit` sem o endereço. A resposta é `{"ok":true,"sent":true}` ou `{"ok":true,"sent":false,"reason":"http_403:..."}`.

Sem `EMAIL_ENABLED`, `RESEND_API_KEY` e `NOTICE_SECRET` ele responde 503 com "Defina EMAIL_ENABLED, RESEND_API_KEY e NOTICE_SECRET para enviar e-mails." Ele exige a sessão do admin e o CSRF do site; pelo console do navegador, em `https://nexuside.app/admin/` já logado:

```js
const api = 'https://api.nexuside.app';
const { data } = await (await fetch(`${api}/v1/web/session`, { credentials: 'include' })).json();
const response = await fetch(`${api}/v1/admin/notices/test`, {
  method: 'POST', credentials: 'include', body: '{}',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken },
});
console.log(response.status, await response.json());
```

## Descadastro (LGPD)

Todo e-mail traz a linha "Você recebeu este aviso porque criou uma conta no NexusIDE", um link de descadastro no corpo e os cabeçalhos `List-Unsubscribe` e `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), que fazem o Gmail e o Outlook mostrarem o botão "cancelar inscrição".

- `GET /v1/notices/unsubscribe?a=<conta>&t=<token>`: página de confirmação e `notices_opt_out=1`. Repetir o link é seguro. `HEAD` (pré-visualização de link) não descadastra.
- `POST /v1/notices/unsubscribe?a=<conta>&t=<token>`: o one-click do cliente de e-mail.
- O token é o HMAC-SHA256 da conta com `NOTICE_SECRET`, comparado em tempo constante. Não há login. Token errado, conta alheia ou parâmetro faltando devolvem a mesma página 400 genérica, sem revelar o motivo. As duas rotas passam pelo limitador da API.

## Resumo

| Item | Onde |
|------|------|
| Regra de quem recebe o quê | `src/email/notices.ts` |
| Modelos (HTML de marca e texto) | `src/email/templates.ts` |
| Cliente do Resend | `src/email/resend.ts` |
| Token, URL e rotas de descadastro | `src/email/unsubscribe.ts`, `src/email/routes.ts` |
| Despacho do cron | `src/email/dispatch.ts`, ligado em `src/index.ts` |
| Envio de teste do admin | `src/email/admin-routes.ts` |
| Tabela e coluna | `migrations/0006_account_notices.sql` |
| Configuração | `EMAIL_ENABLED`, `EMAIL_FROM` (vars) e `RESEND_API_KEY`, `NOTICE_SECRET` (secrets) |
