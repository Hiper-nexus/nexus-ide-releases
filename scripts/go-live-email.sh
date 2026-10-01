#!/usr/bin/env bash
# Liga os avisos por e-mail do Nexus (docs/emails.md). Idempotente e fail-closed.
#
#   1. No Resend: adicione o domínio nexuside.app, ponha os registros de DNS que ele mostrar (SPF/DKIM) no Cloudflare,
#      espere "Verified" e crie uma chave com permissão "Sending access" restrita ao domínio. Copie-a.
#   2. Rode:   scripts/go-live-email.sh          → MANDA um e-mail de verdade para o dono, grava os segredos e NÃO liga o disparo
#   3. Confira a caixa de entrada e só então:   scripts/go-live-email.sh --ligar
#   Para desligar a qualquer hora (kill switch):  scripts/go-live-email.sh --desligar
#
# A chave vem da área de transferência (pbpaste), só circula por pipe/stdin e nunca é impressa nem entra na linha de comando.
# O NOTICE_SECRET (assina os links de descadastro) é criado UMA vez e nunca é trocado: trocar quebra todo link já enviado.
set -euo pipefail
cd "$(dirname "$0")/.."

API="https://api.nexuside.app"

die() { echo "ERRO: $*" >&2; exit 1; }
config_value() { python3 - "$1" <<'PY'
import re, sys
text = open('wrangler.jsonc', encoding='utf-8').read()
m = re.search(r'"%s"\s*:\s*"([^"]*)"' % re.escape(sys.argv[1]), text)
print(m.group(1) if m else '')
PY
}
set_config() { python3 - "$1" "$2" <<'PY'
import re, sys
key, value = sys.argv[1], sys.argv[2]
text = open('wrangler.jsonc', encoding='utf-8').read()
pattern = re.compile(r'("%s"\s*:\s*)"[^"]*"' % re.escape(key))
if not pattern.search(text):
    sys.exit('chave %s não encontrada em wrangler.jsonc' % key)
open('wrangler.jsonc', 'w', encoding='utf-8').write(pattern.sub(lambda m: '%s"%s"' % (m.group(1), value), text, count=1))
PY
}
has_secret() { npx --no-install wrangler secret list 2>/dev/null | grep -q "\"name\": \"$1\""; }
api_ok() { curl -fsS "$API/health" >/dev/null && curl -fsS "$API/ready" >/dev/null; }
tree_clean() { [[ -z "$(git status --porcelain -- . ':!wrangler.jsonc')" ]]; }

deploy_flag() { # deploy_flag <true|false>
  tree_clean || die "há alterações não commitadas fora do wrangler.jsonc: commite antes (o deploy sai da árvore atual)"
  [[ "$(config_value APP_MODE)" == "production" ]] || die "wrangler.jsonc não está em APP_MODE production"
  set_config EMAIL_ENABLED "$1"
  npx --no-install wrangler deploy >/dev/null
  sleep 5
  api_ok || die "a API não respondeu depois do deploy: confira /health e /ready"
  git add wrangler.jsonc
  git commit -q -m "chore(producao): avisos por e-mail $([[ "$1" == true ]] && echo ligados || echo desligados) (EMAIL_ENABLED=$1)" || true
}

case "${1:-}" in
  --ligar)
    has_secret RESEND_API_KEY || die "RESEND_API_KEY não está cadastrada: rode o passo 2 antes"
    has_secret NOTICE_SECRET || die "NOTICE_SECRET não está cadastrado: rode o passo 2 antes"
    echo "LIGANDO os avisos por e-mail: o cron (minuto 17 de cada hora) passa a enviar a quem estiver na janela. Ctrl+C em 5 s cancela."; sleep 5
    deploy_flag true
    echo "Ligado. O primeiro envio acontece no próximo minuto 17. Para desligar: scripts/go-live-email.sh --desligar"
    exit 0 ;;
  --desligar)
    deploy_flag false
    echo "Desligado: nenhum e-mail sai até religar."
    exit 0 ;;
  "") ;;
  *) die "uso: scripts/go-live-email.sh [--ligar | --desligar]" ;;
esac

command -v pbpaste >/dev/null || die "este roteiro usa pbpaste (macOS)"
KEY="$(pbpaste | tr -d '\r\n[:space:]')"
[[ "$KEY" =~ ^re_[A-Za-z0-9_]{16,}$ ]] || die "a área de transferência não tem uma chave do Resend (re_…). Copie a chave recém-criada e rode de novo."

FROM="$(config_value EMAIL_FROM)"
[[ -n "$FROM" ]] || die "EMAIL_FROM não está em wrangler.jsonc"
TO="$(config_value ADMIN_EMAILS | cut -d, -f1 | tr -d '[:space:]')"
[[ "$TO" == *@* ]] || die "ADMIN_EMAILS não tem um e-mail para receber a prova do envio"

echo "1/3 Provando o envio com o Resend (um e-mail de verdade para o dono: $TO)…"
BODY="$(python3 - "$FROM" "$TO" <<'PY'
import json, sys
print(json.dumps({
  "from": sys.argv[1], "to": [sys.argv[2]],
  "subject": "Teste do Resend: os avisos do NexusIDE estão ligados à sua conta",
  "text": "Se você está lendo isto, o domínio nexuside.app está verificado no Resend e a chave funciona.\nNenhum aviso automático sai até você rodar scripts/go-live-email.sh --ligar.",
}))
PY
)"
RESPONSE="$(mktemp)"; trap 'rm -f "$RESPONSE"' EXIT
STATUS="$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -sS -K - -o "$RESPONSE" -w '%{http_code}' \
  -H 'Content-Type: application/json' -H 'User-Agent: nexus-go-live-email' --data "$BODY" https://api.resend.com/emails)"
case "$STATUS" in
  200) echo "   Resend aceitou. Confira a caixa de entrada de $TO (veja também o spam)." ;;
  401|403) MESSAGE="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('message',''))" "$RESPONSE" 2>/dev/null || true)"
           die "o Resend recusou (HTTP $STATUS): ${MESSAGE:-sem detalhe}. Confira se o domínio nexuside.app está 'Verified' (DNS) e se a chave tem 'Sending access' nele." ;;
  *) MESSAGE="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('message',''))" "$RESPONSE" 2>/dev/null || true)"
     die "o Resend respondeu HTTP $STATUS: ${MESSAGE:-sem detalhe}" ;;
esac

echo "2/3 Gravando RESEND_API_KEY no Worker (sem imprimir)…"
printf '%s' "$KEY" | npx --no-install wrangler secret put RESEND_API_KEY >/dev/null

echo "3/3 NOTICE_SECRET (assina os links de descadastro)…"
if has_secret NOTICE_SECRET; then
  echo "   Já existe: mantido. Nunca é trocado (trocar quebra todo link de descadastro já enviado)."
else
  openssl rand -base64 32 | tr -d '\n' | npx --no-install wrangler secret put NOTICE_SECRET >/dev/null
  echo "   Criado (44 caracteres) e gravado no Worker."
fi
api_ok || die "a API não respondeu depois de gravar os segredos"

cat <<EOF

PRONTO COM O DISPARO AINDA DESLIGADO (EMAIL_ENABLED=$(config_value EMAIL_ENABLED)). Nesta ordem:
  - Confirme que o e-mail de teste chegou em $TO.
  - Opcional: o botão de teste do painel (POST /v1/admin/notices/test) manda o aviso real "faltam 3 dias" só para você (docs/emails.md > Testar).
  - Ligar:  scripts/go-live-email.sh --ligar      (desligar: --desligar)
EOF
