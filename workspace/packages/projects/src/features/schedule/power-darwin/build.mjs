import { realpathSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') throw new Error('Darwin build requires macOS.')
const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const test = args.includes('--test')
const outputIndex = args.indexOf('--out')
const output = resolve(outputIndex < 0 ? join(root, test ? 'power-darwin-test.node' : 'power-darwin.node') : args[outputIndex + 1])
const includeIndex = args.indexOf('--node-include')
const include = includeIndex < 0 ? resolve(dirname(realpathSync(process.execPath)), '../include/node') : resolve(args[includeIndex + 1])
mkdirSync(dirname(output), { recursive: true })
const compilerArgs = ['-std=c++17', '-bundle', '-undefined', 'dynamic_lookup', '-fobjc-arc', '-fblocks',
  '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8', ...(test ? ['-DDSH_POWER_TESTING=1'] : []),
  '-I', include, join(root, 'native.mm'), '-framework', 'AppKit', '-framework', 'Foundation', '-framework', 'CoreFoundation', '-o', output]
const result = spawnSync('/usr/bin/clang++', compilerArgs, { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(JSON.stringify({ output, compiler: '/usr/bin/clang++', args: compilerArgs, node: process.version, nodeApi: 8, test }))
