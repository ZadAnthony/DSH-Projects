/** Own adapter instances over one immutable host configuration generation. */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { ProjectsProviderSnapshot } from '../host-ports.ts'
import { DeepSeekAdapter } from './deepseek/adapter.ts'
import { createDeepSeekConnectionHooks } from './deepseek/connections.ts'
import { DeepSeekFileStore } from './deepseek/file-store.ts'
import { DeepSeekUploadIndex } from './deepseek/upload-index.ts'
import { PiAiAdapter } from './pi/adapter.ts'
import { resolveProfiles, type PiAiProviderProfile } from './pi/config.ts'
import { credentialStoreFrom, authContextFrom } from './pi/auth.ts'
import type { Api, Model } from './provider-sdk/index.js'

export interface ProjectsBoundAdapter { readonly adapter: LlmAdapter; readonly routes: readonly string[] }
export function createProjectsBoundAdapter(ctx: Context, snapshot: ProjectsProviderSnapshot): ProjectsBoundAdapter {
  const configuration = structuredClone(snapshot.configuration)
  const imageAccess = (attachments: Parameters<typeof resolveImageAttachmentAccess>[0], ref: Parameters<typeof resolveImageAttachmentAccess>[2]) =>
    resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref)
  if (snapshot.family === 'pi-ai') {
    const profiles = resolveProfiles(configuration.providers as Record<string, PiAiProviderProfile> | undefined, 'deferred',
      snapshot.catalog as Readonly<Record<string, readonly Model<Api>[]>> | undefined)
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async (_provider, profile) => {
        if (profile.apiKeyEnv === undefined) return undefined
        const value = await ctx.get('credentials')?.resolve(profile.apiKeyEnv)
        const key = value?.value ?? (ctx.get('credentials') === undefined ? launchEnvironmentOf(ctx).get(profile.apiKeyEnv)?.value : undefined)
        if (key === undefined) throw new LlmError('Projects configured provider credential is unavailable', 'MISSING_CREDENTIAL')
        return assertUsableApiKey(key, 'projects-llm-pi-ai', profile.apiKeyEnv)
      },
      auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
      resolveAttachments: () => ctx.get('attachments'), resolveImageAccess: imageAccess,
      onReplayDegrade: detail => ctx.logger.warn(`projects model replay unavailable for ${detail.provider}/${detail.model}: ${detail.reason}`),
    })
    return { adapter, routes: [...profiles.keys()] }
  }
  const connection = createDeepSeekConnectionHooks(ctx, snapshot)
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || !('dataRoot' in persistence) || typeof persistence.dataRoot !== 'string') throw new Error('PROJECT_MODEL_STORAGE_UNAVAILABLE')
  const files = new DeepSeekFileStore({ index: new DeepSeekUploadIndex(join(persistence.dataRoot, 'model-files', 'deepseek-files-v3.json')) })
  const adapter = new DeepSeekAdapter({
    ...connection,
    providerName: snapshot.family === 'deepseek-account' ? 'DeepSeek Account' : 'DeepSeek',
    resolveUserId: () => getOrCreateAnonymousUserId(), resolveFiles: () => files,
    resolveAttachments: () => ctx.get('attachments'), resolveImageAccess: imageAccess,
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request) ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
    onReplayDegrade: detail => ctx.logger.warn(`projects model replay unavailable for ${detail.provider}/${detail.model}: ${detail.reason}`),
    onExtensionsOmitted: detail => ctx.logger.warn(`projects model request extensions omitted for ${detail.provider}/${detail.model}: ${detail.fields.join(', ')}`),
    onExtensionsUnaccepted: detail => ctx.logger.warn(`projects model request extension acceptance failed for ${detail.provider}/${detail.model}: ${String(detail.error)}`),
  })
  return { adapter, routes: [snapshot.route] }
}
