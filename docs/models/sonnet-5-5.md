# Claude Sonnet 5.5

Integração em 28/09/2026. Fonte primária: registro de modelos e tabela de
preços embutidos no executável Claude Code **2.1.284** instalado localmente.
Lançamento oficial confirmado no [anúncio da Anthropic](https://www.anthropic.com/claude-sonnet-5-5)
de 28/09/2026. O anúncio confirma disponibilidade geral e os preços de entrada,
saída e leitura de cache. Os demais dados abaixo foram conferidos no registro da CLI.

| Campo | Registro da CLI |
|---|---|
| ID first-party | `claude-sonnet-5-5` |
| Família | `sonnet` |
| Contexto | 1.000.000 tokens; `native_1m` |
| Saída máxima | 128.000 tokens |
| Esforço padrão | `medium`; suporta `xhigh` e `max` |
| Entrada | texto e imagem |
| Preço | `tier_2_10`: USD 2 entrada / 10 saída por milhão de tokens |
| Cache | USD 0,20 leitura / 2,50 escrita 5 min / 4 escrita 1 h por milhão |

O catálogo publicado, fallback bundled, adapter Claude e metadados ricos
incluem o ID exato sem aviso de beta. O gerador do catálogo rico conserva um
overlay com a fonte para não perder a entrada no próximo re-sync. Sonnet 5
continua disponível e seu default é preservado. Nenhum benchmark foi inventado;
não se presume disponibilidade em Aider, OpenCode, Devin ou Copilot.

O roteador que recebe a classificação/esforço do Jev oferece o ID exato nas
faixas easy/medium e preserva as rotas antigas quando ele não estiver no
catálogo disponível. Um pedido explícito de Sonnet 5.5 resolve para o ID novo;
o esforço julgado pelo Jev continua chegando à seleção.
Preços são estimativas da tabela da CLI, não prova de cobrança ou acesso.

Uso real e velocidade preservam o ID recebido no transcript. Cotas continuam
medidas por conta: janelas compartilhadas de 5 horas/semana e, quando informada
pelo provedor, janela `weekly_scoped` com `display_name: Sonnet 5.5`. Não há
multiplicador de cota inferido do preço, janela artificial nem escolha de conta
pelo Jev. O Redline já consome essas janelas sem catálogo de modelos próprio.

Testes de regressão cobrem catálogo antigo com default fixado, metadados ricos,
transcript com ID distinto e cota específica junto das janelas compartilhadas.
Os testes existentes de Redline e velocidade também são parte da validação.

Validação local: 458 testes passaram em 16 suítes de catálogo, roteamento,
preços, uso, cotas, Redline e velocidade; auditoria de renderer com zero sinks.
CodeRabbit revisou catálogo/metadados e os testes de uso/cotas sem achados.

Limite de verificação: não foi feita inferência paga nem validada disponibilidade
em todas as contas. A presença do registro no binário não garante rollout para
outra conta. Nenhuma credencial ou instalação de CLI foi alterada.
