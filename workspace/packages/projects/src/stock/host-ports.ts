import { Service, type Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { createRequire, findPackageJSON } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type DeepSeekAccount from '@deepseek-ai/dsh-deepseek-account'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { copyPresetDeclaration } from './presets/codec.ts'
import type {
  ConfigureCall, GenerateOptions, LlmCallConfig, LlmImageRequestPricing,
  LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedLlmCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { captureProjectsPresetSnapshot, type ProjectsPresetSnapshot } from './preset-snapshot.ts'

/** Only configuration/model DTOs and a one-shot prepared call cross graphs. */
export interface ProjectsModelHostPort {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
  imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined
  imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): ImageRequestTarget
  prepareCall(config: LlmCallConfig, signal?: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall>
  captureProvider?(provider: string): ProjectsProviderSnapshot | undefined
  subscribe?(listener: () => void): () => void
}
export interface ProjectsProviderSnapshot {
  readonly family: 'deepseek-api-key' | 'deepseek-account' | 'pi-ai'
  readonly route: string
  readonly generation: string
  readonly configuration: Record<string, unknown>
  /** 原宿主SDK的纯型号描述符；不携带Provider、认证函数或运行Context。 */
  readonly catalog?: Readonly<Record<string, readonly object[]>>
}

/** 按声明的解析基址读取原适配器真正依赖的SDK公开目录，避免私有SDK旧表成为第二份事实源。 */
function capturePiCatalog(baseUrl: string, providers: readonly string[]): NonNullable<ProjectsProviderSnapshot['catalog']> {
  const pluginPackage = findPackageJSON('@deepseek-ai/dsh-llm-pi-ai', baseUrl)
  if (pluginPackage === undefined) throw new Error('PROJECT_MODEL_CATALOG_OWNER_UNAVAILABLE')
  const sdkPackage = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(pluginPackage))
  if (sdkPackage === undefined) throw new Error('PROJECT_MODEL_CATALOG_OWNER_UNAVAILABLE')
  const metadata = JSON.parse(readFileSync(sdkPackage, 'utf8')) as { exports?: Record<string, string | { import?: string; default?: string }> }
  const declaration = metadata.exports?.['./providers/all'] ?? metadata.exports?.['./providers/*']
  const target = typeof declaration === 'string' ? declaration : declaration?.import ?? declaration?.default
  if (target === undefined || !target.startsWith('./')) throw new Error('PROJECT_MODEL_CATALOG_PUBLIC_EXPORT_UNAVAILABLE')
  // Node支持同步加载该公开ESM入口；只消费可复制数据，不借用原SDK的Provider工厂或认证实例。
  const entry = fileURLToPath(new URL(target.replace('*', 'all'), pathToFileURL(sdkPackage)))
  const sdk = createRequire(sdkPackage)(entry) as { getBuiltinModels(provider: string): readonly object[] }
  return Object.fromEntries(providers.map(provider => [provider, structuredClone(sdk.getBuiltinModels(provider))]))
}

export interface ProjectsHostPorts {
  readonly preset: { capture(id?: string): Promise<ProjectsPresetSnapshot> }
  readonly models: ProjectsModelHostPort
  readonly credentials?: Pick<CredentialProvider, 'resolve' | 'describe' | 'readRecord' | 'listRecords' | 'modifyRecord' | 'deleteRecord'>
  readonly environment?: LaunchEnvironmentSnapshot
  readonly account?: Pick<DeepSeekAccount, 'resolveToken' | 'rejectToken'>
  readonly runtimeConfiguration?: () => { readonly tools: unknown; readonly systemPrompt: unknown }
}

/**
 * Keep the root as the only configuration and credential owner. No Agent,
 * Session, ToolRuntime, adapter, job, preset instance or Context is returned.
 * Built-in routes resolve keys/grants per request through narrow root-owned
 * credential/account capabilities; their store and refresh lock stay unique.
 * Extra adapters expose only the public one-shot prepared call. Dispatch carries
 * GenerateOptions data and signal, never a root adapter or Context instance.
 */
export function createProjectsHostPorts(root: Context): ProjectsHostPorts {
  const environment = launchEnvironmentOf(root)
  const writableCredentials = () => {
    const owner = root.get('credentials')
    if (owner === undefined) throw new LlmError('Projects cannot store credentials while the host credentials service is unavailable', 'NO_CREDENTIAL_STORE')
    return owner
  }
  const plain = (value: unknown): unknown => {
    if (isVolatile(value)) return plain(value.get())
    if (Array.isArray(value)) return value.map(plain)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
    if (typeof value === 'function' || typeof value === 'symbol') throw new Error('PROJECT_MODEL_CONFIGURATION_UNCOPYABLE')
    return value
  }
  const captureProvider = (provider: string): ProjectsProviderSnapshot | undefined => {
    const directory = root.llm.listConfigurableProviders().find(item => item.provider === provider)
    if (directory === undefined) return undefined
    const entries = [...root.loader.entries()].filter(entry => !entry.disabled && entry.options.id === directory.settingsNs && entry.fiber !== undefined)
    if (entries.length !== 1) throw new Error(`PROJECT_MODEL_CONFIGURATION_UNAVAILABLE: ${provider}`)
    const entry = entries[0]!
    const family = entry.options.name === '@deepseek-ai/dsh-llm-deepseek-api-key' ? 'deepseek-api-key'
      : entry.options.name === '@deepseek-ai/dsh-llm-deepseek-account' ? 'deepseek-account'
      : entry.options.name === '@deepseek-ai/dsh-llm-pi-ai' ? 'pi-ai' : undefined
    if (family === undefined) return undefined
    const configuration = plain(entry.fiber!.config) as Record<string, unknown>
    const catalog = family === 'pi-ai'
      ? capturePiCatalog(entry.parent.tree.ctx.baseUrl!, Object.keys(configuration.providers as Record<string, unknown> ?? {}))
      : undefined
    // Generation identifies the actual owner and its complete current validated values.
    const generation = createHash('sha256').update(JSON.stringify([entry.id, entry.fiber!.uid, configuration, catalog])).digest('hex')
    return Object.freeze({ family, route: provider, generation, configuration: structuredClone(configuration), ...catalog === undefined ? {} : { catalog } })
  }
  return {
    environment,
    preset: { capture: id => captureProjectsPresetSnapshot(root, id) },
    runtimeConfiguration: () => {
      const rows = [...root.loader.entries()].filter(entry => !entry.disabled)
      const read = (name: string): unknown => {
        const matches = rows.filter(entry => entry.options.name === name)
        if (matches.length !== 1) throw new Error(`PROJECT_CONFIGURATION_UNAVAILABLE: expected one active host declaration for ${name}`)
        return copyPresetDeclaration(matches[0]!.options.config ?? {}, `host.${name}.config`)
      }
      return { tools: read('@deepseek-ai/dsh-tools'), systemPrompt: read('@deepseek-ai/dsh-system-prompt') }
    },
    models: {
      listProviders: () => structuredClone(root.llm.listProviders()),
      listModels: async provider => structuredClone(await root.llm.listModels(provider)),
      resolveModelInfo: async (provider, model, signal) => structuredClone(await root.llm.resolveModelInfo(provider, model, signal)),
      resolveCallConfig: async (config, signal) => structuredClone(await root.llm.resolveCallConfig(structuredClone(config), signal)),
      imageRequestPricing: (provider, model) => structuredClone(root.llm.imageRequestPricing(provider, model)),
      imageRequestTarget: (provider, model, image) => structuredClone(root.llm.imageRequestTarget(provider, model, structuredClone(image))),
      prepareCall: (config, signal, configure) => root.llm.prepareCall(structuredClone(config), signal, configure),
      captureProvider,
      subscribe: listener => {
        // Loader changes have their own graph subscription. This port forwards
        // model inventory changes without scheduling a second graph refresh.
        return root.on('llm/adapters-updated', listener, { global: true })
      },
    },
    // Optional host owners may still be loading at graph creation, or be replaced
    // later. Keep the capability live without creating a second credential store.
    credentials: {
      resolve: ref => {
        const owner = root.get('credentials')
        if (owner !== undefined) return owner.resolve(ref)
        const ambient = environment.get(ref)
        return Promise.resolve(ambient !== undefined && ambient.value.length > 0 ? ambient : undefined)
      },
      describe: ref => {
        const owner = root.get('credentials')
        if (owner !== undefined) return owner.describe(ref)
        const ambient = environment.get(ref)
        const configured = ambient !== undefined && ambient.value.length > 0
        return Promise.resolve({ configured, ...configured ? { source: ambient.source } : {}, writable: false })
      },
      readRecord: key => root.get('credentials')?.readRecord(key) ?? Promise.resolve(undefined),
      listRecords: () => root.get('credentials')?.listRecords() ?? Promise.resolve([]),
      modifyRecord: async (key, mutate) => writableCredentials().modifyRecord(key, mutate),
      deleteRecord: async key => writableCredentials().deleteRecord(key),
    },
    account: {
      resolveToken: (url: string) => root.get('deepseekAccount')?.resolveToken(url) ?? Promise.resolve(undefined),
      rejectToken: (token: string) => root.get('deepseekAccount')?.rejectToken(token) ?? Promise.resolve(),
    },
  }
}

class ProjectsCredentialReferences extends Service {
  constructor(ctx: Context, readonly port: NonNullable<ProjectsHostPorts['credentials']>) { super(ctx, 'credentials') }
  resolve(ref: Parameters<CredentialProvider['resolve']>[0]) { return this.port.resolve(ref) }
  describe(ref: Parameters<CredentialProvider['describe']>[0]) { return this.port.describe(ref) }
  readRecord(...args: Parameters<CredentialProvider['readRecord']>) { return this.port.readRecord(...args) }
  listRecords() { return this.port.listRecords() }
  modifyRecord(...args: Parameters<CredentialProvider['modifyRecord']>) { return this.port.modifyRecord(...args) }
  deleteRecord(...args: Parameters<CredentialProvider['deleteRecord']>) { return this.port.deleteRecord(...args) }
}

class ProjectsAccountInference extends Service {
  constructor(ctx: Context, readonly port: NonNullable<ProjectsHostPorts['account']>) { super(ctx, 'deepseekAccount') }
  resolveToken(url: string) { return this.port.resolveToken(url) }
  rejectToken(token: string) { return this.port.rejectToken(token) }
}

export async function installProjectsReadOnlyHostCapabilities(ctx: Context, ports: ProjectsHostPorts): Promise<void> {
  if (ports.environment !== undefined) ctx.provide('launchEnvironment', ports.environment)
  const fibers = []
  if (ports.credentials !== undefined) fibers.push(ctx.plugin(ProjectsCredentialReferences, ports.credentials))
  if (ports.account !== undefined) fibers.push(ctx.plugin(ProjectsAccountInference, ports.account))
  await Promise.all(fibers.map(fiber => fiber.await()))
}

export { ProjectsLlmRuntime } from './model/runtime.ts'
