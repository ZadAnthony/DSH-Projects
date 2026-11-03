/// <reference path="./css-modules.d.ts" />
/** Published stock capability assembly for the independent Projects ClientDomain. */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyInputTriggers, InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply as applyCommands, CommandUiRuntime } from '@deepseek-ai/dsh-client-ui-commands/client'
import { apply as applyReferences } from '@deepseek-ai/dsh-client-ui-reference/client'
import { apply as applyModels, ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { apply as applyApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import { apply as applyQuestions } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import { apply as applyPlan } from '@deepseek-ai/dsh-client-ui-plan/client'
import { apply as applyResources } from '@deepseek-ai/dsh-client-resources/client'
import type { ProjectNativeCapabilityPorts, ProjectPlanNavigationPort } from './contracts.ts'
import { ProjectScopedShortcuts } from './shortcuts.ts'
import { ProjectPlanNavigation } from './plan-navigation.tsx'
import { installProjectNativeToolViews } from './tool-views.ts'
import { installProjectCurrentSessionPickers } from './pickers/index.ts'
import { installProjectPresentedFiles } from './deliverables/index.ts'
import { installProjectChangedFiles } from './changes/index.ts'

export * from './contracts.ts'
export { ProjectScopedShortcuts } from './shortcuts.ts'
export { ProjectPlanNavigation } from './plan-navigation.tsx'
export { installProjectNativeToolViews, PROJECT_NATIVE_TOOL_VIEW_EXTERNALS } from './tool-views.ts'
export { parseProjectSubagentChatAddress } from './subagent-address.ts'
export { installProjectReadOnlyNativePresentations, type ProjectReadOnlyNativePresentationPorts } from './read-only.ts'
export { installProjectCurrentSessionPickers, type ProjectCurrentSessionPickerPorts } from './pickers/index.ts'
export { installProjectPresentedFiles, type ProjectPresentedFilesPorts } from './deliverables/index.ts'
export { installProjectChangedFiles, type ProjectChangedFilesPorts } from './changes/index.ts'

/** These factories must remain external in the normal plugin's dsh.client.external table. */
export const PROJECT_NATIVE_CAPABILITY_EXTERNALS = Object.freeze([
  '@deepseek-ai/dsh-client-ui-input-trigger/client',
  '@deepseek-ai/dsh-client-ui-commands/client',
  '@deepseek-ai/dsh-client-ui-reference/client',
  '@deepseek-ai/dsh-client-ui-model-selection/client',
  '@deepseek-ai/dsh-client-ui-approval/client',
  '@deepseek-ai/dsh-client-ui-user-questions/client',
  '@deepseek-ai/dsh-client-ui-plan/client',
  '@deepseek-ai/dsh-client-resources/client',
] as const)

export interface ProjectNativeCapabilities {
  readonly mode: 'live' | 'reader'
  readonly shortcuts: ProjectScopedShortcuts | undefined
  readonly planNavigation: ProjectPlanNavigationPort
  readonly toolViewsInstalled: boolean
  readonly currentSessionPickersInstalled: boolean
  readonly presentedFilesInstalled: boolean
  readonly changedFilesInstalled: boolean
  /** Mount the private keyboard adapter and Plan document preview after the renderer commits. */
  mount(container: HTMLElement): () => void
  /** Called after the private renderer commits; returned cleanup belongs to the Domain mount. */
  mountKeyboard(container: HTMLElement): () => void
}

function requireMethod(value: unknown, method: string, owner: string): void {
  if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>)[method] !== 'function') {
    throw new Error(`Projects native capability requires ${owner}.${method}`)
  }
}

/** A missing-service injection may settle while still pending; await its actual producer instead. */
async function awaitNativeService(ctx: Context, plugin: Parameters<Context['registry']['get']>[0], name: string): Promise<void> {
  const runtime = ctx.registry.get(plugin)
  const fibers = runtime === undefined ? [] : [...runtime.fibers]
  if (fibers.length === 0) throw new Error(`Projects native ${name} producer was not installed`)
  // This waits for the real published constructor and propagates its startup
  // error. It does not install a second provider or infer readiness from a
  // consumer fiber that can remain inactive with an unresolved dependency.
  await Promise.all(fibers.map(fiber => fiber.await()))
  if (ctx.get(name) === undefined) throw new Error(`Projects native ${name} producer did not activate`)
}

/**
 * Call after renderer, locale, Projects ISessions, UiSession and UiConversation are ready.
 * `remote` is the exact object already provided to this private Context, never root Remote.
 * All writable actions retain the physical session captured by the native source/controller.
 * Goal is deliberately absent: its commands must also be excluded by the Project catalog owner.
 */
export async function installProjectNativeCapabilities(ctx: Context, ports: ProjectNativeCapabilityPorts): Promise<ProjectNativeCapabilities> {
  if (ctx.get('remote') !== ports.remote) throw new Error('Projects capabilities must use the private Domain Remote')
  if (ports.changedFiles !== undefined && ports.presentedFiles === undefined) throw new Error('Projects changed-file cards require the shared presented-files definition owner')
  const planNavigation = ports.planNavigation ?? new ProjectPlanNavigation(ctx, ports.openResourceFallback, ports.selectedTools?.openSubagentAside)
  requireMethod(planNavigation.sidebarRight, 'openResource', 'sidebarRight')
  requireMethod(planNavigation.sidebarRight.mounted, 'getSnapshot', 'sidebarRight.mounted')
  requireMethod(planNavigation.sidebarRight.mounted, 'subscribe', 'sidebarRight.mounted')
  requireMethod(planNavigation.sidebarRightTabs, 'register', 'sidebarRightTabs')
  requireMethod(planNavigation, 'mount', 'planNavigation')
  for (const [owner, method] of [['commands', 'list'], ['commands', 'execute'], ['fileReferences', 'list'], ['sessionReferenceResolver', 'candidates'], ['userQuestions', 'answer'], ['userQuestions', 'attachWait']] as const) {
    requireMethod(ports.remote[owner], method, `remote.${owner}`)
  }
  // Cordis treats dotted injection names as service keys. Publishing a Remote
  // object alone does not activate native plugins that inject its namespaces.
  for (const owner of ['session', 'commands', 'fileReferences', 'sessionReferenceResolver', 'userQuestions'] as const) {
    const key = `remote.${owner}`
    if (ctx.get(key) === undefined) ctx.provide(key, ports.remote[owner])
    else if (ctx.get(key) !== ports.remote[owner]) throw new Error(`Projects native namespace belongs to another owner: ${key}`)
  }
  // The explicit ports are complete for what the published plan plugin reads.
  if (ctx.get('sidebarRight') !== undefined) ctx.set('sidebarRight', planNavigation.sidebarRight)
  else ctx.provide('sidebarRight', planNavigation.sidebarRight)
  ctx.provide('sidebarRightTabs', planNavigation.sidebarRightTabs)
  if (ctx.get('resources') === undefined) applyResources(ctx)
  await ctx.inject(['slots', 'sessions', 'uiSession', 'uiConversation', 'locale', 'resources'], () => {})

  // Plan's history cards and full-text resources remain available in readers;
  // a ReaderDomain never declares a composer, so its mutating input seat cannot mount.
  applyPlan(ctx)
  if (ports.presentedFiles !== undefined) await installProjectPresentedFiles(ctx, ports.presentedFiles)
  if (ports.changedFiles !== undefined) await installProjectChangedFiles(ctx, ports.changedFiles)
  if (ports.mode === 'reader') {
    if (ports.selectedTools !== undefined) await installProjectNativeToolViews(ctx, ports.selectedTools, ports.mode)
    return { mode: 'reader', shortcuts: undefined, planNavigation, toolViewsInstalled: ports.selectedTools !== undefined,
    currentSessionPickersInstalled: false, presentedFilesInstalled: ports.presentedFiles !== undefined,
    changedFilesInstalled: ports.changedFiles !== undefined,
    mount: container => planNavigation.mount(container),
    mountKeyboard: () => { throw new Error('Read-only Projects domains cannot mount a keyboard owner') } }
  }

  const shortcuts = new ProjectScopedShortcuts(ctx, ports.shortcutSettings)
  ctx.provide('shortcuts', shortcuts)
  applyInputTriggers(ctx)
  await awaitNativeService(ctx, InputTriggerService, 'inputTriggers')
  applyCommands(ctx)
  await awaitNativeService(ctx, CommandUiRuntime, 'commandUi')
  applyReferences(ctx)
  applyModels(ctx)
  applyApproval(ctx)
  applyQuestions(ctx)
  await awaitNativeService(ctx, ModelDirectoryResolver, 'modelDirectories')
  if (ports.selectedTools !== undefined) await installProjectNativeToolViews(ctx, ports.selectedTools, ports.mode)
  if (ports.currentSessionPickers !== undefined) await installProjectCurrentSessionPickers(ctx, ports.currentSessionPickers)
  return { mode: 'live', shortcuts, planNavigation, toolViewsInstalled: ports.selectedTools !== undefined,
    currentSessionPickersInstalled: ports.currentSessionPickers !== undefined, presentedFilesInstalled: ports.presentedFiles !== undefined,
    changedFilesInstalled: ports.changedFiles !== undefined,
    mountKeyboard: container => shortcuts.mount(container),
    mount: container => {
      const offNavigation = planNavigation.mount(container)
      const offKeyboard = shortcuts.mount(container)
      return () => { offKeyboard(); offNavigation() }
    } }
}
