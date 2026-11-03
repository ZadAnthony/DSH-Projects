import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPluginDependenciesRoot, getStockRoot, linkStockModules, prepareStock,
  projectRoot, stockIdentity, supportedDshRange, stockModule,
  workspaceRoot as workspace } from './stock-tools.mjs'

const stock = getStockRoot()
const buildRoot = resolve(process.env.DSH_PROJECTS_BUILD_ROOT ?? resolve(projectRoot, '.build'))

export async function runWorkspace(command, args = process.argv.slice(2)) {
  const planOnly = args.includes('--plan')
  args = args.filter(arg => arg !== '--plan')
  const manifest = JSON.parse(readFileSync(resolve(workspace, 'packages/projects/package.json'), 'utf8'))
  if (command === 'info') {
    console.log(JSON.stringify({ version: manifest.version, workspace, node: process.execPath,
      source: resolve(workspace, 'packages/projects/src/stock'), selectedSdk: stockIdentity(stock), supportedDshRange,
      pluginDependencies: getPluginDependenciesRoot(), buildRoot, delivery: resolve(projectRoot, 'README.md') }, null, 2))
    return
  }
  if (command === 'start') {
    console.log('Install the built .tgz through the normal DeepSeek Harness plugin manager. See README.md for installation and BUILDING.md for source builds.')
    return
  }
  const inputs = prepareStock(stock)
  if (command === 'prepare') {
    console.log(JSON.stringify(inputs, null, 2))
    return
  }
  const tests = {
    'test:records': 'records.test.ts',
    'test:prompts': 'agent-prompts.test.ts',
  }
  const operations = {
    build: ['scripts/build-stock-projects.mjs'],
    'build:stock': ['scripts/build-stock-projects.mjs'],
    'typecheck:host': ['scripts/build-stock-projects.mjs', '--typecheck-only'],
    'typecheck:client': ['scripts/build-stock-projects.mjs', '--typecheck-only'],
    package: ['scripts/build-stock-projects.mjs'],
    dsh: [resolve(stock, 'apps/cli/lib/bin.js')],
  }
  const testFile = tests[command]
  const argv = testFile
    ? [resolve(dirname(stockModule('tsx/package.json', stock)), 'dist/cli.mjs'), '--test', ...args, `tests/${testFile}`]
    : operations[command]?.concat(args)
  if (!argv) throw new Error(`Unknown development command: ${command}`)
  if (planOnly) {
    console.log(JSON.stringify({ command, executable: process.execPath, argv,
      cwd: testFile ? resolve(buildRoot, 'test-runs/<temporary>/package') : workspace,
      stock, tools: inputs.tools, pluginDependencies: getPluginDependenciesRoot(), buildRoot }, null, 2))
    return
  }
  let testRoot
  try {
    let cwd = workspace
    if (testFile) {
      const testsRoot = resolve(buildRoot, 'test-runs')
      await mkdir(testsRoot, { recursive: true })
      testRoot = await mkdtemp(resolve(testsRoot, 'run-'))
      cwd = resolve(testRoot, 'package')
      await mkdir(cwd)
      const source = resolve(workspace, 'packages/projects')
      for (const name of ['src', 'tests', 'prompts', 'package.json']) {
        await cp(resolve(source, name), resolve(cwd, name), { recursive: true })
      }
      await linkStockModules(cwd, stock)
    }
    const result = spawnSync(process.execPath, argv, { cwd, stdio: 'inherit',
      env: { ...process.env, DSH_PROJECTS_STOCK_ROOT: stock, DSH_PROJECTS_BUILD_ROOT: buildRoot,
        ...(testRoot ? { DSH_COMMUNICATION_RECORDS_TEST_ROOT: resolve(testRoot, 'records') } : {}) } })
    if (result.error) throw result.error
    if (result.signal) throw new Error(`Command ended with ${result.signal}`)
    process.exitCode = result.status ?? 1
  } finally {
    if (testRoot) await rm(testRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorkspace(process.argv[2] ?? 'info', process.argv.slice(3))
}
