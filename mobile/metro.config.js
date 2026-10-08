const fs = require('node:fs')
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')

const config = getDefaultConfig(projectRoot)

// Why: mobile source-control prompts use the same pure builders as desktop.
// Metro only watches mobile/ by default, so make repo-root shared modules visible.
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), sharedRoot]))

// Why: uma worktree pode apontar node_modules (do app e da raiz) por link para a
// instalação de outro checkout. O Metro resolve pelo caminho real, que fica fora
// de projectRoot; sem estar em watchFolders, ele falha ao calcular o SHA-1.
for (const modules of [
  path.join(projectRoot, 'node_modules'),
  path.resolve(projectRoot, '..', 'node_modules')
]) {
  try {
    const real = fs.realpathSync(modules)
    if (real !== modules) {
      config.watchFolders.push(real)
    }
  } catch {
    // Sem node_modules ali: nada a observar.
  }
}

module.exports = config
