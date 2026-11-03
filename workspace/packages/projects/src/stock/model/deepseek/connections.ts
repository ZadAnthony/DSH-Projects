/*!
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from stock DSH 1f81c047fc48fa190a683e469daa699857e9afe8 packages/llm/llm-deepseek-api-key/src/index.ts and packages/llm/llm-deepseek-account/src/index.ts
*/
/** Credential-scoped native catalog policy over one immutable Projects configuration generation. */
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY, assertUsableApiKey, LlmError, QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  catalogModelInfo, ModelListingCache, refuseListedModel, requestModelListing, resolveListedCatalog,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { CatalogRefusal, ListingView, ModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import type { ProjectsProviderSnapshot } from '../../host-ports.ts'
import { resolveAdapterOptions as resolveApiKeyOptions, type Options as ApiKeyOptions } from './api-key-config.ts'
import { resolveAccountOptions, type AccountOptions } from './account-config.ts'
import { resolveAdapterOptions } from './config.ts'
import type { DeepSeekAdapterOptions, DeepSeekCatalogModel, DeepSeekConnectionOptions, DeepSeekRequestAuth } from './types.ts'

interface ProjectsDeepSeekConnection extends DeepSeekConnectionOptions {
  readonly offered: readonly DeepSeekCatalogModel[]
  readonly refusals: ReadonlyMap<string, CatalogRefusal>
}
type ConnectionHooks = Pick<DeepSeekAdapterOptions<ProjectsDeepSeekConnection>, 'options' | 'connect' | 'admit' | 'discoverModels' | 'resolveAuth'>

/**
 * Follow the same listing, fallback, override and admission rules as native rc.3.
 * The root services retain credential storage, token refresh and invalidation;
 * this graph owns only a credential-scoped listing cache and detached DTOs.
 * Catalog loads consume no model inference and are released with this graph.
 */
export function createDeepSeekConnectionHooks(ctx: Context, snapshot: ProjectsProviderSnapshot): ConnectionHooks {
  const configuration = structuredClone(snapshot.configuration)
  const environment = launchEnvironmentOf(ctx)
  const diagnostics = {
    now: () => Date.now(),
    info: (message: string) => ctx.logger.info(`[projects-${snapshot.family}] ${message}`),
    warn: (message: string) => ctx.logger.warn(`[projects-${snapshot.family}] ${message}`),
  }
  let reportedListing: ModelListing | undefined
  const catalogOf = (connection: DeepSeekConnectionOptions, view: ListingView | undefined, overrides = {}) => {
    if (view === undefined) return { ...connection, offered: connection.models, refusals: new Map<string, CatalogRefusal>() }
    const catalog = resolveListedCatalog({ listing: view.listing?.entries, supported: connection.models,
      overrides, routeMaxTokens: connection.maxTokens, clientVersion: APP_IDENTITY.version })
    if (view.listing !== reportedListing) {
      reportedListing = view.listing
      for (const problem of catalog.problems) diagnostics.warn(problem)
    }
    return { ...connection, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals }
  }
  const admit = (connection: ProjectsDeepSeekConnection, model: string) => { refuseListedModel(model, connection.refusals.get(model)) }

  if (snapshot.family === 'deepseek-account') {
    const settings = resolveAccountOptions(configuration as AccountOptions, environment)
    const protocol = { ...settings.protocol, models: resolveAdapterOptions({}).models }
    const account = () => ctx.get('deepseekAccount')
    const resolveAuth = async (connection: DeepSeekConnectionOptions): Promise<DeepSeekRequestAuth> => {
      const token = await account()?.resolveToken(connection.baseURL)
      if (token === undefined) throw new LlmError('Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.', 'ACCOUNT_SIGN_IN_REQUIRED')
      return { headers: { 'x-dsh-auth-token': token }, onRequestError: async error => {
        if (!(error instanceof LlmError)) return error
        if (error.code === QUOTA_EXCEEDED_CODE) return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
        if (error.failure.status !== 401) return error
        try { await account()?.rejectToken(token) } catch (_rejectionPersistenceFailed) { /* Inference failure remains authoritative. */ }
        return new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
      } }
    }
    const listings = new ModelListingCache({ ...diagnostics,
      credential: async url => account()?.resolveToken(url),
      load: (url, token, signal) => requestModelListing(url, { 'x-dsh-auth-token': token }, signal) })
    ctx.effect(() => () => listings.dispose(), 'projects.deepseek-account-model-listing')
    const connectionOf = (view: ListingView) => catalogOf(protocol, view, settings.modelOverrides)
    return {
      options: () => connectionOf(listings.current()), connect: async signal => connectionOf(await listings.view(settings.catalog, signal)),
      admit, resolveAuth,
      discoverModels: async provider => {
        const view = await listings.view(settings.catalog)
        return view.authenticated ? connectionOf(view).offered.map(model => catalogModelInfo(provider, model)) : []
      },
    }
  }

  const connection = resolveApiKeyOptions(configuration as ApiKeyOptions, environment)
  const resolveApiKey = async (): Promise<string> => {
    const credentials = ctx.get('credentials')
    const hit = credentials === undefined ? environment.get(connection.apiKeyEnv) : await credentials.resolve(connection.apiKeyEnv)
    if (hit === undefined) throw new LlmError('Projects configured DeepSeek credential is unavailable', 'MISSING_CREDENTIAL')
    return assertUsableApiKey(hit.value, 'projects-llm-deepseek', connection.apiKeyEnv)
  }
  const presentApiKey = async () => {
    try { return await resolveApiKey() }
    catch (error) { if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return undefined; throw error }
  }
  const listings = new ModelListingCache({ ...diagnostics, credential: presentApiKey,
    load: (url, apiKey, signal) => requestModelListing(url, { 'x-api-key': apiKey }, signal) })
  ctx.effect(() => () => listings.dispose(), 'projects.deepseek-api-key-model-listing')
  const connectionOf = (view?: ListingView) => catalogOf(connection, view)
  return {
    options: () => connectionOf(connection.listing === undefined ? undefined : listings.current()),
    connect: async signal => {
      if (connection.listing === undefined) return connectionOf()
      try { return connectionOf(await listings.view(connection.listing, signal)) }
      catch (error) { if (signal?.aborted) throw error; return connectionOf() }
    },
    admit,
    resolveAuth: async () => ({ headers: { 'x-api-key': await resolveApiKey() } }),
    discoverModels: async provider => {
      if (connection.listing === undefined) return await presentApiKey() === undefined ? [] : connection.models.map(model => catalogModelInfo(provider, model))
      const view = await listings.view(connection.listing)
      return view.authenticated ? connectionOf(view).offered.map(model => catalogModelInfo(provider, model)) : []
    },
  }
}
