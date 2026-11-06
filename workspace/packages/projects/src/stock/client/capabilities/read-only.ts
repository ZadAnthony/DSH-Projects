/// <reference path="./css-modules.d.ts" />
/** Immutable native Plan/file presentation shared by private live and read-only domains. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as applyResources } from '@deepseek-ai/dsh-client-resources/client'
import { apply as applyPlan } from '@deepseek-ai/dsh-client-ui-plan/client'
import { ProjectPlanNavigation } from './plan-navigation.tsx'
import { installProjectPresentedFiles, type ProjectPresentedFilesPorts } from './deliverables/index.ts'
import { installProjectChangedFiles, type ProjectChangedFilesPorts } from './changes/index.ts'
import type { ProjectPlanNavigationPort } from './contracts.ts'

export interface ProjectReadOnlyNativePresentationPorts {
  /** Each address resolves its exact Reader Session adapter; never root Session Remote. */
  readonly session: Pick<SessionRemote, 'follow' | 'page'>
  /** An explicit navigation remains owned by its caller. */
  readonly planNavigation?: ProjectPlanNavigationPort
  readonly openResourceFallback?: Context['sidebarRight']['openResource']
  readonly presentedFiles?: ProjectPresentedFilesPorts
  readonly changedFiles?: ProjectChangedFilesPorts
}

/**
 * Callers provide their exact private Remote, UiSession, UiConversation and tool renderer.
 * This installs only immutable Plan/file cards and the preview. Commands, input,
 * model controls and selected tool views remain the caller's separate assembly.
 */
export async function installProjectReadOnlyNativePresentations(ctx: Context, ports: ProjectReadOnlyNativePresentationPorts) {
  if (typeof ports.session.follow !== 'function' || typeof ports.session.page !== 'function') throw new Error('Projects native Plan reader requires exact read-only follow/page')
  if (ports.changedFiles !== undefined && ports.presentedFiles === undefined) throw new Error('Projects changed-file reader requires the shared presented-files definition owner')
  const remote = ctx.get('remote')
  if (remote === undefined) throw new Error('Projects native Plan reader requires private Remote host facts')
  if (ctx.get('resources') === undefined) applyResources(ctx)
  let ownedNavigation: ProjectPlanNavigation | undefined
  const navigation = ports.planNavigation ?? (ownedNavigation = new ProjectPlanNavigation(ctx, ports.openResourceFallback))
  if (ctx.get('sidebarRight') === undefined) ctx.provide('sidebarRight', navigation.sidebarRight)
  else ctx.set('sidebarRight', navigation.sidebarRight)
  if (ports.planNavigation === undefined && ctx.get('sidebarRightTabs') !== undefined) throw new Error('Projects Plan reader already has a sidebar owner')
  ctx.provide('sidebarRightTabs', navigation.sidebarRightTabs)
  await ctx.inject(['slots', 'sessions', 'uiSession', 'uiConversation', 'locale', 'resources'], () => {})
  applyPlan(ctx)
  if (ports.presentedFiles !== undefined) await installProjectPresentedFiles(ctx, ports.presentedFiles)
  if (ports.changedFiles !== undefined) await installProjectChangedFiles(ctx, ports.changedFiles)
  return { mode: 'reader' as const, planNavigation: navigation, mount: (container: HTMLElement) => navigation.mount(container), dispose: () => ownedNavigation?.dispose() }
}
