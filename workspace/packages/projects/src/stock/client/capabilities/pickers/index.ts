/** Current-session surfaces extracted from the stock plugins; no global Settings writer. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assertCurrentBinding, type ProjectCurrentSessionPickerPorts } from './contracts.ts'
import { PermissionCatalogDirectory } from './permission/catalog.ts'
import { PermissionSelect, type PermissionSelectInjected } from './permission/PermissionSelect.tsx'
import { accessEn, accessZh, PERMISSION_ACCESS_NS } from './permission/locales.ts'
import { permissionOptions } from './permission/options.ts'
import { AgentPresetSettingsController } from './agent/settings-store.ts'
import { AgentPresetSeatController } from './agent/seat-store.ts'
import type { AgentPresetSeatInjected } from './agent/AgentPresetSeat.tsx'
import { BoundAgentPresetSeat, type BoundAgentPresetSeatInjected } from './agent/BoundAgentPresetSeat.tsx'
import { AgentPresetLabel, type AgentPresetLabelInjected } from './agent/AgentPresetLabel.tsx'
import { en, zh, type AgentPresetSettingsKey } from './agent/locales.ts'

export type { ProjectCurrentSessionPickerPorts } from './contracts.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'permission.access': keyof typeof accessEn
    'settings.agentPreset': AgentPresetSettingsKey
  }
}

function selectionOf(binding: SessionBinding | undefined): PermissionSelection | undefined {
  return binding?.session.projections.faceOf('permissions').getSnapshot() as PermissionSelection | undefined
}

/** A permission click owns its original SessionFace, including across the RPC await. */
export async function submitProjectPermission(ctx: Context, binding: SessionBinding, preset: string): Promise<boolean> {
  assertCurrentBinding(ctx, binding)
  const result = await binding.session.command(`/permission ${preset}`)
  if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
  if (!result.value.matched) throw new Error('the host offers no /permission command')
  return true
}

export interface ProjectCurrentSessionPickers {
  readonly permissionCatalog: PermissionCatalogDirectory
  readonly agentRoster: AgentPresetSettingsController
  dispose(): void
}

/** Install after native Commands, Renderer, Locale and the private ISessions are ready. */
export async function installProjectCurrentSessionPickers(ctx: Context, ports: ProjectCurrentSessionPickerPorts): Promise<ProjectCurrentSessionPickers> {
  const command = ctx.get('commandUi') as CommandUiContract | undefined
  if (command === undefined) throw new Error('Projects current-session pickers require native commandUi')
  for (const [owner, method] of [[ports.permissionPresets, 'catalog'], [ports.agentPresets, 'list'], [ports.agentPresets, 'select'], [ports.developerTools, 'getSnapshot'], [ports.developerTools, 'subscribe']] as const) {
    if (typeof owner?.[method as keyof typeof owner] !== 'function') throw new Error(`Projects current-session picker port missing ${method}`)
  }
  await ctx.inject(['slots', 'sessions', 'locale'], () => {})
  const disposers: (() => void)[] = []
  const seats = new Map<SessionBinding, AgentPresetSeatController>()
  let disposed = false
  const catalog = new PermissionCatalogDirectory(ctx, ports.permissionPresets)
  const roster = new AgentPresetSettingsController(ports.agentPresets)
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const off of disposers.reverse()) off()
    for (const seat of seats.values()) seat.dispose()
    seats.clear(); roster.dispose(); catalog.dispose()
  }
  ctx.effect(() => dispose, 'Projects current-session pickers')
  disposers.push(ctx.locale.register(PERMISSION_ACCESS_NS, { en: accessEn, zh: accessZh }))
  disposers.push(ctx.locale.register('settings.agentPreset', { en, zh }))
  const t = ctx.locale.bind(PERMISSION_ACCESS_NS)
  disposers.push(catalog.invalidations.subscribe(() => { command.dismiss('permission') }))
  // Each rendered native option is an unforgeable lease to the opening's binding.
  const optionBindings = new WeakMap<SelectOption, SessionBinding>()
  disposers.push(command.decorate({ name: 'permission',
    available: session => selectionOf(ctx.sessions.binding(session.sessionId)) !== undefined,
    ui: { kind: 'popupSelect',
      options: async (session, signal) => {
        const binding = ctx.sessions.binding(session.sessionId)
        const selection = selectionOf(binding)
        if (binding === undefined || selection === undefined) throw new Error('permission presets are not available on this host')
        const value = await catalog.load()
        signal.throwIfAborted()
        assertCurrentBinding(ctx, binding)
        const options = permissionOptions(value, selection.currentValue, t)
        for (const option of options) optionBindings.set(option, binding)
        return options
      },
      onSelect: (option, session) => {
        const binding = optionBindings.get(option)
        if (binding === undefined || binding.sessionId !== session.sessionId) throw new Error('PROJECT_PERMISSION_PICKER_LEASE_MISSING')
        return submitProjectPermission(ctx, binding, option.id).then(() => {})
      },
    },
  }))
  disposers.push(ctx.slots.register({ name: 'conversation.input.permission', locale: PERMISSION_ACCESS_NS,
    inject: (sessionId: SessionId): PermissionSelectInjected => {
      const binding = ctx.sessions.binding(sessionId)
      return { hooks: { permissionCatalog: catalog.store }, select: preset => {
        if (binding === undefined) return Promise.reject(new Error('this session is not materialized yet'))
        return submitProjectPermission(ctx, binding, preset)
      } }
    },
  }, PermissionSelect))
  const seatFor = (binding: SessionBinding): AgentPresetSeatController => {
    let seat = seats.get(binding)
    if (seat === undefined) {
      seat = new AgentPresetSeatController(ctx, binding, ports, roster)
      seats.set(binding, seat); seat.refresh()
    }
    return seat
  }
  const refreshSeats = (): void => {
    for (const [binding, seat] of seats) {
      if (ctx.sessions.binding(binding.sessionId) !== binding) { seat.dispose(); seats.delete(binding) }
      else seat.refresh()
    }
  }
  disposers.push(ctx.sessions.list.subscribe(refreshSeats), roster.store.subscribe(refreshSeats))
  const refreshRoster = (): void => { roster.invalidate(); void roster.load() }
  disposers.push(ctx.remote.$on('settings/document-updated', ns => { if (ns === 'agent-preset-registry') refreshRoster() }))
  disposers.push(ctx.remote.$on('agent-preset/selected', () => { refreshRoster() }))
  // Clear stale roster immediately when the actual Host connection generation changes.
  const connection = ctx.get('connection') as import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle
  let generation = connection.generation.getSnapshot()?.id
  disposers.push(connection.generation.subscribe(() => {
    const next = connection.generation.getSnapshot()?.id
    if (next === generation) return
    generation = next
    roster.invalidate()
    if (next !== undefined) void roster.load()
  }))
  disposers.push(ctx.slots.register({ name: 'conversation.hero.agentPreset', locale: 'settings.agentPreset',
    inject: (sessionId: SessionId | undefined): BoundAgentPresetSeatInjected => {
      const binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
      // Projects already owns a retained blank Session; there is no unbound staging path.
      if (binding === undefined) return { bound: false, hooks: { developerTools: ports.developerTools, agentPresetSeat: UNBOUND_SEAT }, load: async () => { throw new Error('No retained blank session') }, select: async () => { throw new Error('No retained blank session') }, introduced: () => { throw new Error('No retained blank session') } }
      const seat = seatFor(binding)
      return { bound: true, hooks: { developerTools: ports.developerTools, agentPresetSeat: seat.store },
        isProjectPaneCurrent: () => ports.isProjectPaneCurrent?.(binding) === true,
        load: () => seat.load(), select: id => seat.select(id), introduced: () => seat.introduced() }
    },
  }, BoundAgentPresetSeat))
  disposers.push(ctx.slots.register({ name: 'conversation.session.header.actions', id: 'agent-preset', order: -10, locale: 'settings.agentPreset',
    inject: (): AgentPresetLabelInjected => ({ hooks: { agentPresets: roster.store }, load: () => roster.load() }),
  }, AgentPresetLabel))
  return { permissionCatalog: catalog, agentRoster: roster, dispose }
}

// The wrapper never renders the native seat for this value. Accidental operations reject.
const UNBOUND_SEAT: AgentPresetSeatInjected['hooks']['agentPresetSeat'] = createSnapshotStore({ options: [], current: '', error: null, busy: false, introduce: false })
