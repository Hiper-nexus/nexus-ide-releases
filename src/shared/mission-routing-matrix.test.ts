/**
 * Matriz de roteamento: objetivos reais de vários tipos de sistema, cada um
 * com a EXPECTATIVA declarada. Violação é objetiva, não opinião.
 *
 * Nasceu de uma sonda de campo (23/08) que encontrou 17 defeitos em 89
 * objetivos — todos de PRECEDÊNCIA: um sinal fraco vencia uma recusa
 * explícita, um substantivo de investigação vencia um verbo de conserto, e
 * missão mista tinha metade proibida pela lane da outra metade.
 *
 * Propriedades checadas:
 *   escreve   — precisa alterar arquivos? Então a lane NUNCA pode ser
 *               `consult` (somente-leitura) nem `plan` (não abre workers).
 *   pergunta  — deve virar resposta direta, sem criar missão.
 *   design    — deve receber a doutrina de UI (DESIGN.md).
 *   seguranca — deve receber a doutrina de segurança.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyWorkKind,
  decideDesignAuthority,
  isUiMissionText,
} from './mission-work-kind';
import { suggestMissionLaneFromGoal } from './mission-intent';
import { isSecurityMissionText } from '../main/orch/mission-fast-lane';
import { looksLikePureQuestion } from '../main/orch/intent-router';

interface Caso {
  readonly dominio: string;
  readonly texto: string;
  readonly escreve?: boolean;
  readonly pergunta?: boolean;
  readonly design?: boolean;
  readonly seguranca?: boolean;
}

const CASOS: Caso[] = [
  // ── E-commerce ────────────────────────────────────────────────────────
  { dominio: 'ecommerce', texto: 'adicione carrinho de compras com cupom de desconto na loja', escreve: true },
  { dominio: 'ecommerce', texto: 'o frete esta calculando errado para o nordeste, arrume', escreve: true },
  { dominio: 'ecommerce', texto: 'monte a pagina de checkout com resumo do pedido e forma de pagamento', escreve: true, design: true },
  { dominio: 'ecommerce', texto: 'quanto custa manter uma loja online?', pergunta: true },

  // ── SaaS / dashboard ──────────────────────────────────────────────────
  { dominio: 'saas', texto: 'crie um painel com grafico de vendas por mes e filtro por vendedor', escreve: true, design: true },
  { dominio: 'saas', texto: 'implemente planos de assinatura mensal e anual com trial de 7 dias', escreve: true },
  { dominio: 'saas', texto: 'o dashboard esta lento quando tem muitos registros, melhore a performance', escreve: true },
  { dominio: 'saas', texto: 'analise o uso do sistema pelos clientes e me diga onde eles travam', escreve: false },

  // ── Auth / segurança ──────────────────────────────────────────────────
  { dominio: 'auth', texto: 'implemente login com google e recuperacao de senha por email', escreve: true },
  { dominio: 'auth', texto: 'faca uma auditoria de seguranca no login e corrija o que estiver vulneravel', escreve: true, seguranca: true },
  { dominio: 'auth', texto: 'proteja as rotas de admin para so administradores acessarem', escreve: true, seguranca: true },
  { dominio: 'auth', texto: 'tire as chaves de api que estao no codigo e coloque em variavel de ambiente', escreve: true, seguranca: true },
  { dominio: 'auth', texto: 'revise as permissoes de acesso, sem alterar nada, so me diga o que esta errado', escreve: false, seguranca: true },

  // ── Pagamentos ────────────────────────────────────────────────────────
  { dominio: 'pagamento', texto: 'integre pagamento por pix com confirmacao automatica', escreve: true },
  { dominio: 'pagamento', texto: 'o webhook do stripe esta duplicando cobranca, corrija', escreve: true },
  { dominio: 'pagamento', texto: 'planeje como migrar do pagseguro para o stripe, so o plano', escreve: false },

  // ── API / backend ─────────────────────────────────────────────────────
  { dominio: 'api', texto: 'crie uma api rest para cadastro de produtos com validacao', escreve: true },
  { dominio: 'api', texto: 'documente a api de pedidos com exemplos de requisicao', escreve: true },
  { dominio: 'api', texto: 'a api esta retornando 500 quando o campo cpf vem vazio, conserte', escreve: true },

  // ── Dados / relatorios ────────────────────────────────────────────────
  { dominio: 'dados', texto: 'crie um relatorio mensal de faturamento em pdf', escreve: true },
  { dominio: 'dados', texto: 'migre o banco de mysql para postgres sem perder dados', escreve: true },
  { dominio: 'dados', texto: 'investigue por que os numeros do relatorio nao batem com o caixa', escreve: false },

  // ── Mobile ────────────────────────────────────────────────────────────
  { dominio: 'mobile', texto: 'deixe o app responsivo e bonito no celular pequeno', escreve: true, design: true },
  { dominio: 'mobile', texto: 'adicione notificacao push quando o pedido sair para entrega', escreve: true },

  // ── Marketing / site ──────────────────────────────────────────────────
  { dominio: 'site', texto: 'crie uma landing page para minha barbearia com botao de agendar', escreve: true, design: true },
  { dominio: 'site', texto: 'publique o site e me diga o endereco', escreve: true },
  { dominio: 'site', texto: 'melhore o texto da pagina inicial para vender mais', escreve: true },

  // ── Infra / ops ───────────────────────────────────────────────────────
  { dominio: 'ops', texto: 'faca o deploy na vercel e configure o dominio proprio', escreve: true },
  { dominio: 'ops', texto: 'configure backup automatico do banco todo dia de madrugada', escreve: true },
  { dominio: 'ops', texto: 'o servidor caiu de madrugada, descubra o motivo', escreve: false },

  // ── Testes / qualidade ────────────────────────────────────────────────
  { dominio: 'qa', texto: 'escreva testes para o fluxo de cadastro e checkout', escreve: true },
  { dominio: 'qa', texto: 'os testes estao quebrando no ci, arrume', escreve: true },

  // ── Acessibilidade / i18n ─────────────────────────────────────────────
  { dominio: 'a11y', texto: 'deixe o site acessivel para leitor de tela e navegacao por teclado', escreve: true, design: true },
  { dominio: 'i18n', texto: 'traduza o sistema para espanhol e ingles', escreve: true },

  // ── Legado / refatoracao ──────────────────────────────────────────────
  { dominio: 'legado', texto: 'refatore o modulo de pedidos que esta impossivel de manter', escreve: true },
  { dominio: 'legado', texto: 'atualize as dependencias e conserte o que quebrar', escreve: true },

  // ── Missões MISTAS ────────────────────────────────────────────────────
  { dominio: 'mista', texto: 'construa um sistema de agendamento com pagamento e no final uma landing page bonita', escreve: true, design: true },
  { dominio: 'mista', texto: 'construa a area de login e faca uma auditoria de seguranca nela', escreve: true, seguranca: true },
  { dominio: 'mista', texto: 'planeje a arquitetura do modulo de relatorios e depois implemente', escreve: true },
  { dominio: 'mista', texto: 'documente a api e ja corrija os erros que encontrar na documentacao', escreve: true },
  { dominio: 'mista', texto: 'investigue o bug do carrinho e conserte assim que achar', escreve: true },

  // ── Perguntas puras (nao viram missao) ────────────────────────────────
  { dominio: 'pergunta', texto: 'o que e uma api?', pergunta: true },
  { dominio: 'pergunta', texto: 'vale a pena usar react ou vue?', pergunta: true },
  { dominio: 'pergunta', texto: 'quanto tempo leva para fazer um ecommerce?', pergunta: true },
  { dominio: 'pergunta', texto: 'preciso saber a diferenca entre banco relacional e nao relacional', pergunta: true },
  { dominio: 'pergunta', texto: 'como faco para publicar um site de graca', pergunta: true },
  // ── Fase 2: mais domínios e mais formas de falar ──────────────────────

  // CMS / conteúdo
  { dominio: 'cms', texto: 'crie um blog com listagem de posts e pagina de leitura', escreve: true, design: true },
  { dominio: 'cms', texto: 'adicione um editor de texto rico para o cliente escrever os posts', escreve: true },
  { dominio: 'cms', texto: 'o post nao salva quando tem imagem grande, conserte', escreve: true },

  // Chat / IA
  { dominio: 'ia', texto: 'adicione um chat com ia que responde duvidas dos clientes', escreve: true },
  { dominio: 'ia', texto: 'a ia esta respondendo besteira, revise o prompt e melhore', escreve: true },

  // Agenda / booking
  { dominio: 'agenda', texto: 'quero que o cliente escolha horario e receba confirmacao no whatsapp', escreve: true },
  { dominio: 'agenda', texto: 'bloqueie horarios que ja passaram e feriados', escreve: true },

  // Formulário / captura
  { dominio: 'form', texto: 'coloque um formulario de contato no rodape com validacao', escreve: true, design: true },
  { dominio: 'form', texto: 'os emails do formulario nao estao chegando, descubra e resolva', escreve: true },

  // Busca
  { dominio: 'busca', texto: 'adicione busca por nome e categoria na listagem de produtos', escreve: true },
  { dominio: 'busca', texto: 'a busca esta lenta com muitos produtos, otimize', escreve: true },

  // Performance
  { dominio: 'perf', texto: 'o site demora muito para abrir no celular, deixe mais rapido', escreve: true },
  { dominio: 'perf', texto: 'meça o tempo de carregamento e me diga onde esta o gargalo', escreve: false },

  // SEO / analytics
  { dominio: 'seo', texto: 'melhore o seo do site para aparecer melhor no google', escreve: true },
  { dominio: 'seo', texto: 'instale o google analytics e o pixel do facebook', escreve: true },

  // Design system
  { dominio: 'design', texto: 'padronize as cores e fontes do sistema inteiro', escreve: true, design: true },
  { dominio: 'design', texto: 'crie um tema escuro para o painel', escreve: true, design: true },
  { dominio: 'design', texto: 'os botoes estao com tamanhos diferentes em cada tela, unifique', escreve: true, design: true },

  // Segurança — mais formas
  { dominio: 'seguranca', texto: 'tire as senhas que estao escritas no codigo fonte', escreve: true, seguranca: true },
  { dominio: 'seguranca', texto: 'valide os dados que vem do formulario antes de gravar no banco', escreve: true, seguranca: true },
  { dominio: 'seguranca', texto: 'coloque https no site e force redirecionamento', escreve: true, seguranca: true },
  { dominio: 'seguranca', texto: 'me explique o que e sql injection', pergunta: true },

  // Investigação pura — mais formas
  { dominio: 'investiga', texto: 'sem alterar nada, me diga por que o pedido some do carrinho', escreve: false },
  { dominio: 'investiga', texto: 'so olhe o codigo e me diga se tem algo errado', escreve: false },
  { dominio: 'investiga', texto: 'descubra o motivo do erro 500 mas nao mexa em nada', escreve: false },
  { dominio: 'investiga', texto: 'mapeie como funciona o fluxo de pagamento hoje', escreve: false },

  // Planejamento — mais formas
  { dominio: 'plano', texto: 'escreva o prd do modulo de assinaturas', escreve: false },
  { dominio: 'plano', texto: 'me ajude a decidir entre monolito e microservicos, so a analise', escreve: false },

  // Mistas — mais combinações
  { dominio: 'mista', texto: 'analise o codigo e ja refatore o que estiver ruim', escreve: true },
  { dominio: 'mista', texto: 'faca o diagnostico da lentidao e otimize', escreve: true },
  { dominio: 'mista', texto: 'crie a api e o painel bonito para gerenciar os dados', escreve: true, design: true },
  { dominio: 'mista', texto: 'audite a seguranca, documente o que achar e conserte o critico', escreve: true, seguranca: true },
  { dominio: 'mista', texto: 'migre o banco e ajuste as telas que quebrarem', escreve: true },

  // Perguntas — mais formas de leigo
  { dominio: 'pergunta', texto: 'da para fazer isso sem programador?', pergunta: true },
  { dominio: 'pergunta', texto: 'me explique como funciona hospedagem de site', pergunta: true },
  { dominio: 'pergunta', texto: 'qual a diferenca entre dominio e hospedagem', pergunta: true },
  { dominio: 'pergunta', texto: 'para que serve um banco de dados', pergunta: true },
  { dominio: 'pergunta', texto: 'nao entendi o que e uma api rest', pergunta: true },
  { dominio: 'pergunta', texto: 'tem como integrar com o whatsapp?', pergunta: true },

  // Armadilhas: parecem pergunta mas são trabalho
  { dominio: 'armadilha', texto: 'crie uma pagina que explique para que serve o produto', escreve: true, design: true },
  { dominio: 'armadilha', texto: 'monte um faq com as duvidas mais comuns dos clientes', escreve: true },
  { dominio: 'armadilha', texto: 'tem como voce criar isso pra mim? quero um sistema de vendas completo', escreve: true },
  { dominio: 'armadilha', texto: 'adicione uma secao "vale a pena?" comparando os planos', escreve: true },
];

const SOMENTE_LEITURA = new Set(['consult', 'plan']);

describe('matriz de roteamento — 89 objetivos reais', () => {
  const escrevem = CASOS.filter((c) => c.escreve === true);
  const investigam = CASOS.filter((c) => c.escreve === false);
  const perguntas = CASOS.filter((c) => c.pergunta === true);
  const trabalhos = CASOS.filter((c) => c.pergunta !== true);
  const desenho = CASOS.filter((c) => c.design === true);
  const seguranca = CASOS.filter((c) => c.seguranca === true);

  it.each(escrevem.map((c) => [c.dominio, c.texto] as const))(
    'ESCREVE · %s · %s',
    (_dominio, texto) => {
      // Lane de leitura numa missão que precisa entregar = metade proibida.
      expect(SOMENTE_LEITURA.has(String(suggestMissionLaneFromGoal(texto)))).toBe(
        false,
      );
    },
  );

  it.each(investigam.map((c) => [c.dominio, c.texto] as const))(
    'INVESTIGA · %s · %s',
    (_dominio, texto) => {
      expect(SOMENTE_LEITURA.has(String(suggestMissionLaneFromGoal(texto)))).toBe(
        true,
      );
    },
  );

  it.each(perguntas.map((c) => [c.texto] as const))(
    'PERGUNTA (não vira missão) · %s',
    (texto) => {
      expect(looksLikePureQuestion(texto)).toBe(true);
    },
  );

  it.each(trabalhos.map((c) => [c.dominio, c.texto] as const))(
    'TRABALHO (não vira resposta) · %s · %s',
    (_dominio, texto) => {
      expect(looksLikePureQuestion(texto)).toBe(false);
    },
  );

  it.each(desenho.map((c) => [c.texto] as const))(
    'UI recebe DESIGN.md · %s',
    (texto) => {
      const temDoutrina =
        decideDesignAuthority(texto).required || isUiMissionText(texto);
      expect(temDoutrina).toBe(true);
    },
  );

  it.each(seguranca.map((c) => [c.texto] as const))(
    'SEGURANÇA recebe doutrina · %s',
    (texto) => {
      expect(isSecurityMissionText(texto)).toBe(true);
    },
  );

  it('a matriz cobre todos os eixos que o produto promete', () => {
    expect(CASOS.length).toBeGreaterThanOrEqual(85);
    expect(escrevem.length).toBeGreaterThanOrEqual(40);
    expect(investigam.length).toBeGreaterThanOrEqual(8);
    expect(perguntas.length).toBeGreaterThanOrEqual(10);
    expect(desenho.length).toBeGreaterThanOrEqual(10);
    expect(seguranca.length).toBeGreaterThanOrEqual(5);
    // Nenhum objetivo sem classificação: `unknown` com confiança alta seria
    // o classificador afirmando ignorância, que é pior que não afirmar nada.
    for (const caso of CASOS) {
      const v = classifyWorkKind(caso.texto);
      if (v.kind === 'unknown') expect(v.confidence).toBe('low');
    }
  });
});
