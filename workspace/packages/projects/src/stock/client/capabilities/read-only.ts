/// <reference path="./css-modules.d.ts" />
/** Minimal native Plan presentation for a ReaderDomain that declares no composer/input seats. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as applyResources } from '@deepseek-ai/dsh-client-resources/client'
import { apply as applyPlan } from '@deepseek-ai/dsh-client-ui-plan/client'
import { ProjectPlanNavigation } from './plan-navigation.tsx'
import { installProjectPresentedFiles, type ProjectPresentedFilesPorts } from './deliverables/index.ts'
import { installProjectChangedFiles, type ProjectChangedFilesPorts } from './changes/index.ts'

export interface ProjectReadOnlyNativePresentationPorts {
  /** Each address resolves its exact Reader Session adapter; never root Session Remote. */
  readonly session: Pick<SessionRemote, 'follow' | 'page'>
  readonly openResourceFallback?: Context['sidebarRight']['openResource']
  readonly presentedFiles?: ProjectPresentedFilesPorts
  readonly changedFiles?: ProjectChangedFilesPorts
}

/**
 * Reader owners provide UiSession, UiConversation and the native tool renderer.
 * This adds native immutable Plan cards/resources and a real preview, requiring
 * only the two reads it actually executes. No command/question/model/keyboard
 * services are acquired. The Reader must never declare a composer/input seat.
 */
export async function installProjectReadOnlyNativePresentations(ctx: Context, ports: ProjectReadOnlyNativePresentationPorts) {
  if (typeof ports.session.follow !== 'function' || typeof ports.session.page !== 'function') throw new Error('Projects native Plan reader requires exact read-only follow/page')
  if (ports.changedFiles !== undefined && ports.presentedFiles === undefined) throw new Error('Projects changed-file reader requires the shared presented-files definition owner')
  const remote = ctx.get('remote')
  if (remote === undefined) throw new Error('Projects native Plan reader requires private Remote host facts')
  ctx.set('remote', { ...remote, $host: remote.$host, $on: remote.$on.bind(remote), session: ports.session })
  if (ctx.get('resources') === undefined) applyResources(ctx)
  const navigation = new ProjectPlanNavigation(ctx, ports.openResourceFallback)
  if (ctx.get('sidebarRight') === undefined) ctx.provide('sidebarRight', navigation.sidebarRight)
  else ctx.set('sidebarRight', navigation.sidebarRight)
  if (ctx.get('sidebarRightTabs') === undefined) ctx.provide('sidebarRightTabs', navigation.sidebarRightTabs)
  else throw new Error('Projects Plan reader already has a sidebar owner')
  await ctx.inject(['slots', 'sessions', 'uiSession', 'uiConversation', 'locale', 'resources'], () => {})
  applyPlan(ctx)
  if (ports.presentedFiles !== undefined) await installProjectPresentedFiles(ctx, ports.presentedFiles)
  if (ports.changedFiles !== undefined) await installProjectChangedFiles(ctx, ports.changedFiles)
  return { mode: 'reader' as const, planNavigation: navigation, mount: (container: HTMLElement) => navigation.mount(container), dispose: () => navigation.dispose() }
}
