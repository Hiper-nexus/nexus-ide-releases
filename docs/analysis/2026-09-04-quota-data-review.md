# Revisão dos dados de uso e cotas — 04/09/2026

**Revisão independente concluída em 05/09:** os quatro casos residuais de F-401 foram corrigidos e repetidos em VM com sentinelas. Gate final: 255 testes em 21 arquivos. Isso valida o código neste escopo; a prova do app recompilado ocorre separadamente.

As falhas não estavam apenas no desenho da tela. O parser de Codex duplicava uma janela semanal em 5 horas; a sonda Claude ignorava o Keychain; resolvers de contas podiam consultar a credencial global e atribuir o resultado à conta errada. Também havia percentuais normalizados incorretamente e cache vencido apresentado como recente.

## Correções entregues no código

- **Identidade:** conta pinada só consulta sua própria credencial. Upstream explicitamente configurado conserva o adapter dono e aparece separadamente como `usageProviderId`. O resolver canônico revalida configuração/conta/modo/destino, usa a precedência do spawn e não reaproveita lista multi-origem. Perfil incompatível/órfão, cofre frio e chave indisponível permanecem desconhecidos.
- **Origem HTTP:** a sonda genérica exige fornecedor declarado. Prefixos servem para rejeitar incompatibilidade, nunca para autorizar destino; JWT genérico fica desconhecido. OpenCode conserva o providerId de origem. Removidas tentativas de uma mesma credencial em outros fornecedores.
- **Números:** cada janela representa o período realmente observado; 1% permanece 1%; tokens locais são contagem absoluta, sem denominador fictício. Cooldown de autenticação não conta como quota alta.
- **Frescor:** dentro do TTL de 60 segundos, o timestamp da entrada preserva a observação original. Se a nova sonda falha depois do TTL, o valor é descartado e passa a desconhecido. Identidade integral do cache, observações locais e geração impedem mistura ou publicação tardia, incluindo chamadas coalescidas.
- **Claude no macOS:** leitura limitada e assíncrona da fatia OAuth do Keychain, sem alterar credenciais. A lista de providers usada pela quota permanece não bloqueante.

## Evidência e limites

Antes dos ajustes, o DEV mostrava Codex com 55% em 5 horas e na semana, ambos com o mesmo reset distante cerca de sete dias. O teste de parser reproduziu a duplicação quando só existe uma janela semanal. Claude estava conectado no diagnóstico, mas sem percentuais na frota; uma consulta somente leitura anterior à suspensão das sondas obteve HTTP 200 com 0% em 5 horas e 11% semanal.

Não há evidência coletada de envio real de uma credencial a fornecedor indevido. O risco de F-401 foi confirmado pelo caminho de produção e por requisições simuladas com sentinelas fictícias. Após identificar o risco, a validação de quota usou HOME/diretórios de configuração temporários, ambiente de chaves vazio e transportes simulados.

Fornecedores sem API de quota suportada continuam sem percentual. Cofre frio não é substituído por outra conta. Um login válido, isoladamente, não comprova disponibilidade de telemetria do fornecedor. A revisão visual da tela e a prova do app recompilado são realizadas separadamente.

## Verificação

255 testes passaram em 21 arquivos de quota, autenticação e resolução canônica. A execução utilizou HOME/configs temporários, ambiente sem chaves e mocks de dependências externas. O replay independente aprovou os quatro residuais e suas variantes de concorrência. Typecheck, verificação de sinks do renderer e diff check passaram. Findings: F-017 a F-028 e F-401. Nenhum app empacotado foi atualizado por esta revisão de dados.
