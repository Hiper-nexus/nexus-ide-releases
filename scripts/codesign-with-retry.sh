#!/bin/bash
# Wrapper de codesign para builds de release LOCAIS.
#
# Por quê: com muitos nativos unpacked no asar, o osx-sign dispara dezenas de
# `codesign --timestamp` em sequência e o Timestamp Authority da Apple derruba
# parte da rajada — o build falha DETERMINISTICAMENTE com "A timestamp was
# expected but was not found" (sempre no mesmo arquivo; re-rodar o make
# inteiro não resolve). Reassinar com --force é idempotente, então o retry
# com backoff resolve sem afrouxar nada.
#
# Uso (ver build/notarize.md):
#   PATH="$PWD/scripts/codesign-retry-bin:$PATH" npm run make:release
# onde scripts/codesign-retry-bin/codesign é um symlink para este arquivo
# (criado sob demanda: mkdir -p scripts/codesign-retry-bin && ln -sf
#  ../codesign-with-retry.sh scripts/codesign-retry-bin/codesign).
set -u

last=1
for attempt in 1 2 3 4 5; do
  /usr/bin/codesign "$@" && exit 0
  last=$?
  sleep $((attempt * 4))
done
exit "$last"
