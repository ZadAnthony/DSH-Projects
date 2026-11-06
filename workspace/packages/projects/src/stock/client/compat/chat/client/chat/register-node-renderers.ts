/** Projects adaptation: waking communication uses the same saved-copy renderer as other inputs. */
import type { Context } from '@deepseek-ai/cordis'
import { createElement, type ComponentProps, type ComponentType } from 'react'
import type { InstallProjectChatOptions } from '../../../../read/install-chat.tsx'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PerformanceUsageMode } from '../../chat-settings.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import { NS, STATUS_NS } from '../locale.ts'
import { AssistantNodeView } from './AssistantNodeView.tsx'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { SystemPromptNodeView } from './SystemPromptRow.tsx'
import { TurnProcessNodeView } from './TurnProcessNodeView.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import { TurnTriggerNodeView } from './TurnTriggerNodeView.tsx'

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * Renderers whose output depends on the work-details mode receive the policy
 * through their own registration; the seat and the other renderers do not.
 * @param ctx - owning UI Conversation context.
 * @param performanceUsage - live statistics detail preference.
 * @param presentation - live presentation policy.
 */
export function registerChatNodeRenderers(
  ctx: Context,
  performanceUsage: ObservableSnapshot<PerformanceUsageMode>,
  presentation: ObservableSnapshot<ChatPresentationPolicy>,
  options: InstallProjectChatOptions,
): void {
  const communication = (Original: ComponentType<ChatNodeViewProps<any>>) => function ProjectMessage(props: ChatNodeViewProps<any>) {
    if (options.renderCommunicationMessage === undefined) return createElement(Original, props)
    const data = props.node.data as { readonly source?: unknown; readonly messageId?: string }
    return options.renderCommunicationMessage({ sessionId: props.sessionId,
      message: { source: data.source, ...(data.messageId === undefined ? {} : { messageId: data.messageId }) },
      loadImage: props.loadImage, openFile: props.openFile,
      renderOriginal: () => createElement(Original, props),
    })
  }
  const User = communication(UserMessageNodeView)
  const Context = communication(ContextMessageNodeView)
  const Assistant = (props: ComponentProps<typeof AssistantNodeView>) => createElement(AssistantNodeView, {
    ...props, replySessionLinkSource: options.replySessionLinkSource?.(props.sessionId),
  })
  // Projects-only copy stays in its own namespace, without widening the
  // native Chat locale contract shared with other plugins.
  const projectStatusText = ctx.locale.bind(STATUS_NS)
  const Trigger = communication(props => createElement(TurnTriggerNodeView, { ...props, projectStatusText }))
  const TurnError = (props: ChatNodeViewProps<'turn-error'>) => createElement(TurnErrorNodeView, { ...props, projectStatusText })
  const TurnProcess = (props: ChatNodeViewProps<'turn-process'>) => createElement(TurnProcessNodeView, { ...props, projectStatusText })

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'user', locale: NS }, User))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'steering', locale: NS }, User))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'context', locale: NS }, Context))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-trigger', locale: NS }, Trigger))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'system-prompt', locale: NS }, SystemPromptNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    locale: NS,
    inject: () => ({ hooks: { presentation } }),
  }, Assistant))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command',
    locale: NS,
    children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
  }, CommandNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'manual-compaction', locale: NS }, ManualCompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', locale: NS }, CompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'model-retry', locale: NS }, RetryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-error', locale: NS }, TurnError))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-max-tokens', locale: NS }, TurnMaxTokensNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-process', locale: NS }, TurnProcess))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-tail',
    locale: NS,
    inject: () => ({ hooks: { performanceUsage } }),
    children: {
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  }, TurnTailNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'unknown', locale: NS }, UnknownNodeView))
}
