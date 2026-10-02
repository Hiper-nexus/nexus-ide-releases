// Comparação honesta. Cada afirmação sobre um concorrente vem do que o PRÓPRIO concorrente publica no site dele, com o link da
// fonte; o que o site não informa aparece como "não informado" (nunca como "não tem"). Os dados dos outros mudam: confira a data.
// Valores do Nexus que mudam (preço, dias de teste) vêm da API ao vivo (data-live), nunca escritos aqui.
// Conferido em 02/10/2026 em https://overclock.sh/en e https://www.bridgemind.ai/.
const OVERCLOCK = 'https://overclock.sh/en';
const BRIDGEMIND = 'https://www.bridgemind.ai/';

export default {
  checkedAt: '2026-10-02',
  products: [
    { id: 'nexus', name: 'NexusIDE', url: 'https://nexuside.app/' },
    { id: 'overclock', name: 'Overclock', url: OVERCLOCK },
    { id: 'bridgemind', name: 'BridgeMind', url: BRIDGEMIND },
  ],
  rows: [
    {
      id: 'price',
      label: 'Preço',
      cells: {
        nexus: { text: 'Um plano Pro mensal, em reais:', live: 'price' },
        overclock: { text: 'Três planos por mês, em dólar: Boost US$ 19, Pro US$ 39 e Ultra US$ 79.', source: OVERCLOCK },
        bridgemind: { text: 'Três planos por mês, em dólar: Basic US$ 20, Pro US$ 50 e Ultra US$ 200; o anual sai 20% mais barato.', source: BRIDGEMIND },
      },
    },
    {
      id: 'trial',
      label: 'Teste e garantia',
      cells: {
        nexus: { text: 'Período de teste sem cartão, com duração de', live: 'trial' },
        overclock: { text: 'Garantia de reembolso de 7 dias para quem assina.', source: OVERCLOCK },
        bridgemind: { text: 'Garantia de reembolso de 7 dias, só na primeira compra do Pro.', source: BRIDGEMIND },
      },
    },
    {
      id: 'own-ai',
      label: 'Suas próprias assinaturas e chaves de IA',
      cells: {
        nexus: { text: 'Sim. Roda as CLIs que você já usa, com as suas contas e chaves.' },
        overclock: { text: 'Sim. Claude Code, Codex, Gemini, Antigravity, OpenRouter, DeepSeek, Ollama e LM Studio, entre outros.', source: OVERCLOCK },
        bridgemind: { text: 'Sim. A sua assinatura ou uma chave de API (Claude, ChatGPT com Codex, SuperGrok e outras).', source: BRIDGEMIND },
      },
    },
    {
      id: 'platforms',
      label: 'Sistemas',
      cells: {
        nexus: { text: 'macOS com Apple Silicon e Windows x64. Linux ainda não tem instalador publicado.' },
        overclock: { text: 'Mac, Windows e Linux, com atualização automática.', source: OVERCLOCK },
        bridgemind: { text: 'macOS 26 ou mais novo, Windows 10 e 11 (x64) e Linux (x86_64).', source: BRIDGEMIND },
      },
    },
    {
      id: 'multi-account',
      label: 'Várias contas da mesma CLI',
      cells: {
        nexus: { text: 'Sim. A conta ativa segue até a cota medida zerar, e aí o pane passa para a próxima, sem perder a conversa.' },
        overclock: { text: 'Não informado no site.', unstated: true },
        bridgemind: { text: 'Sim. Várias contas de Claude Code e Codex, com troca quando uma bate o limite e a conversa continua.', source: BRIDGEMIND },
      },
    },
    {
      id: 'voice',
      label: 'Voz',
      cells: {
        nexus: { text: 'Ditado que vira prompt pronto para o agente e o Jarvis, que executa ações no app por voz.' },
        overclock: { text: 'ClockVoice (push-to-talk, no plano Pro) e Jarvis, o app operado por voz (no Ultra).', source: OVERCLOCK },
        bridgemind: { text: 'BridgeVoice, voz para texto local (Parakeet ou Whisper) ou na nuvem, incluído no plano Pro.', source: BRIDGEMIND },
      },
    },
    {
      id: 'capture',
      label: 'Captura de tela e leitura de cotas',
      cells: {
        nexus: { text: 'Shot (captura e anotação) e Redline (cotas por conta) incluídos no Pro.' },
        overclock: { text: 'Overclock Shot e Redline fazem parte do plano Ultra.', source: OVERCLOCK },
        bridgemind: { text: 'Não informado no site.', unstated: true },
      },
    },
    {
      id: 'language',
      label: 'Idioma do site e do produto',
      cells: {
        nexus: { text: 'Português do Brasil em primeiro lugar.' },
        overclock: { text: 'Site em inglês e em português.', source: OVERCLOCK },
        bridgemind: { text: 'Site em inglês.', source: BRIDGEMIND },
      },
    },
    {
      id: 'benchmarks',
      label: 'Benchmarks publicados com fonte',
      cells: {
        nexus: { text: 'Sim: a página de Benchmarks traz os números dos fabricantes, cada um com a fonte e a data.', internal: '/benchmarks/' },
        overclock: { text: 'O site tem uma página "Bench maxing". Não avaliamos o conteúdo dela.', source: OVERCLOCK },
        bridgemind: { text: 'Não informado no site.', unstated: true },
      },
    },
  ],
  choices: [
    {
      product: 'nexus',
      when: [
        'Você quer tudo em português do Brasil e preço em reais.',
        'Você usa várias contas das CLIs e quer que o trabalho siga quando uma bate o limite.',
        'Você quer testar por dias sem cartão antes de decidir.',
        'Seu computador é um Mac com Apple Silicon ou um Windows x64.',
      ],
    },
    {
      product: 'overclock',
      when: [
        'Você precisa de Linux.',
        'Você quer squads e receitas prontas, com cursos e uma comunidade em torno do produto.',
        'Você quer operar o app por voz com o Jarvis, no plano Ultra.',
      ],
    },
    {
      product: 'bridgemind',
      when: [
        'Você precisa de Linux.',
        'Você quer ditado local (BridgeVoice) e o modo Thread, para ler as sessões como conversa.',
        'Você prefere um app em inglês, com plano anual e créditos para recursos medidos.',
      ],
    },
  ],
};
