# F-764 C.7 — Aceitação da faixa no candidato empacotado

O probe inicial `--verify-hang-probe` continua disponível. A modalidade abaixo
exercita a janela já montada e preserva evidência fora do perfil temporário do
smoke. Requer o candidato final assinado/notarizado; testes de fonte não provam
o resultado desse comando.

```sh
/opt/homebrew/opt/node@22/bin/node scripts/smoke-packaged-app.mjs \
  --verify-busy-banner-probe \
  --app out/NexusIDE-darwin-arm64/NexusIDE.app \
  --expected-version 0.76.191 \
  --evidence-dir /CAMINHO/ABSOLUTO/NOVO/c7-packaged-acceptance
```

A pasta de evidência precisa ter pai existente e não pode existir previamente.
O harness cria seu próprio perfil privado, HOME e TMP. Não usa o app ou perfil
do operador, não abre porta CDP, não muda os fuses e não expõe uma API de hang
no renderer. `NEXUS_SMOKE_BUSY_BANNER_PROBE=1` sozinha não arma nada.

O fluxo espera o renderer e o supervisor de PTY. O preload arma a observação
da região real `.main-busy` em dois frames vazios e visíveis; só esse frame
montado, com nonce da rodada, pode disparar o Main. O Main usa o indutor real
de 40 segundos. O renderer segue pintando: a região precisa ganhar a faixa
com texto correto, visibilidade computada, tamanho positivo e retângulo dentro
do viewport em dois frames diferentes. A faixa precisa ser removida depois
da recuperação do Main. Só então o smoke funcional existente começa.

Saída 0 e `[smoke] busyBannerProof` exigem também profile capturado durante
esse episódio, recuperação do mesmo heartbeat após 40 segundos, topo e posição
conferidos diretamente nas amostras do inspector, versão do candidato, smoke
funcional posterior e teardown gracioso com inventário físico de PTY e nenhum
órfão. Um recibo de DOM não aprova um profile de outro travamento.

Artefatos preservados:

- `busy-banner-smoke.json`: PID/versão, nonce, intervalo real do Main e amostras
  do renderer (início, dois frames visíveis, remoção, retângulo e viewport).
- `main-hang.ndjson`: registros independentes do watchdog.
- `main-hang-*.cpuprofile`: profile original do inspector, legível fora do app.
- `acceptance.json`: prova agregada, escrita somente após o smoke funcional e
  a saída graciosa. Ausência desse arquivo significa aceite incompleto.

O observer não oferece prova de pixel por screenshot. Ele verifica a região
de produto realmente montada e sua capacidade de pintar em frames distintos.
Uma captura complementar pode ser anexada sem substituir os recibos exigidos.
