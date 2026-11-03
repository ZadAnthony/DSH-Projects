import type { Context } from '@deepseek-ai/cordis'
import { Fragment, useEffect, useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, PropsRenderSlots, SlotComponent, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

export const WORKSPACE_DIRECTORY_FLOW_SLOT = 'projects.workspace.directoryFlow'
const SOURCES = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'] as const

/** Fixed rc.3 directory-flow owner share; adoption belongs to the Projects form. */
interface DirectoryFlowOwner {
  open: boolean
  busy: boolean
  onPicked(path: string): void
  onCancel(): void
  onError(message: string): void
}
interface DirectoryFlowRequest {
  readonly id: number
  readonly owner: DirectoryFlowOwner
}
interface Source {
  readonly key: typeof SOURCES[number]
  readonly entry: StoredEntry
}
interface Pending {
  readonly source: Source
  readonly promise: Promise<string | null>
  resolve(path: string | null): void
  reject(error: unknown): void
}
export interface WorkspaceDirectoryFlowPort {
  readonly request: HostObservable<DirectoryFlowRequest | undefined>
  pick(): Promise<string | null>
  dismiss(): void
  dispose(): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'projects.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwner }
  }
}

/**
 * rc.3 compatibility seam: reuse only the two installed directory occupants,
 * through the real renderer and their original inject faces. Their childless,
 * storeless root registrations are the supported boundary, not a clone API.
 */
export function createWorkspaceDirectoryFlow(ctx: Context): WorkspaceDirectoryFlowPort {
  const slots = ctx.slots
  const request = createSnapshotStore<DirectoryFlowRequest | undefined>(undefined)
  let sequence = 0
  let pending: Pending | undefined
  let source: Source | undefined
  let removeEntry: (() => void) | undefined
  let unavailable: unknown = new Error('Workspace directory chooser is unavailable')
  let disposed = false
  let reconcile = (): void => {}
  const current = (candidate: Source): boolean => slots.entriesOfSlot(candidate.key)[0] === candidate.entry
  const finish = (expected: Pending | undefined, result: { value: string | null } | { error: unknown }): void => {
    if (expected === undefined || pending !== expected) return
    pending = undefined
    request.set(undefined)
    if ('error' in result) expected.reject(result.error); else expected.resolve(result.value)
  }
  const withdraw = (): void => finish(pending, { error: new DOMException('Workspace directory chooser closed', 'AbortError') })
  const releaseEntry = (): void => {
    finish(pending, { error: new Error('Workspace directory chooser changed or unloaded') })
    removeEntry?.()
    removeEntry = undefined
    source = undefined
  }
  const stopTarget = slots.inject(WORKSPACE_DIRECTORY_FLOW_SLOT, () => {
    const sync = (): void => {
      if (disposed) return
      const next = source !== undefined && current(source) ? source : SOURCES.flatMap(key => {
        const entry = slots.entriesOfSlot(key)[0]
        return entry === undefined ? [] : [{ key, entry }]
      })[0]
      if (source?.entry === next?.entry && source?.key === next?.key) return
      releaseEntry()
      unavailable = new Error('Workspace directory chooser is unavailable')
      if (next === undefined) return
      const spec = slots.spec(next.key)
      const entry = next.entry
      if (spec?.kind !== 'single' || spec.scope !== 'root' || typeof entry.component !== 'function'
        || typeof entry.inject !== 'function' || Object.keys(entry.children ?? {}).length !== 0
        || entry.store !== undefined || entry.locale !== undefined || entry.select !== undefined) {
        unavailable = new Error(`Unsupported workspace directory flow registration: ${next.key}`)
        return
      }
      // The public ledger erases these types. Original registration already
      // proves its injected face; only the exact shared owner props are reused.
      removeEntry = slots.register({ name: WORKSPACE_DIRECTORY_FLOW_SLOT, inject: entry.inject }, entry.component as SlotComponent<DirectoryFlowOwner>)
      source = next
    }
    reconcile = sync
    const stops = SOURCES.map(key => slots.subscribe(key, sync))
    stops.push(slots.onEntryError((key, _entry, error) => {
      if (key !== WORKSPACE_DIRECTORY_FLOW_SLOT) return
      unavailable = error
      finish(pending, { error })
    }))
    sync()
    return () => {
      if (reconcile === sync) reconcile = () => {}
      for (const stop of stops) stop()
      releaseEntry()
    }
  })
  const port: WorkspaceDirectoryFlowPort = {
    request,
    pick: () => {
      if (disposed) return Promise.reject(new DOMException('Workspace directory chooser closed', 'AbortError'))
      reconcile()
      if (source === undefined || slots.entriesOfSlot(WORKSPACE_DIRECTORY_FLOW_SLOT).length === 0) return Promise.reject(unavailable)
      if (pending !== undefined) return pending.promise
      const selected = source
      let resolve!: Pending['resolve']
      let reject!: Pending['reject']
      const promise = new Promise<string | null>((accept, refuse) => { resolve = accept; reject = refuse })
      const active: Pending = { source: selected, promise, resolve, reject }
      pending = active
      const settle = (result: { value: string | null } | { error: unknown }): void => {
        if (!current(selected)) { finish(active, { error: new Error('Workspace directory chooser changed or unloaded') }); return }
        finish(active, result)
      }
      request.set({ id: ++sequence, owner: { open: true, busy: false,
        onPicked: path => settle({ value: path }), onCancel: () => settle({ value: null }),
        onError: message => settle({ error: new Error(message) }),
      } })
      return promise
    },
    dismiss: withdraw,
    dispose: () => { if (disposed) return; disposed = true; withdraw(); stopTarget() },
  }
  ctx.effect(() => () => port.dispose(), 'Projects workspace directory flow')
  return port
}

/** One keyed occurrence per request; a late native callback cannot reach its successor. */
export function WorkspaceDirectoryFlow({ flow, renderSlot }: { readonly flow: WorkspaceDirectoryFlowPort } & Pick<PropsRenderSlots<typeof WORKSPACE_DIRECTORY_FLOW_SLOT>, 'renderSlot'>) {
  const request = useSyncExternalStore(flow.request.subscribe, flow.request.getSnapshot)
  useEffect(() => () => flow.dismiss(), [flow])
  return request === undefined ? null : <Fragment key={request.id}>{renderSlot(WORKSPACE_DIRECTORY_FLOW_SLOT, request.owner)}</Fragment>
}
