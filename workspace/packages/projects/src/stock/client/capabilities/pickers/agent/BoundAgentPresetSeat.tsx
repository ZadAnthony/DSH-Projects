/** Projects has no unbound new-session stage; the native seat mounts only for a binding. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentPresetSeat, type AgentPresetSeatInjected } from './AgentPresetSeat.tsx'

export type BoundAgentPresetSeatInjected = AgentPresetSeatInjected & { readonly bound: boolean }
type Props = PropsRuntime<'conversation.hero.agentPreset'> & PropsLocale<'settings.agentPreset'> & InjectFace<BoundAgentPresetSeatInjected>
export function BoundAgentPresetSeat(props: Props) {
  if (!props.bound) return null
  return <AgentPresetSeat {...props} />
}
