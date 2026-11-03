import { acquireProjectsLocale, acquireUiStyles } from '../../../client/ui/index.ts'
/** Product tool presentation for each independent Live, Reader or child graph. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ProjectsToolCard } from '../../../client/ProjectToolCard.tsx'
import { ProjectCommunicationCard, type ProjectCommunicationInjected } from '../../../client/ProjectCommunicationCard.tsx'
import type { ProjectsKey } from '../../../client/locales.ts'

export type ProjectProductCommunicationPorts = Readonly<ProjectCommunicationInjected>

export const PROJECT_PRODUCT_TOOL_NAMES = [
  'project_read', 'project_assign', 'project_create_session', 'project_send_message', 'project_history',
  'project_instructions_read', 'project_instructions_save', 'project_stop_execution',
  'project_library_list', 'project_library_add', 'project_library_open', 'project_library_remove',
  'project_overview_read', 'project_overview_put_block', 'project_overview_remove_block', 'project_overview_reorder',
  'project_memory_list', 'project_memory_read', 'project_memory_save', 'project_memory_withdraw',
] as const

export interface ProjectProductToolViewsOptions {
  /** Main product already owns its dictionary; standalone graphs register their own by default. */
  readonly registerLocale?: boolean
  /** Each standalone graph owns its namespaced styles; main product can reuse its existing sheet. */
  readonly installStyles?: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { projects: ProjectsKey }
}

/** Only tool cards and their read/navigation ports; no panel, composer, Session owner or input dock. */
export function installProjectProductToolViews(
  ctx: Context,
  communicationPorts: ProjectProductCommunicationPorts,
  options: ProjectProductToolViewsOptions = {},
): () => void {
  const disposers: (() => void)[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const failures: unknown[] = []
    for (const close of [...disposers].reverse()) { try { close() } catch (error) { failures.push(error) } }
    if (failures.length !== 0) throw new AggregateError(failures, 'Projects tool views cleanup failed')
  }
  try {
    if (options.registerLocale !== false) disposers.push(acquireProjectsLocale(ctx.locale))
    if (options.installStyles !== false) disposers.push(acquireUiStyles(document))
    for (const name of PROJECT_PRODUCT_TOOL_NAMES) {
      disposers.push(ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview', key: name, locale: 'projects', inject: () => communicationPorts,
      }, name === 'project_send_message' ? ProjectCommunicationCard : ProjectsToolCard)))
    }
    return dispose
  } catch (error) {
    try { dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Projects tool views installation and cleanup failed') }
    throw error
  }
}
