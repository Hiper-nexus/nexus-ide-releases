// O que um filho do shell tool enxerga (a CLI executa `env` de verdade, via uma
// chamada de ferramenta servida pela SAFE). Mede o custo dos pinos no ambiente.
const dump = ({ workspace }) => ({
  toolName: 'run_shell_command',
  args: { command: `env | sort > "${workspace}/env-dump.txt"`, description: 'dump env' },
});

export const scenarios = [
  { id: 't01-child-env', group: 'child', expect: 'safe-key', approval: 'yolo', desc: 'env do filho com os pinos', toolCall: dump, collect: ['env-dump.txt'] },
  {
    id: 't02-child-env-operator-exports', group: 'child', expect: 'safe-key', approval: 'yolo',
    desc: 'o operador exportou OPENAI_*: os pinos não podem sobrescrever',
    envExtra: { OPENAI_API_KEY: 'OPERATOR-OWN-KEY', OPENAI_BASE_URL: 'https://operator.example/v1' },
    toolCall: dump, collect: ['env-dump.txt'],
  },
];
