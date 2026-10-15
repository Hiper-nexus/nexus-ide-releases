# Correção das provas nativas da candidata Mac

Base: candidata 0.76.273, herdando Windows 0.76.272. Nenhum script de produção,
limite de segurança, credencial real ou política de prioridade foi alterado.

## Grok

O teste falhava antes de iniciar a CLI: uma instrumentação de diagnóstico
reescrevia uma cópia privada de vários scripts usando strings que deixaram de
existir após F-1434/F-1479. Agora executa a cópia fiel dos scripts distribuídos.
Os diagnósticos de recusa já são fornecidos pelo runtime.

Permanecem as provas de admissão, execução única do make e do snapshot, grant e
release, mesma lease, processos fisicamente encerrados e hash da CLI intacto.
Limpeza do diretório começa imediatamente após mkdtemp; fechamento do servidor e
pool é registrado antes de escutar, inclusive se a montagem da fixture falhar.

## OpenCode

O help local do OpenCode 1.19.0 aceita `--log-level DEBUG` e `--pure`; não aceita
`debug` minúsculo nem `--standalone`. Os argumentos antigos faziam a CLI sair com
help e código 1, antes do teste real. Corrigidos somente os argumentos da fixture.
HOME/config temporários, chave fictícia e rede externa negada continuam intactos.

## Prioridade macOS

Reproduzido: no contexto normal o processo tem utility `0x11`; sob LaunchAgent
com `ProcessType=Background`, a política herdada impõe `0x9` mesmo com utility.
`taskpolicy -b` sozinho não reproduz a classe do LaunchAgent.

O teste mede `taskpolicy -c utility` diretamente no MESMO contexto e compara a
classe do executor com essa referência (somente `0x9`/`0x11`). O opt-out é
comparado com uma execução direta. Além disso, um preload observador registra a
invocação real de `taskpolicy` em job-launch e dispatch: ambos precisam emitir
`-c utility`; opt-out precisa não emitir. Assim, usar spawn direto não passa
silenciosamente quando as duas classes são `0x9`. Scripts distribuídos intactos.

## Evidência

- Contexto normal: 3 arquivos, 15 testes passaram, sem skips.
- LaunchAgent Background: arquivo completo de prioridade, 13 testes passaram,
  exit 0, sem skips. Job temporário removido após término confirmado.
- Logs locais: `release-artifacts/nexus-ui/release-blockers-tests.log` e
  `qos-background-green.log`/`.err`.
- Revisão independente confirmou a prova de integração e a limpeza; sem achados
  pendentes neste escopo. A suíte completa do produto ainda é um gate separado.
