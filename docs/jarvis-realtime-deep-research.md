# Deep Research: Jarvis realtime operacional

Data: 2026-07-11

## Resumo executivo

A Jarvis não precisa de mais um timeout isolado. Ela precisa separar cinco decisões que hoje se misturam: autorização por wake word, início de fala, fim de turno, interrupção durante TTS e confirmação de efeito de ferramenta. A literatura e as implementações de referência convergem em uma arquitetura híbrida: wake local calibrado; VAD acústico apenas como sinal; detector de fim de turno acústico/semântico; estado explícito de interrupção; e ferramentas com IDs estáveis, idempotência e pós-condição.

Os logs locais confirmam o diagnóstico. A redução do follow-up de 22 s para 8 s funcionou (`liveMuteRescue` em 8,04 s), mas a sessão continuou aceitando comandos `no-wake-hot` fora de uma autoridade conversacional claramente limitada. Em poucos minutos houve 26 amostras passivas, 12 comandos aceitos e 10 transcrições durante a própria fala da Jarvis. Portanto, o gargalo atual não é tempo de inferência: é controle de turno e falso acionamento.

## Descobertas principais

1. **Wake word deve ser local e avaliado por FAR/FRR, não por sensação.** openWakeWord e Porcupine tratam false acceptance rate e false rejection rate como métricas diferentes e recomendam calibração por curva ROC. Um modelo PT-BR só deve entrar em produção depois de testes positivos e horas de áudio negativo representativo do ambiente real.

2. **VAD não significa fim de turno.** OpenAI distingue `server_vad` de `semantic_vad`; LiveKit recomenda combinar VAD com um detector de turno; Deepgram combina endpointing acústico com lacunas entre palavras. Pausa, ruído e fim semântico são sinais diferentes.

3. **Full-duplex exige uma política de interrupção própria.** AEC é pré-requisito, mas double-talk continua sendo o caso mais difícil. Barge-in deve exigir fala próxima confirmada e persistente, cancelar áudio/modelo de forma coordenada e preservar somente o que realmente foi ouvido.

4. **Sessão quente não pode equivaler a autorização infinita.** A janela sem wake deve ter deadline monotônico, ser renovada apenas por fala humana confirmada e expirar após silêncio, efeito de ferramenta ou limite de turnos. Áudio ambiente fora da janela nunca deve virar comando.

5. **Latência precisa ser medida da boca ao ouvido.** Medir somente STT ou resposta do modelo esconde o custo do endpointing. As métricas mínimas são: wake detectado, speech start, speech end, turn committed, primeira chamada de ferramenta, efeito confirmado e primeiro áudio reproduzido.

6. **Ferramenta concluída e narração concluída são eventos distintos.** A interface deve confirmar o efeito assim que a pós-condição ocorre. O modelo pode narrar depois. Para panes, `write()` não prova processamento: o protocolo precisa distinguir resolved, queued, submitted e acknowledged.

## Arquitetura recomendada

### 1. Audio authority plane

Estados exclusivos:

`DORMANT -> WAKE_CANDIDATE -> LISTENING -> ENDPOINTING -> COMMITTED -> THINKING -> SPEAKING -> FOLLOWUP`

Transições obrigatórias:

- `DORMANT -> WAKE_CANDIDATE`: somente wake local ou clique/PTT.
- `WAKE_CANDIDATE -> LISTENING`: confiança local aprovada; STT remoto serve como fallback temporário, não como arquitetura final.
- `LISTENING -> ENDPOINTING`: VAD detecta silêncio, mas ainda não entrega o turno.
- `ENDPOINTING -> COMMITTED`: silêncio mínimo + detector semântico/acústico ou teto máximo.
- `SPEAKING -> LISTENING`: apenas barge-in confirmado; eco e ruído não interrompem.
- `FOLLOWUP -> LISTENING`: fala iniciada dentro do prazo.
- `FOLLOWUP -> DORMANT`: deadline expirado; volta a exigir wake.

Regras iniciais para calibração, não verdades universais:

- fim acústico rápido: 500–800 ms;
- extensão semântica: até 1.200–1.800 ms quando a frase parece incompleta;
- follow-up autorizado: 6–8 s;
- barge-in: pelo menos 250–400 ms de fala próxima após AEC;
- nenhuma chamada passiva de STT durante `SPEAKING`, salvo candidato real de barge-in;
- máximo de 3 turnos sem novo wake antes de renovar autorização explicitamente.

### 2. Wake PT-BR

Criar um conjunto versionado:

- positivos: diferentes pessoas, distâncias, volumes, microfones e sotaques;
- negativos difíceis: “Jardim”, “Jair”, “já vi”, áudio da própria Jarvis, TV, música e conversas;
- silêncio e ruído real capturados em macOS, Windows e Linux;
- teste separado por dispositivo, nunca misturando treino e avaliação da mesma pessoa.

Gate de release sugerido:

- FAR medido em horas de áudio negativo;
- FRR por pessoa/dispositivo/SNR;
- curva ROC registrada;
- modelo rejeitado automaticamente quando dispara em silêncio ou eco.

### 3. Turn detector híbrido

Curto prazo: manter WebRTC/AEC3, usar VAD local para início/fim acústico e aplicar heurísticas linguísticas somente depois de transcript parcial. Médio prazo: avaliar um detector de fim de turno por áudio, como o padrão proposto pelo LiveKit, porque esperar transcript aumenta latência e falha em ruído.

O provedor realtime pode continuar fazendo VAD, mas não deve ser a única autoridade. Eventos do provedor são evidência adicional dentro da máquina de estados local.

### 4. Panes e workspaces

- catálogo canônico de workspaces e panes injetado a cada mudança de layout/foco;
- ações referenciam IDs estáveis, não nomes livres;
- resolução fuzzy local somente antes da ação e somente quando o resultado é único;
- `open_existing_workspace` e `create_workspace` permanecem intenções separadas;
- comandos a pane recebem `commandId`, `paneId`, `missionId` e estado de entrega;
- retry apenas no mesmo pane e somente quando a sessão ainda representa a mesma instância;
- sucesso verbal somente após pós-condição ou acknowledgment observável.

## SLOs propostos

| Métrica | Meta inicial | Meta madura |
|---|---:|---:|
| Wake local p95 | < 250 ms | < 150 ms |
| Speech-end -> commit p95 | < 900 ms | < 650 ms |
| Commit -> primeiro áudio p95 | < 1.500 ms | < 900 ms |
| Barge-in -> áudio interrompido p95 | < 350 ms | < 200 ms |
| Tool dispatch -> efeito local p95 | < 500 ms | < 250 ms |
| FAR | < 1/h | < 1/10 h |
| Entrega ao pane sem destino incorreto | 100% | 100% |

## Backlog priorizado

### P0 — antes de publicar

1. Fazer `FOLLOWUP` expirar para `DORMANT`; bloquear `no-wake-hot` fora da janela.
2. Não chamar STT passivo durante `SPEAKING` sem candidato local de barge-in.
3. Centralizar todos os deadlines e transições em uma máquina de estados testável.
4. Instrumentar timestamps do turno ponta a ponta e dashboards p50/p95/p99.
5. Construir e validar o dataset PT-BR de wake; manter fallback remoto somente enquanto o modelo não passar no gate.
6. Completar acknowledgment de panes e testes de pane fechado/recriado/ambíguo.

### P1 — qualidade realtime

1. Detector híbrido de fim de turno com transcript parcial/semântica.
2. Preconexão controlada do provedor sem abrir autoridade de microfone.
3. Política explícita de barge-in e truncamento de áudio ouvido.
4. Testes com ruído, eco, música, fala sobreposta e microfones reais nos três sistemas.

### P2 — excelência

1. Detector de fim de turno diretamente por áudio multilíngue.
2. Personalização opcional de wake/speaker verification local.
3. Replay determinístico de sessões de áudio anonimizadas.
4. Avaliação contínua de regressão por FAR, FRR, EOT e barge-in.

## Riscos e contrapontos

- Semantic VAD reduz cortes prematuros, mas pode adicionar latência e ainda errar; não substitui deadlines.
- Full-duplex irrestrito parece mais natural em demos, porém aumenta falsos barge-ins em notebooks com alto-falante aberto.
- Speaker verification melhora segurança, mas pode piorar acessibilidade e não deve ser obrigatória.
- Um wake engine comercial pode acelerar qualidade, mas adiciona licença e dependência. O projeto deve manter um benchmark independente para evitar confiar em números do fornecedor.
- Metas de latência sem áudio real são enganosas. Testes sintéticos devem ser complementados por hardware e ambientes reais.

## Questões em aberto

- Qual FAR/FRR aceitável para os usuários reais da Jarvis em cada plataforma?
- O detector PT-BR será openWakeWord treinado internamente, Porcupine ou ensemble?
- O acknowledgment do pane será baseado no PTY, prompt do shell ou protocolo do agente?
- Quais trechos de áudio podem ser mantidos localmente para replay sem violar privacidade?

## Fontes

- [OpenAI Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) — server VAD, semantic VAD e parâmetros de turno.
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) — interrupções, eventos e function calling realtime.
- [Google Gemini Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) — VAD automático/manual, interrupções e limites de sessão.
- [LiveKit turns](https://docs.livekit.io/agents/logic/turns/) — VAD, endpointing, interrupção adaptativa e controle manual.
- [LiveKit turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/) — detector acústico/semântico de fim de turno.
- [Deepgram end-of-speech](https://developers.deepgram.com/docs/understanding-end-of-speech-detection) — combinação de endpointing e lacunas entre palavras.
- [Deepgram UtteranceEnd](https://developers.deepgram.com/docs/utterance-end) — detecção por intervalo após a última palavra.
- [Deepgram endpointing](https://developers.deepgram.com/docs/endpointing) — VAD e `speech_final`.
- [openWakeWord](https://github.com/dscripka/openWakeWord) — wake local, treino, VAD e supressão de ruído.
- [Porcupine wake benchmark](https://picovoice.ai/blog/benchmarking-a-wake-word-detection-engine/) — FAR, FRR e curva ROC.
- [WebRTC Audio Processing Module](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/g3doc/audio_processing_module.md) — AEC, NS e AGC.
- [Full-Duplex-Bench](https://arxiv.org/abs/2503.04721) — avaliação de pausas, turn-taking e interrupção.
- [FireRedChat](https://arxiv.org/abs/2509.06502) — controlador full-duplex e métricas de barge-in/EOT/latência.
- [Pipecat speech input](https://docs.pipecat.ai/pipecat/learn/speech-input) — estratégias de início/fim e interrupção.
- [Deepgram function calling](https://developers.deepgram.com/docs/voice-agents-function-calling) — ferramentas durante conversas de voz.

## Rerun inputs

workflow: firecrawl-deep-research
topic: arquitetura realtime operacional para Jarvis local multiplataforma
depth: exhaustive
output: markdown
