import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectSessionPersistence } from '../../stock/persistence/index.ts'

/**
 * 在冷启动对外就绪前固定旧空 Projects 工作会话接手时的原生默认。
 * 调用者只传入来源可用的 main/execution；不枚举普通会话，不重放项目执行默认。
 * 返回当轮逐来源真实失败，由 Runtime 持有并限制该来源；失败不阻止其它来源初始化。
 */
export async function initializeExistingProjectModelSelections(
  ctx: Pick<Context, 'sessions' | 'sessionPersistence'>,
  sessionIds: readonly SessionId[],
  selection: ModelSelection,
): Promise<ReadonlyMap<SessionId, Error>> {
  const initialSelection = { ...selection }
  const failures = new Map<SessionId, Error>()
  for (const sessionId of sessionIds) {
    try {
      await initializeSource(ctx, sessionId, initialSelection)
    } catch (error) {
      failures.set(sessionId, error instanceof Error ? error : new Error(String(error), { cause: error }))
    }
  }
  return failures
}

// 每个来源独立拥有读写与关闭；资源降级实现中的错误槽也不能跨来源循环复用。
async function initializeSource(
  ctx: Pick<Context, 'sessions' | 'sessionPersistence'>,
  sessionId: SessionId,
  selection: ModelSelection,
): Promise<void> {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    if (hasModelSelection(live.snapshotEvents())) return
    throw new Error(`旧空项目会话 ${sessionId} 已由活跃会话持有，无法在冷启动接手时初始化模型。`)
  }
  // 已明确选择或已有请求的日志不取得写能力；真正写入前由原 single-writer 再核当前事件。
  if (ctx.sessionPersistence.name === 'projects-session-persistence') {
    const directory = await (ctx.sessionPersistence as ProjectSessionPersistence).recordDirectory(sessionId)
    if (directory.records.some(record => record.type === 'model/selection' || record.type === 'request/header')) return
  } else {
    await using reader = await ctx.sessionPersistence.open(sessionId, 'read')
    if (hasModelSelection((await reader.read()).events)) return
  }
  await using writer = await ctx.sessionPersistence.open(sessionId, 'write')
  const read = await writer.read()
  if (hasModelSelection(read.events)) return
  // 只追加当前配置；恢复 Session 会自动加入 end-seed，不能为初始化模型虚构恢复边界。
  const event = snapshotSessionEvent({
    type: 'model/selection',
    seq: SessionSeq(read.events.length),
    time: Date.now(),
    data: { ...selection },
  })
  await writer.append([event])
  await writer.flush()
}

function hasModelSelection(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'model/selection' || event.type === 'request/header')
}
