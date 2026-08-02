import { describe, expect, it } from "vitest";
import { classifyStandardMissionTopology } from "./mission-topology";

describe("classifyStandardMissionTopology", () => {
  it.each([
    "teste de todos panes cada um me fala oque ele faz na missao",
    "Quero que cada agente diga qual é seu papel nesta missão",
    "Peça para toda a equipe analisar o contexto em paralelo, sem editar, e responder",
    "Have each pane explain its role in this mission",
    "Ask all agents to inspect the context read-only and report their findings",
    "Cada especialista, somente leitura, apresente sua perspectiva e seus riscos",
    "Cada agente diga qual é seu papel neste projeto",
    "Todos os panes me falem o que fazem no sistema",
    "Quero que cada especialista explique sua função no app",
    "Have each agent explain its role in the project",
    "Cada agente diga seu papel neste projeto, por favor",
    "Quero ouvir cada especialista explicar sua função dentro do app",
    "Todos os panes me falem o que fazem atualmente no sistema",
    "Cada agente, sem alterar arquivos, analise o código e apresente riscos",
    "Each agent, do not edit, inspect the code and report findings",
    "teste nexus. quero ver como. se sai com. topdos panes rodando analisando soltando",
  ])("selects a read-only team fan-out for %j", (goal) => {
    expect(classifyStandardMissionTopology(goal)).toBe(
      "team-read-only-fanout",
    );
  });

  it.each([
    "Implemente o login com revisão e QA",
    "Todos os agentes implementem uma parte da feature",
    "Cada pane me fale sua função e depois corrija o bug",
    "Ask every agent to update one file and commit the result",
    "Adicione na tela o status de todos os agentes",
    "Construa um dashboard com o papel de cada agente",
    "Mostre o status de todos os agentes no painel",
    "Faça um dashboard onde cada agente explica seu papel",
    "Quero uma tela que mostre o status de todos os agentes",
    "Todos os agentes revisem e melhorem o código",
    "Todos os panes analisem e resolvam os problemas",
    "Todos os agentes revisem o projeto, façam as mudanças e entreguem",
    "Todos os agentes revisem e corrijam os bugs",
    "Todos os agentes analisem e arrumem o app",
    "Cada especialista revise e solucione os problemas",
    "Toda a equipe inspecione e repare o código",
    "Todos os panes revisem e ajustem o projeto",
    "Cada agente analise e faça o necessário no código",
    "Todos os agentes revisem, corrijam os bugs e me digam o resultado",
    "Todos os agentes analisem, arrumem o app e relatem o que fizeram",
    "Todos os panes ajustem o projeto e respondam quando terminar",
    "Cada agente faça o necessário no código e me fale o resultado",
    "Todos os agentes atualizem o código e me digam sua análise",
    "Toda a equipe reorganize os arquivos e apresente os achados",
    "Todos os panes integrem a API e respondam com sua análise",
    "Todos os agentes instalem as dependências e me falem o diagnóstico",
    "Cada especialista migre o banco e descreva suas recomendações",
    "Cada agente explique seu papel no projeto e altere o código",
    "Todos os panes digam o que fazem no app e corrijam os bugs",
    "Have each agent explain its role in the project and update a file",
    "Cada agente explique sua função no app e analise o código",
    "Cada agente explique seu papel no projeto e remova a autenticação",
    "Cada agente diga sua função no app e atualize a documentação",
    "Have each agent explain its role in the project and delete the tests",
    "Todos os panes me falem o que fazem no sistema e rodem as migrações",
    "Cada agente explique seu papel no repositório e faça push na main",
    "Todos os agentes digam sua função no app e instalem o pacote novo",
    "Cada agente remova a autenticação antes de explicar seu papel",
    "Cada agente, sem editar, explique seu papel e remova a autenticação",
    "Todos os agentes, somente leitura, atualizem a documentação e relatem sua análise",
    "Each agent, read-only, explain its role and delete the tests",
    "Cada especialista, sem escrever, rode as migrações e apresente o diagnóstico",
    "Cada agente sem editar faça push na main e descreva seu papel",
    "Each agent, do not edit, change the code and report findings",
    "Teste o Nexus com todos os panes analisando e corrija os bugs",
    "Organizar a semana do time de produto",
  ])("keeps delivery topology for mutating or ambiguous goal %j", (goal) => {
    expect(classifyStandardMissionTopology(goal)).toBe("delivery");
  });
});
