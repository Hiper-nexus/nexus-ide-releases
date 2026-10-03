# Prontidão da credencial Qwen

O veredito refere-se à credencial configurada que a sonda efetivamente resolveu,
com identidade apenas em memória. Não afirma que uma conta gerenciada diferente
ou uma assinatura nativa está inválida. A lista de modelos do provider exclui
os modelos dessa credencial depois de recusa confirmada; configuração nova e
resultado positivo removem o veredito anterior. Rede sem resposta não o refuta.

A resolução usa a seleção de modelProviders/envKey, com ambiente do processo
antes do fallback env do perfil, e aceita os campos legados de autenticação.
A prioridade está documentada pelo próprio [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/#resolution-layers-and-atomicity).
O probe não tenta reimplementar alterações interativas de uma conversa ou
credenciais particulares de outro workspace. Endpoints fora da lista de hosts
revisada retornam desconhecido; o segredo não é enviado a um destino arbitrário.

Teste automatizado não lê chaves do ambiente real: os testes da sonda fixam as
variáveis de autenticação e QWEN_HOME antes de usar perfis temporários. Nenhuma
chave, login, configuração de provider ou preferência do operador foi alterada.
