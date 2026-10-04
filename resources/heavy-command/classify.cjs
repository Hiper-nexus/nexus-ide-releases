const { commandKind } = require('./catalog.cjs');
process.stdout.write(commandKind(process.argv[2] || '') || '');
