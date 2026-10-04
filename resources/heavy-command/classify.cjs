const { commandKind } = require('./catalog.cjs');
// Native tool wrappers may evaluate the user command from a positional arg.
// This is classification only; the original $0/$@ stay intact at execution.
process.stdout.write(commandKind(process.argv.slice(2).join('\n')) || '');
