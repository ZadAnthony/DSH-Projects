/** Selected-preset views retain the original published stock plugin factories. */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyWorkflow } from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import { apply as applySubagent } from '@deepseek-ai/dsh-client-ui-subagent/client'
import { apply as applySkill } from '@deepseek-ai/dsh-client-ui-skill/client'
import { apply as applyJobController } from '@deepseek-ai/dsh-api-job-controller/client'
import { apply as applyJobs } from '@deepseek-ai/dsh-client-ui-jobs/client'
import type { ProjectNativeToolCapabilityPorts } from './contracts.ts'

export const PROJECT_NATIVE_TOOL_VIEW_EXTERNALS = Object.freeze([
  '@deepseek-ai/dsh-client-ui-workflow-run/client',
  '@deepseek-ai/dsh-client-ui-subagent/client',
  '@deepseek-ai/dsh-client-ui-skill/client',
  '@deepseek-ai/dsh-api-job-controller/client',
  '@deepseek-ai/dsh-client-ui-jobs/client',
] as const)

/**
 * The main view receives exact SessionTarget objects. Native aside navigation
 * is routed to the caller's actual child reader, rather than claiming that the
 * Plan-only popup is the stock multi-tab SidebarChatTab host.
 */
export async function installProjectNativeToolViews(ctx: Context, ports: ProjectNativeToolCapabilityPorts, mode: 'live' | 'reader'): Promise<void> {
  for (const [namespace, methods] of [['skills', ['list']], ['job', ['list', 'follow', 'kill']]] as const) {
    const remote = ports.remote[namespace]
    if (ctx.remote[namespace] !== remote) throw new Error(`Projects tool view must use the private Remote's ${namespace} namespace`)
    for (const method of methods) if (typeof (remote as unknown as Record<string, unknown>)[method] !== 'function') throw new Error(`Projects tool view requires remote.${namespace}.${method}`)
    if (ctx.get(`remote.${namespace}`) === undefined) ctx.provide(`remote.${namespace}`, remote)
  }
  if (typeof ports.uiWorkspace.openSession !== 'function') throw new Error('Projects tool views require exact SessionTarget navigation')
  if (ctx.get('uiWorkspace') === undefined) ctx.provide('uiWorkspace', ports.uiWorkspace)
  else ctx.set('uiWorkspace', ports.uiWorkspace)
  applyWorkflow(ctx)
  applySubagent(ctx)
  if (mode === 'reader') return
  if (ctx.get('inputTriggers') === undefined) throw new Error('Projects skill view requires the native input-trigger owner')
  applySkill(ctx)
  applyJobController(ctx)
  await ctx.inject(['jobs'], () => {})
  if (ctx.get('jobs') === undefined) throw new Error('Projects native jobs controller did not activate')
  applyJobs(ctx)
}
