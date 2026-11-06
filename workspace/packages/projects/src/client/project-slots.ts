import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ProjectsKey } from './locales.ts'
import type { ProjectCommunicationMessagePresentation } from './ProjectCommunicationCard.tsx'

// 当前产品装配与独立组件类型检查共用；不挂载旧前端入口。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { projects: ProjectsKey }
  interface SlotMap {
    'projects.main.conversation': { kind: 'single'; scope: 'session'; owner: { focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined } }
    'projects.execution.conversation': { kind: 'single'; scope: 'session'; owner: { focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined } }
    'projects.main.model': { kind: 'single'; scope: 'session' }
    'projects.communication.message': { kind: 'single'; scope: 'session'; owner: ProjectCommunicationMessagePresentation }
  }
}
