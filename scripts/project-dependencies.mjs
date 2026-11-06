import { globSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The lock belongs to this source checkout; pluginRoot may reuse an installed
// dependency store, but cannot replace the checkout's declared build inputs.
const lockRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'plugin-dependencies')

/** Link normal built SDK packages into an isolated build/test package. */
export async function linkStockModules(target, stock) {
  const modules = resolve(target, 'node_modules')
  await rm(modules, { recursive: true, force: true })
  await mkdir(modules, { recursive: true })
  for (const name of await readdir(resolve(stock, 'node_modules'))) {
    // Keep package-manager metadata and writable namespace directories local.
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      await mkdir(resolve(modules, name), { recursive: true })
      for (const child of await readdir(resolve(stock, 'node_modules', name))) {
        await symlink(resolve(stock, 'node_modules', name, child), resolve(modules, name, child))
      }
    } else await symlink(resolve(stock, 'node_modules', name), resolve(modules, name))
  }
  const nativePackages = new Map()
  for (const input of globSync(['packages/*/*/package.json', 'vendor/*/package.json',
    'native/*/packages/*/package.json', 'apps/*/package.json'], { cwd: stock })) {
    const directory = dirname(resolve(stock, input))
    const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    if (!metadata.name?.startsWith('@deepseek-ai/')) continue
    if (nativePackages.has(metadata.name)) throw new Error(`Duplicate native package: ${metadata.name}`)
    nativePackages.set(metadata.name, { directory, metadata })
    const link = resolve(modules, metadata.name)
    await mkdir(dirname(link), { recursive: true })
    await rm(link, { recursive: true, force: true })
    await symlink(directory, link, 'dir')
  }
  return nativePackages
}

/** Select exact locked versions, preferring same-version SDK package identity. */
export function projectDependencyInputs(original, stock, pluginRoot) {
  const dependencies = { ...original.dependencies }
  const bundledDependencies = { ...original.devDependencies }
  for (const name of Object.keys(bundledDependencies)) delete dependencies[name]
  const manifest = JSON.parse(readFileSync(resolve(lockRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(lockRoot, 'package-lock.json'), 'utf8'))
  const chat = JSON.parse(readFileSync(resolve(stock, 'packages/client/ui-chat/package.json'), 'utf8'))
  const virtualRange = chat.dependencies?.['@tanstack/react-virtual'] ?? chat.devDependencies?.['@tanstack/react-virtual']
  if (virtualRange === undefined) throw new Error('The stock Chat manifest does not declare its virtual list library')
  const semver = createRequire(resolve(stock, 'packages/boot/app-boot/package.json'))('semver')
  const pnpmRoot = resolve(stock, 'node_modules/.pnpm')
  const cachedPackages = readdirSync(pnpmRoot)
  const dependencyInputs = new Map()
  for (const [name, range] of Object.entries({ ...dependencies, ...bundledDependencies })) {
    let directory = resolve(pluginRoot, 'node_modules', name)
    let metadata
    try {
      metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw new Error(`Missing build dependency ${name}. Run npm run deps:install.`)
    }
    const pinned = manifest.dependencies[name]
    const locked = lock.packages?.['node_modules/' + name]?.version
    if (metadata.name !== name || locked !== pinned || metadata.version !== pinned || !semver.satisfies(metadata.version, range)) {
      throw new Error(`Build dependency ${name}@${metadata.version} does not match lock ${pinned} / package range ${range}. Run npm run deps:install.`)
    }
    if (name === '@tanstack/react-virtual' && !semver.satisfies(metadata.version, virtualRange)) {
      throw new Error(`Build dependency ${name}@${metadata.version} does not match SDK Chat ${virtualRange}`)
    }
    const prefix = name.replaceAll('/', '+') + '@'
    for (const key of cachedPackages.filter(key => key.startsWith(prefix)).sort()) {
      const candidate = resolve(pnpmRoot, key, 'node_modules', name)
      try {
        const value = JSON.parse(readFileSync(resolve(candidate, 'package.json'), 'utf8'))
        if (value.name === name && value.version === pinned) { directory = candidate; break }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    dependencyInputs.set(name, { directory, version: metadata.version })
    if (name in dependencies) dependencies[name] = metadata.version
  }
  return { dependencies, bundledDependencies, dependencyInputs }
}

/** Overlay selected dependencies, then the renderer's physical React closure. */
export async function linkProjectDependencies(target, stock, dependencyInputs) {
  const modules = resolve(target, 'node_modules')
  const link = async (name, directory) => {
    const path = resolve(modules, name)
    await mkdir(dirname(path), { recursive: true })
    await rm(path, { recursive: true, force: true })
    await symlink(directory, path, 'dir')
  }
  for (const [name, { directory }] of dependencyInputs) await link(name, directory)
  const renderer = createRequire(resolve(stock, 'packages/client/ui-renderer/package.json'))
  for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom']) {
    await link(name, dirname(renderer.resolve(name + '/package.json')))
  }
}
