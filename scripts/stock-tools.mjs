import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkStockModules as linkSdkModules } from './project-dependencies.mjs'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const workspaceRoot = resolve(projectRoot, 'workspace')
export const requiredStockCommit = 'b830ec950faba0a46dda564be3e2d854afed94f1'
export const supportedStockSources = Object.freeze({ '0.2.1-rc.5': requiredStockCommit })
// Retained runtime compatibility metadata. This public source build uses rc.5;
// rc.3 has not been retested for the public candidate.
export const supportedDshRange = '0.2.1-rc.3 || 0.2.1-rc.5'

export function getStockRoot() {
  return resolve(process.env.DSH_PROJECTS_STOCK_ROOT
    ?? resolve(projectRoot, '.vendor/deepseek-harness'))
}

export function getPluginDependenciesRoot() {
  return resolve(process.env.DSH_PROJECTS_PLUGIN_DEPS_ROOT
    ?? resolve(projectRoot, 'scripts/plugin-dependencies'))
}

export function stockIdentity(stock = getStockRoot()) {
  const manifest = JSON.parse(readFileSync(resolve(stock, 'package.json'), 'utf8'))
  const expectedCommit = supportedStockSources[manifest.version]
  if (!expectedCommit) throw new Error(`DSH build input version is ${manifest.version}; this source build requires 0.2.1-rc.5 (${requiredStockCommit}). See BUILDING.md.`)
  const commit = execFileSync('git', ['-C', stock, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== expectedCommit) throw new Error(`DSH source commit is ${commit}; ${manifest.version} requires ${expectedCommit}. See BUILDING.md.`)
  return { stock, version: manifest.version, commit }
}

// Resolve from the explicitly selected stock closure, never workspace's legacy
// node_modules. Node still uses its normal package exports and dependency graph.
export function stockModule(specifier, stock = getStockRoot()) {
  return createRequire(resolve(stock, 'package.json')).resolve(specifier)
}

export function stockTools(stock = getStockRoot()) {
  return Object.fromEntries(['tsdown', 'typescript', 'tsx', 'lightningcss'].map(name => {
    const entry = stockModule(name, stock)
    let directory = dirname(entry)
    while (true) {
      const manifest = resolve(directory, 'package.json')
      if (existsSync(manifest)) {
        const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
        if (metadata.name === name) return [name, { version: metadata.version, entry }]
      }
      const parent = dirname(directory)
      if (parent === directory) throw new Error(`Cannot locate stock tool metadata: ${name}`)
      directory = parent
    }
  }))
}

export function prepareStock(stock = getStockRoot()) {
  for (const file of ['package.json', 'packages/typert/generator/lib/index.js',
    'packages/core/session/lib/index.js', 'apps/cli/lib/bin.js']) {
    if (!existsSync(resolve(stock, file))) {
      throw new Error(`Missing built DSH input: ${resolve(stock, file)}. Prepare the pinned upstream checkout and set DSH_PROJECTS_STOCK_ROOT, or use .vendor/deepseek-harness. See BUILDING.md.`)
    }
  }
  return { ...stockIdentity(stock), tools: stockTools(stock) }
}

/** Preserve the public SDK default at this entry point. */
export function linkStockModules(target, stock = getStockRoot()) {
  return linkSdkModules(target, stock)
}
