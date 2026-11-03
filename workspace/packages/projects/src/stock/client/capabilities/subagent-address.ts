/* MIT. Adapted from deepseek-ai/deepseek-harness 639ed015397290b3745d163aafe02ffee4aa3f84, packages/client/ui-subagent/src/client/sidebar-chat/index.tsx (address codec only). */
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Decode the complete native routing identity; mode is never inferred from a parent id. */
export function parseProjectSubagentChatAddress(value: string): SubagentAddress | undefined {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagentchat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  const parentSessionId = url.searchParams.get('parent')
  const mode = url.searchParams.get('mode')
  if (parentSessionId === null || parentSessionId === '' || (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'unknown')) return undefined
  try {
    const childSessionId = decodeURIComponent(parts[1]!)
    if (childSessionId === '') return undefined
    return { parentSessionId: parentSessionId as SessionId, childSessionId: childSessionId as SessionId, mode }
  } catch { return undefined }
}
