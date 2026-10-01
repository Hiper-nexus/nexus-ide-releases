#!/usr/bin/env bash
# Virada do Nexus para PRODUÇÃO no Stripe (docs/go-live.md §3.2). Idempotente e fail-closed.
#
#   1. Crie a chave restrita live do Nexus no Stripe e copie-a (a chave fica na área de transferência).
#   2. Rode:   scripts/go-live-stripe.sh            (prepara tudo com as vendas FECHADAS)
#   3. Confira o resumo e só então:  scripts/go-live-stripe.sh --abrir-vendas   (COBRANÇA REAL)
#
# A chave vem da área de transferência (pbpaste), só circula por pipe e nunca é impressa.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_DB_NAME="nexus-cloud-prod"
PROD_DB_ID="8997e871-cb89-4bf5-92b7-3d1b57de135f"
API="https://api.nexuside.app"

die() { echo "ERRO: $*" >&2; exit 1; }
status_field() { curl -fsS "$API/v1/public/status" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print($1)"; }

set_config() { # set_config <chave-json> <valor>
  python3 - "$1" "$2" <<'PY'
import re, sys
key, value = sys.argv[1], sys.argv[2]
path = 'wrangler.jsonc'
text = open(path, encoding='utf-8').read()
pattern = re.compile(r'("%s"\s*:\s*)"[^"]*"' % re.escape(key))
if not pattern.search(text):
    sys.exit('chave %s não encontrada em wrangler.jsonc' % key)
open(path, 'w', encoding='utf-8').write(pattern.sub(lambda m: '%s"%s"' % (m.group(1), value), text, count=1))
PY
}

if [[ "${1:-}" == "--abrir-vendas" ]]; then
  [[ "$(status_field "d['ready']")" == "False" ]] || die "as vendas já estão abertas ou o status não respondeu"
  grep -q "\"database_name\":\"$PROD_DB_NAME\"" wrangler.jsonc || die "wrangler.jsonc ainda não aponta para $PROD_DB_NAME: rode o passo 2 antes"
  grep -q '"APP_MODE":"production"' wrangler.jsonc || die "APP_MODE não é production: rode o passo 2 antes"
  echo "ABRINDO VENDAS (cobrança real). Ctrl+C em 5 s cancela."; sleep 5
  set_config MIGRATION_READY true
  npx --no-install wrangler deploy >/dev/null
  sleep 65 # o status tem cache de até 60 s
  echo "ready=$(status_field "d['ready']") preço=$(status_field "d['billing']['amount']")/$(status_field "d['billing']['currency']")/$(status_field "d['billing']['interval']")"
  echo "Pronto. Não rode cartões de teste em live: a validação é a primeira compra real de um cliente."
  exit 0
fi

command -v pbpaste >/dev/null || die "este roteiro usa pbpaste (macOS)"
KEY="$(pbpaste | tr -d '\r\n[:space:]')"
[[ "$KEY" =~ ^(rk|sk)_live_[A-Za-z0-9]+$ ]] || die "a área de transferência não tem uma chave live do Stripe (rk_live_… ou sk_live_…). Copie a chave recém-criada e rode de novo."

echo "1/6 Fechando as vendas no ar (mantém o resto como está)…"
set_config MIGRATION_READY false
npx --no-install wrangler deploy >/dev/null
[[ "$(status_field "d['ready']")" == "False" ]] || { sleep 65; [[ "$(status_field "d['ready']")" == "False" ]] || die "não consegui fechar as vendas"; }

echo "2/6 Provisionando o Stripe LIVE (produto, preço, portal e webhook; nada é duplicado)…"
RESULT="$(STRIPE_SECRET_KEY="$KEY" node scripts/provision-stripe.mjs --live --json)"
PRICE_ID="$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['priceId'])")"
HOOK_SECRET="$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('webhookSecret') or '')")"
[[ "$PRICE_ID" == price_* ]] || die "o provisionamento não devolveu um preço"

echo "3/6 Gravando os segredos no Worker (sem imprimir)…"
printf '%s' "$KEY" | npx --no-install wrangler secret put STRIPE_SECRET_KEY >/dev/null
if [[ -n "$HOOK_SECRET" ]]; then
  printf '%s' "$HOOK_SECRET" | npx --no-install wrangler secret put STRIPE_WEBHOOK_SECRET >/dev/null
else
  echo "   O webhook live já existia: o signing secret só aparece no painel do Stripe (Developers > Webhooks > destino > Revelar)."
  echo "   Copie-o e rode:  pbpaste | tr -d '\\r\\n' | npx wrangler secret put STRIPE_WEBHOOK_SECRET"
fi

echo "4/6 Trocando banco, modo e preço (conjunto completo, ainda com vendas fechadas)…"
python3 - "$PROD_DB_NAME" "$PROD_DB_ID" <<'PY'
import re, sys
name, ident = sys.argv[1], sys.argv[2]
text = open('wrangler.jsonc', encoding='utf-8').read()
text, n1 = re.subn(r'("database_name"\s*:\s*)"[^"]*"', lambda m: '%s"%s"' % (m.group(1), name), text, count=1)
text, n2 = re.subn(r'("database_id"\s*:\s*)"[^"]*"', lambda m: '%s"%s"' % (m.group(1), ident), text, count=1)
if n1 != 1 or n2 != 1:
    sys.exit('não achei o binding D1 em wrangler.jsonc')
open('wrangler.jsonc', 'w', encoding='utf-8').write(text)
PY
set_config APP_MODE production
set_config STRIPE_PRICE_PRO "$PRICE_ID"
set_config MIGRATION_READY false
npx --no-install wrangler deploy >/dev/null

echo "5/6 Conferindo o ar…"
sleep 5
curl -fsS "$API/health" >/dev/null && echo "   /health ok"
curl -fsS "$API/ready" >/dev/null && echo "   /ready ok (banco de produção respondendo)"
echo "   status: ready=$(status_field "d['ready']") billing=$(status_field "d['billing']")"

echo "6/6 Guardando a configuração no git…"
git add wrangler.jsonc
git commit -q -m "chore(producao): banco $PROD_DB_NAME, APP_MODE production e preço live (vendas fechadas)" || true

cat <<EOF

PRONTO COM AS VENDAS FECHADAS. O que falta, nesta ordem:
  - Entrar de novo em https://nexuside.app/conta/ (a base de produção começa vazia) com retornoja@gmail.com via Google.
  - Conferir /admin/ e o código de licença do dono.
  - Google: publicar o app na tela de consentimento (Audience > Publicar) para clientes reais usarem o Google.
  - Abrir as vendas:  scripts/go-live-stripe.sh --abrir-vendas
EOF
