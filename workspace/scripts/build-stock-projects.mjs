/** Build Projects against an independently built, unmodified DSH.
 * This creates a normal plugin tgz. It never patches or packages the host.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getPluginDependenciesRoot, getStockRoot, linkStockModules, prepareStock, stockModule, supportedDshRange } from '../../scripts/stock-tools.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = dirname(workspace)
// Package prompts are canonical; reject an unsynchronized runtime projection.
execFileSync(process.execPath, [resolve(repository, 'scripts/sync-agent-prompts.mjs'), '--check'], { stdio: 'inherit' })
const original = JSON.parse(await readFile(resolve(workspace, 'packages/projects/package.json'), 'utf8'))
const stock = getStockRoot()
const stockInputs = prepareStock(stock)
const { build } = await import(pathToFileURL(stockModule('tsdown', stock)).href)
const outputRoot = resolve(process.env.DSH_PROJECTS_BUILD_ROOT
  ?? resolve(repository, '.build'))
const checkOnly = process.argv.includes('--typecheck-only')
// A type check emits declarations and the generated Remote contract. Keep that
// scratch package separate from the last usable build, including with an
// explicit output root, and remove it after success or failure.
await mkdir(outputRoot, { recursive: true })
const buildRoot = checkOnly ? await mkdtemp(resolve(outputRoot, 'typecheck-')) : outputRoot
try {
const project = resolve(buildRoot, 'package')
const generated = resolve(project, 'lib')
const version = process.env.DSH_PROJECTS_STOCK_VERSION ?? original.version
const stockCommit = stockInputs.commit
const { WorkspaceAnalyzer, FaceModelEmitter } = await import(pathToFileURL(resolve(stock, 'packages/typert/generator/lib/index.js')).href)
const { PLATFORM_MODULES } = await import(pathToFileURL(resolve(stock, 'packages/client/web/lib/types/platform.js')).href)
const ts = (await import(pathToFileURL(resolve(stock, 'node_modules/typescript/lib/typescript.js')).href)).default
const requireStock = createRequire(resolve(stock, 'packages/boot/app-boot/package.json'))
const semver = requireStock('semver')
const { transform: transformCss } = createRequire(resolve(stock, 'package.json'))('lightningcss')

const requested = [
  '@deepseek-ai/cordis', 'react', 'react-dom', 'react-dom/client',
  '@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-client-connection/client', '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-session/client', '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-chat/client', '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-tool/client',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-input-trigger/client', '@deepseek-ai/dsh-client-ui-commands/client',
  '@deepseek-ai/dsh-client-ui-reference/client', '@deepseek-ai/dsh-client-ui-model-selection/client',
  '@deepseek-ai/dsh-client-ui-approval/client', '@deepseek-ai/dsh-client-ui-user-questions/client',
  '@deepseek-ai/dsh-client-ui-plan/client', '@deepseek-ai/dsh-client-resources/client',
  '@deepseek-ai/dsh-client-ui-workflow-run/client', '@deepseek-ai/dsh-client-ui-subagent/client',
  '@deepseek-ai/dsh-client-ui-skill/client', '@deepseek-ai/dsh-api-job-controller/client',
  '@deepseek-ai/dsh-client-ui-jobs/client', '@deepseek-ai/dsh-client-ui-attachment/client',
]
const external = [...new Set([...PLATFORM_MODULES, ...requested])]
const inlineNativeWire = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$|@deepseek-ai\/dsh-spill-policy\/notice$)/
// Published keyboard binding/configuration folds have no cross-plugin service
// identity. The private registry imports these functions, not a root registry.
const inlineNativeProtocol = ['@deepseek-ai/dsh-client-shortcuts/protocol']

await mkdir(project, { recursive: true })
await rm(resolve(project, 'src'), { recursive: true, force: true })
await rm(generated, { recursive: true, force: true })
await cp(resolve(workspace, 'packages/projects/src'), resolve(project, 'src'), { recursive: true })
const nativePackages = await linkStockModules(project, stock)
// pnpm keeps this normal dependency at its consuming package, not root.
const stockRequire = createRequire(resolve(stock, 'packages/core/agent-loop/package.json'))
await rm(resolve(project, 'node_modules/zod'), { recursive: true, force: true })
await symlink(dirname(stockRequire.resolve('zod/package.json')), resolve(project, 'node_modules/zod'), 'dir')
const dependencies = { ...original.dependencies }
// Google remains bundled rather than an installed plugin dependency. All
// ordinary versions are pinned by the independent public lockfile. Same-version
// SDK copies take precedence so native/plugin types retain one identity.
const bundledDependencies = { ...original.devDependencies }
for (const name of Object.keys(bundledDependencies)) delete dependencies[name]
const dependencyInputs = new Map()
const nativeChatManifest = JSON.parse(await readFile(resolve(stock, 'packages/client/ui-chat/package.json'), 'utf8'))
const virtualRange = nativeChatManifest.dependencies?.['@tanstack/react-virtual']
  ?? nativeChatManifest.devDependencies?.['@tanstack/react-virtual']
if (virtualRange === undefined) throw new Error('The stock Chat manifest does not declare its virtual list library')
const pluginDependenciesRoot = getPluginDependenciesRoot()
const publicDependencyManifest = JSON.parse(await readFile(resolve(repository, 'scripts/plugin-dependencies/package.json'), 'utf8'))
const publicDependencyLock = JSON.parse(await readFile(resolve(repository, 'scripts/plugin-dependencies/package-lock.json'), 'utf8'))
const pnpmRoot = resolve(stock, 'node_modules/.pnpm')
const cachedPackages = await readdir(pnpmRoot)
for (const [name, range] of Object.entries({ ...dependencies, ...bundledDependencies })) {
  let directory = resolve(pluginDependenciesRoot, 'node_modules', name)
  let metadata
  try {
    metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(`Missing public build dependency ${name}. Run npm run deps:install; see BUILDING.md.`)
  }
  const pinned = publicDependencyManifest.dependencies[name]
  const locked = publicDependencyLock.packages?.['node_modules/' + name]?.version
  if (locked !== pinned || metadata.version !== pinned || !semver.satisfies(metadata.version, range)) {
    throw new Error(`Build dependency ${name}@${metadata.version} does not match public pin ${pinned} / package range ${range}. Run npm run deps:install.`)
  }
  if (name === '@tanstack/react-virtual' && !semver.satisfies(metadata.version, virtualRange)) {
    throw new Error(`Build dependency ${name}@${metadata.version} does not match the SDK Chat range ${virtualRange}`)
  }
  // Restore the stock builder's preference for a shared SDK dependency, but
  // only at the exact public pin: never select a different cached version.
  // In particular, native input-shell declarations and the private editor must
  // resolve lexical / @lexical classes from the same physical package closure.
  const prefix = name.replaceAll('/', '+') + '@'
  for (const key of cachedPackages.filter(key => key.startsWith(prefix)).sort()) {
    const candidate = resolve(pnpmRoot, key, 'node_modules', name)
    try {
      const value = JSON.parse(await readFile(resolve(candidate, 'package.json'), 'utf8'))
      if (value.name === name && value.version === pinned) { directory = candidate; break }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  dependencyInputs.set(name, { directory, version: metadata.version })
  if (name in dependencies) dependencies[name] = metadata.version
  const link = resolve(project, 'node_modules', name)
  await mkdir(dirname(link), { recursive: true })
  await rm(link, { recursive: true, force: true })
  await symlink(directory, link, 'dir')
}
const rendererRequire = createRequire(resolve(stock, 'packages/client/ui-renderer/package.json'))
for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom']) {
  const directory = dirname(rendererRequire.resolve(name + '/package.json'))
  const link = resolve(project, 'node_modules', name)
  await mkdir(dirname(link), { recursive: true })
  await rm(link, { recursive: true, force: true })
  await symlink(directory, link, 'dir')
}
const peers = { ...original.peerDependencies }
const nativePeerRange = (name, version) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  ? supportedDshRange : version
for (const [name, range] of Object.entries(peers)) peers[name] = nativePeerRange(name, range)
const required = [
  '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/node-addon-system', '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-deepseek-account',
  '@deepseek-ai/dsh-client-shortcuts',
]
for (const name of required) {
  const manifest = nativePackages.get(name)?.metadata
    ?? JSON.parse(await readFile(resolve(stock, 'node_modules', name, 'package.json'), 'utf8'))
  peers[name] = nativePeerRange(name, manifest.version)
}
const manifest = {
  name: '@local/dsh-projects', version, private: true, type: 'module',
  description: original.description, author: original.author, license: original.license,
  engines: { dsh: supportedDshRange },
  main: './lib/index.js', types: './lib/types/stock/index.d.ts',
  exports: {
    '.': { types: './lib/types/stock/index.d.ts', default: './lib/index.js' },
    './types': { types: './lib/types/public-types.d.ts', default: './lib/types/public-types.js' },
    './stock/types': { types: './lib/types/stock/types.d.ts', default: './lib/types/stock/types.js' },
    './client': './lib/client.js',
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
    './package.json': './package.json',
  },
  files: ['lib', 'cordis.patch.yml', 'NOTICE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web', immediately: true, external: requested,
      inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
    },
  },
  peerDependencies: peers, dependencies,
}
await writeFile(resolve(project, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(resolve(project, 'cordis.patch.yml'), "- insert:\n    - id: dsh-projects\n      name: '@local/dsh-projects'\n      config:\n        dataRoot: !!js dshHomePath('projects-stock')\n")
await cp(resolve(repository, 'LICENSE'), resolve(project, 'LICENSE'))
await cp(resolve(repository, 'THIRD_PARTY_NOTICES.md'), resolve(project, 'THIRD_PARTY_NOTICES.md'))
const originalNotice = await readFile(resolve(workspace, 'packages/projects/NOTICE.md'), 'utf8')
await writeFile(resolve(project, 'NOTICE.md'), originalNotice
  + `\nPublic build ${version} uses DeepSeek Harness ${stockInputs.version} (${stockCommit}). The rc.3 target named above is historical; retained runtime compatibility metadata is ${supportedDshRange}. This public candidate has not been retested on rc.3. Original upstream grants and source records remain under lib/notices.\n`)
const hostConfig = {
  compilerOptions: {
    target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: true, composite: true, declaration: true, declarationMap: true,
    rootDir: 'src', outDir: 'lib/types', rewriteRelativeImportExtensions: true,
    types: ['node'], lib: ['ES2024'],
  }, files: ['src/stock/index.ts', 'src/stock/types.ts'],
}
// A composite project must explicitly list its transitive local sources. Derive
// that real closure from the entry; including all legacy files would compile
// the retired custom-host entry as part of the new stock plugin.
const parsedHost = ts.parseJsonConfigFileContent(hostConfig, ts.sys, project)
const hostProgram = ts.createProgram(parsedHost.fileNames, parsedHost.options)
// Every actual native import, including published type subpaths, is a declared
// peer of the plugin. No same-name native implementation is bundled.
for (const source of hostProgram.getSourceFiles().filter(file => file.fileName.startsWith(resolve(project, 'src') + '/'))) {
  const visit = node => {
    if (ts.isStringLiteral(node) && node.text.startsWith('@deepseek-ai/')) {
      const name = node.text.split('/').slice(0, 2).join('/')
      if (!(name in peers)) {
        const metadata = ts.sys.readFile(resolve(project, 'node_modules', name, 'package.json'))
        if (metadata) peers[name] = nativePeerRange(name, JSON.parse(metadata).version)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
await writeFile(resolve(project, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
hostConfig.files = hostProgram.getSourceFiles().filter(file => file.fileName.startsWith(resolve(project, 'src') + '/'))
  .map(file => relative(project, file.fileName))
await writeFile(resolve(project, 'tsconfig.host.json'), JSON.stringify(hostConfig, null, 2))
const tsc = resolve(stock, 'node_modules/typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', resolve(project, 'tsconfig.host.json')], { cwd: project, stdio: 'inherit' })
const sdkSource = resolve(project, 'src/stock/model/provider-sdk')
const sdkEmissionRewrites = []
if (ts.sys.directoryExists(sdkSource)) {
  const sdkOutput = resolve(generated, 'types/stock/model/provider-sdk')
  await cp(sdkSource, sdkOutput, { recursive: true })
  // The copied SDK is already JS; tsc does not visit it. Apply the same normal
  // relative-extension emit rule to its few typed local accounting imports.
  // Source hashes stay bound to the original private source, not emitted JS.
  async function emitSdk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, item.name)
      if (item.isDirectory()) await emitSdk(file)
      else if (item.name.endsWith('.js')) {
        const source = await readFile(file, 'utf8')
        if (!/(?:from\s*|import\s*\()\s*["']\.\.?\/[^"']*\.ts["']/.test(source)) continue
        const result = ts.transpileModule(source, { fileName: file, compilerOptions: {
          target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
          allowJs: true, rewriteRelativeImportExtensions: true,
        } })
        await writeFile(file, result.outputText)
        sdkEmissionRewrites.push(relative(project, file))
      }
    }
  }
  await emitSdk(sdkOutput)
}

// Use the unmodified official generator and its normal package/project model.
// The temporary package is solely a build input and is removed after generation.
const projected = await mkdtemp(resolve(stock, 'packages/.projects-stock-build-'))
try {
  await cp(resolve(project, 'src'), resolve(projected, 'src'), { recursive: true })
  await cp(resolve(project, 'package.json'), resolve(projected, 'package.json'))
  await cp(resolve(project, 'tsconfig.host.json'), resolve(projected, 'tsconfig.host.json'))
  await symlink(resolve(project, 'node_modules'), resolve(projected, 'node_modules'), 'dir')
  const parsed = ts.readConfigFile(resolve(stock, 'tsconfig.host.json'), ts.sys.readFile)
  if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
  const aggregatePath = resolve(buildRoot, 'aggregate.host.json')
  await writeFile(aggregatePath, JSON.stringify({
    extends: resolve(stock, 'tsconfig.host.json'), files: [],
    references: [...(parsed.config.references ?? []).map(item => ({ ...item, path: resolve(stock, item.path) })),
      { path: resolve(projected, 'tsconfig.host.json') }],
  }))
  const model = new WorkspaceAnalyzer({ root: stock, hostConfig: aggregatePath,
    packages: ['@local/dsh-projects'], faces: ['host'] }).analyze()
  const face = model.faces.find(value => value.face === 'host')
  if (!face) throw new Error('Projects stock Host is absent from the native Typert model')
  const artifact = new FaceModelEmitter(face).emit('@local/dsh-projects')
  if (!artifact?.remote) throw new Error('Projects stock Host did not generate a native Remote contract')
  await mkdir(generated, { recursive: true })
  for (const [file, value] of Object.entries({
    'typert.host.js': artifact.js, 'typert.host.d.ts': artifact.dts,
    'typert.remote-client.js': artifact.remote.js, 'typert.remote-client.d.ts': artifact.remote.dts,
    'typert.remote-client.d.ts.map': artifact.remote.dtsMap,
  })) await writeFile(resolve(generated, file), value)
} finally { await rm(projected, { recursive: true, force: true }) }

const clientConfig = {
  compilerOptions: {
    target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    skipLibCheck: true, jsx: 'react-jsx', allowImportingTsExtensions: true, noEmit: true,
    types: ['react', 'react-dom'], lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
  },
  include: ['src/stock/client/**/*.ts', 'src/stock/client/**/*.tsx'],
}
await writeFile(resolve(project, 'tsconfig.client.json'), JSON.stringify(clientConfig, null, 2))
execFileSync(process.execPath, [tsc, '-p', resolve(project, 'tsconfig.client.json')], { cwd: project, stdio: 'inherit' })
if (checkOnly) {
  console.log('Stock Host declarations, official Remote and complete Client types passed.')
} else {

// All emitted entry points (including the copied lazy provider SDK) share this
// complete Node runtime. Bundle its transitive code too; never borrow another
// plugin's private Google installation. The SDK's tokenizer/protobuf entry is
// not imported by the Google/Vertex adapters and is not an installation input.
const googleRuntime = resolve(generated, 'vendor/google-genai.js')
const googleRewrites = []
const googleTypeExports = new Set()
async function rewriteGoogleImports(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, item.name)
    if (item.isDirectory()) { await rewriteGoogleImports(file); continue }
    if (!item.name.endsWith('.js') && !item.name.endsWith('.d.ts')) continue
    const source = await readFile(file, 'utf8')
    if (!source.includes('@google/genai')) continue
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const replacements = []
    const visit = node => {
      if (ts.isStringLiteral(node) && node.text === '@google/genai') {
        if (item.name.endsWith('.d.ts')) {
          const bindings = node.parent.importClause?.namedBindings
          if (!bindings || !ts.isNamedImports(bindings)) throw new Error(`Unsupported Google declaration import: ${file}`)
          for (const binding of bindings.elements) googleTypeExports.add((binding.propertyName ?? binding.name).text)
        }
        let specifier = relative(dirname(file), googleRuntime).replaceAll('\\', '/')
        if (!specifier.startsWith('.')) specifier = './' + specifier
        replacements.push({ start: node.getStart(parsed) + 1, end: node.end - 1, specifier })
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    let output = source
    for (const change of replacements.reverse()) output = output.slice(0, change.start) + change.specifier + output.slice(change.end)
    if (output !== source) {
      await writeFile(file, output)
      googleRewrites.push(relative(project, file))
    }
  }
}
await rewriteGoogleImports(generated)
const googleModules = new Set()
const collectGoogleInputs = {
  name: 'projects-google-bundle-inputs',
  generateBundle(_options, bundle) {
    for (const id of this.getModuleIds()) if (isAbsolute(id) && id.includes('/node_modules/')) googleModules.add(id)
    for (const value of Object.values(bundle)) {
      if (value.type !== 'chunk' || value.fileName.endsWith('.d.ts')) continue
      for (const id of [...value.imports, ...value.dynamicImports]) {
        if (!(id in bundle) && !id.startsWith('.') && !isBuiltin(id)) throw new Error(`Unbundled Google runtime dependency: ${id}`)
      }
    }
  },
}
const googleDirectory = dependencyInputs.get('@google/genai').directory
const googleMetadata = JSON.parse(await readFile(resolve(googleDirectory, 'package.json'), 'utf8'))
const googleNodeEntry = googleMetadata.exports?.['.']?.node?.import
if (typeof googleNodeEntry !== 'string') throw new Error('Google GenAI has no declared Node ESM entry')
await build({ config: false, cwd: project, entry: { 'google-genai': resolve(googleDirectory, googleNodeEntry) },
  outDir: dirname(googleRuntime), format: 'esm', platform: 'node', target: 'es2024',
  dts: false, clean: false, fixedExtension: false,
  deps: { alwaysBundle: () => true }, plugins: [collectGoogleInputs],
})
// Preserve the exact upstream declarations reachable from the plugin's Google
// type imports. Declaration tree shaking removes unrelated optional MCP types;
// no hand-written replacement types or external Google packages are needed.
const googleTypeEntry = resolve(project, '.google-genai-types.ts')
const googleNodeTypes = googleMetadata.exports?.['.']?.node?.types
if (typeof googleNodeTypes !== 'string') throw new Error('Google GenAI has no declared Node types entry')
await writeFile(googleTypeEntry, `export { ${[...googleTypeExports].sort().join(', ')} } from ${JSON.stringify(resolve(googleDirectory, googleNodeTypes))};\n`)
try {
  await build({ config: false, cwd: project, entry: { 'google-genai': googleTypeEntry },
    outDir: dirname(googleRuntime), format: 'esm', platform: 'node', target: 'es2024',
    dts: { emitDtsOnly: true, tsconfig: false }, clean: false, fixedExtension: false,
    deps: { alwaysBundle: () => true }, plugins: [collectGoogleInputs],
  })
} finally { await rm(googleTypeEntry, { force: true }) }
const googleDeclarations = await readFile(googleRuntime.replace(/\.js$/, '.d.ts'), 'utf8')
for (const { fileName } of ts.preProcessFile(googleDeclarations).importedFiles) {
  if (!isBuiltin(fileName)) throw new Error(`Unbundled Google declaration dependency: ${fileName}`)
}
// Record rendered package inputs, including rescope vendor libraries whose
// real paths are outside node_modules. External or tree-shaken modules do not
// contribute code and do not cause unrelated package trees to be copied.
function collectBundledInputs(name, modules) {
  return {
    name,
    generateBundle(_options, bundle) {
      for (const value of Object.values(bundle)) {
        if (value.type !== 'chunk') continue
        for (const [id, rendered] of Object.entries(value.modules)) {
          if (rendered.renderedLength === 0 || !isAbsolute(id)) continue
          if (id.includes('/node_modules/') || id.startsWith(resolve(stock, 'vendor') + '/')) modules.add(id)
        }
      }
    },
  }
}
async function writeBundledNotices(modules, noticeDirectory, details = {}) {
  const packages = new Map()
  for (const id of modules) {
    let directory = dirname(id)
    while (directory !== dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
        if (metadata.name) { packages.set(directory, metadata); break }
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
      directory = dirname(directory)
    }
  }
  const bundled = []
  for (const [directory, metadata] of [...packages].sort((left, right) => left[1].name.localeCompare(right[1].name))) {
    const noticeRoot = resolve(generated, noticeDirectory, `${metadata.name.replaceAll('/', '+')}@${metadata.version}`)
    await mkdir(noticeRoot, { recursive: true })
    const packageFiles = await readdir(directory, { withFileTypes: true })
    const notices = packageFiles
      .filter(item => item.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:[.-].*)?$/i.test(item.name))
      .map(item => item.name)
    // data-uri-to-buffer 4.x ships its complete MIT grant and copyright in
    // README.md rather than a LICENSE file. Preserve that original text too.
    if (!notices.length && metadata.license === 'MIT') {
      for (const item of packageFiles.filter(item => item.isFile() && /^readme(?:[.-].*)?$/i.test(item.name))) {
        const text = await readFile(resolve(directory, item.name), 'utf8')
        if (/Copyright/i.test(text) && text.includes('Permission is hereby granted')) notices.push(item.name)
      }
    }
    if (!notices.length) throw new Error(`Bundled dependency has no license file: ${metadata.name}@${metadata.version}`)
    for (const file of notices) await cp(resolve(directory, file), resolve(noticeRoot, file))
    await writeFile(resolve(noticeRoot, 'UPSTREAM-PACKAGE.json'), JSON.stringify(metadata, null, 2) + '\n')
    bundled.push({ name: metadata.name, version: metadata.version, license: metadata.license,
      notices: notices.map(file => relative(project, resolve(noticeRoot, file))) })
  }
  await mkdir(resolve(generated, noticeDirectory), { recursive: true })
  await writeFile(resolve(generated, noticeDirectory, 'SOURCES.json'), JSON.stringify({
    ...details, packages: bundled,
    inputs: Object.fromEntries(await Promise.all([...modules].sort().map(async file => [
      [...packages.keys()].filter(directory => file.startsWith(directory + '/')).sort((a, b) => b.length - a.length)
        .map(directory => `${packages.get(directory).name}@${packages.get(directory).version}/${relative(directory, file)}`)[0],
      createHash('sha256').update(await readFile(file)).digest('hex'),
    ]))),
  }, null, 2) + '\n')
  return bundled
}
const bundledThirdParty = await writeBundledNotices(googleModules, 'notices/bundled', {
  runtime: relative(project, googleRuntime), googleVersion: googleMetadata.version,
  declarationExports: [...googleTypeExports].sort(),
})
await writeFile(resolve(project, 'NOTICE.md'), (await readFile(resolve(project, 'NOTICE.md'), 'utf8'))
  + '\nGoogle GenAI Node runtime and its required transitive libraries are bundled under lib/vendor; the Google/Vertex providers remain available. Original package metadata, licenses, notices and input hashes are preserved under lib/notices/bundled. Only Node built-ins and the upstream libraries\' optional acceleration/color probes remain external to that runtime.\n')

const hostModules = new Set()
await build({ config: false, cwd: project, entry: { index: 'lib/types/stock/index.js' },
  outDir: generated, format: 'esm', platform: 'node', target: 'es2024',
  dts: false, clean: false, fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
  plugins: [collectBundledInputs('projects-host-bundle-inputs', hostModules), { name: 'projects-shared-google-runtime', resolveId(source, importer) {
    if (importer && source.startsWith('.') && resolve(dirname(importer), source) === googleRuntime) {
      return { id: './vendor/google-genai.js', external: true }
    }
  } }],
})
const hostBundledThirdParty = await writeBundledNotices(hostModules, 'notices/host-bundled', { runtime: 'lib/index.js' })
if (process.platform === 'darwin') {
  const nativeArgs = [resolve(project, 'src/features/schedule/power-darwin/build.mjs'),
    '--out', resolve(generated, 'power-darwin/power-darwin.node')]
  if (process.env.DSH_PROJECTS_NODE_INCLUDE) nativeArgs.push('--node-include', process.env.DSH_PROJECTS_NODE_INCLUDE)
  execFileSync(process.execPath, nativeArgs, { cwd: project, stdio: 'inherit' })
}
await mkdir(resolve(generated, 'notices'), { recursive: true })
await cp(resolve(stock, 'LICENSE'), resolve(generated, 'notices/DSH-LICENSE.txt'))
async function copyNotices(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, item.name)
    if (item.isDirectory()) await copyNotices(file)
    else if (/^(?:LICENSE(?:[.-].+)?|SOURCES\.(?:md|json)|UPSTREAM-(?:NOTICE\.md|PACKAGE\.json))$/i.test(item.name)) {
      const output = resolve(generated, 'notices', relative(resolve(project, 'src'), file))
      await mkdir(dirname(output), { recursive: true })
      await cp(file, output)
    }
  }
}
await copyNotices(resolve(project, 'src/stock'))
const assetMime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
const cssPrefix = '\0projects-inline-css:'
const assetPrefix = '\0projects-inline-asset:'
const cssInputs = []
const assetInputs = []
async function assetData(file) {
  const mime = assetMime[extname(file)]
  if (mime === undefined) throw new Error(`Unsupported browser asset: ${file}`)
  assetInputs.push(relative(project, file))
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`
}
async function inlineCssUrls(source, file) {
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g
  let output = '', start = 0
  for (const match of source.matchAll(pattern)) {
    const url = (match[1] ?? match[2] ?? match[3]).trim()
    output += source.slice(start, match.index)
    if (url === '' || url.startsWith('#') || /^(?:data:|https?:|\/\/)/i.test(url)) output += match[0]
    else {
      if (isAbsolute(url)) throw new Error(`Absolute browser asset in ${file}: ${url}`)
      output += `url(${JSON.stringify(await assetData(resolve(dirname(file), url)))})`
    }
    start = match.index + match[0].length
  }
  return output + source.slice(start)
}
function injectStyle(file, css, classes) {
  const key = '@local/dsh-projects/' + relative(project, file)
  return `const key=${JSON.stringify(key)};if(typeof document!=='undefined'&&!document.querySelector('style[data-plugin-css='+JSON.stringify(key)+']')){const style=document.createElement('style');style.dataset.plugin='@local/dsh-projects';style.dataset.pluginCss=key;style.textContent=${JSON.stringify(css)};document.head.appendChild(style)}\n`
    + (classes === undefined ? 'export {};' : `export default ${JSON.stringify(classes)};`)
}
// Match the native ModuleLoader format: all stylesheet and small image assets
// live inside this plugin's factory, including CSS url() dependencies. Virtual
// .mjs IDs keep tsdown from handing styles to a separate unserved CSS output.
const browserAssets = {
  name: 'projects-private-client-assets',
  resolveId(source, importer) {
    const css = source.endsWith('.css') || source.endsWith('.css?inline')
    const asset = extname(source) in assetMime
    if (!css && !asset) return null
    const input = source.replace(/\?inline$/, '')
    const file = importer === undefined || isAbsolute(input) ? input : resolve(dirname(importer), input)
    return (css ? cssPrefix + (source.endsWith('?inline') ? 'text:' : 'style:') : assetPrefix) + file + '.mjs'
  },
  async load(id) {
    if (id.startsWith(assetPrefix)) {
      const file = id.slice(assetPrefix.length, -4)
      this.addWatchFile(file)
      return `export default ${JSON.stringify(await assetData(file))};`
    }
    if (!id.startsWith(cssPrefix)) return null
    const text = id.startsWith(cssPrefix + 'text:')
    const file = id.slice(cssPrefix.length + (text ? 5 : 6), -4)
    this.addWatchFile(file)
    cssInputs.push(relative(project, file))
    const source = await inlineCssUrls(await readFile(file, 'utf8'), file)
    const modules = !text && file.endsWith('.module.css')
    const { code, exports } = transformCss({ filename: file, code: Buffer.from(source),
      ...(modules ? { cssModules: { pattern: '[hash]_[local]' } } : {}), minify: true })
    if (text) return `export default ${JSON.stringify(code.toString())};`
    const classes = modules ? Object.fromEntries(Object.entries(exports ?? {}).map(([local, value]) => [local, value.name])) : undefined
    return injectStyle(file, code.toString(), classes)
  },
}
const clientModules = new Set()
await build({ config: false, cwd: project, entry: { client: 'src/stock/client/index.tsx' },
  outDir: resolve(buildRoot, 'client'), format: 'cjs', platform: 'browser', target: 'es2024',
  dts: false, clean: true, fixedExtension: true, minify: true,
  outputOptions: { keepNames: true },
  // Match stock INLINE_SAFE: pure Session/LLM/protocol helpers are bundled;
  // dsh.client.external does not invent a factory for arbitrary value exports.
  deps: { neverBundle: external, alwaysBundle: specifier => !external.includes(specifier) },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}' },
  inputOptions: { resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] } },
  plugins: [{
    name: 'projects-native-client-module-edges',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/') || external.includes(source)) return null
      if (inlineNativeWire.test(source) || inlineNativeProtocol.includes(source) || /^@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$)/.test(source)
        || /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/.test(source)) return null
      throw new Error(`Native client value import requires its real ModuleLoader export: ${source}`)
    },
  }, browserAssets, collectBundledInputs('projects-client-bundle-inputs', clientModules)],
})
const client = await readFile(resolve(buildRoot, 'client/client.cjs'), 'utf8')
const imports = [...client.matchAll(/require\(["']([^"']+)["']\)/g)].map(value => value[1])
const undeclared = [...new Set(imports.filter(value => !external.includes(value)))]
if (undeclared.length) throw new Error(`Undeclared browser modules: ${undeclared.join(', ')}`)
await writeFile(resolve(generated, 'client.js'), `window.__ModuleLoader__.load({id:'@local/dsh-projects',factory(require){const module={exports:{}};const exports=module.exports;\n${client}\nreturn module.exports;}});\n`)
const clientBundledThirdParty = await writeBundledNotices(clientModules, 'notices/client-bundled', { runtime: 'lib/client.js' })
await writeFile(resolve(project, 'NOTICE.md'), (await readFile(resolve(project, 'NOTICE.md'), 'utf8'))
  + '\nClient and Host bundles preserve original licenses, notices, package metadata and hashes for their actually inlined npm and SDK vendor inputs under lib/notices/client-bundled and lib/notices/host-bundled. Refer to each SOURCES.json for the exact package/version list.\n')
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', buildRoot], { cwd: project, encoding: 'utf8' }))[0]
const tgz = resolve(buildRoot, `dsh-projects-${version}.tgz`)
await rename(resolve(buildRoot, packed.filename), tgz)
const sourceHashes = {}
async function hashSources(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, item.name)
    if (item.isDirectory()) await hashSources(file)
    else if (item.isFile() && item.name !== '.DS_Store' && !item.name.endsWith('.node')) {
      sourceHashes[relative(project, file)] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
}
await hashSources(resolve(project, 'src'))
const sourcesFile = `SOURCES-${version}.json`
await writeFile(resolve(buildRoot, sourcesFile), JSON.stringify({ version, sourceHashes }, null, 2) + '\n')
const report = {
  version, stockCommit, selectedSdk: { version: stockInputs.version, commit: stockCommit },
  enginesDsh: supportedDshRange, tgz, sha256: createHash('sha256').update(await readFile(tgz)).digest('hex'),
  clientImports: [...new Set(imports)], pluginFiles: packed.files.map(value => value.path),
  cssInputs: [...new Set(cssInputs)], assetInputs: [...new Set(assetInputs)],
  sdkEmissionRewrites,
  googleRewrites, bundledThirdParty, hostBundledThirdParty, clientBundledThirdParty,
  inlineNativeProtocol,
  sourceInputs: sourcesFile,
  buildScriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  buildTools: stockInputs.tools,
  hostPatched: false, phase: 'Public build; runtime acceptance is separate',
}
await writeFile(resolve(buildRoot, 'BUILD.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(resolve(buildRoot, `BUILD-${version}.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ version, tgz, sha256: report.sha256 }, null, 2))
}
} finally {
  if (checkOnly) await rm(buildRoot, { recursive: true, force: true })
}
