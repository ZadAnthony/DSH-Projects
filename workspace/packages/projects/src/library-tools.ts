import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { NativeProjectSource } from './source-reader.ts'
import type { LibraryFileLocation, LibraryOpenResult, LibrarySessionRequest } from './library-contract.ts'
import type { LibraryService } from './library-service.ts'
import { ToolReadPager } from './tool-read-pages.ts'
import { durableMutationDetails } from './metadata-files.ts'

export interface LibraryToolBindings {
  readonly service: LibraryService
  readonly resolveRequest: (exec: ToolRunContext) => Promise<LibrarySessionRequest>
  readonly sourceForCall: (exec: ToolRunContext) => Promise<NativeProjectSource>
}

function output() {
  return { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

export function installLibraryTools(agent: Agent, bindings: LibraryToolBindings): () => void {
  const pager = new ToolReadPager(agent)
  const disposers: Array<() => unknown> = [() => pager.clear()]
  const mutationReturns = new WeakMap<object, JsonValue>()
  const run = async (exec: ToolRunContext, operation: (request: LibrarySessionRequest) => Promise<unknown>): Promise<JsonValue> => {
    try {
      exec.signal.throwIfAborted()
      const request = await bindings.resolveRequest(exec)
      exec.signal.throwIfAborted()
      return await operation(request) as JsonValue
    }
    catch (error) {
      const detail = durableMutationDetails(error)
      if (detail !== undefined && detail.effect !== 'none') return { kind: 'unknown', ...detail }
      throw error
    }
  }
  const mutate = async (exec: ToolRunContext, operation: (request: LibrarySessionRequest) => Promise<unknown>): Promise<JsonValue> => {
    const value = await run(exec, operation)
    mutationReturns.set(exec, value)
    return value
  }
  const finalizeMutation = (operation: 'add' | 'remove'): NonNullable<ToolDefinition['finalizeContent']> => (exec, result) => {
    const value = mutationReturns.get(exec)
    mutationReturns.delete(exec)
    if (!result.isError) return undefined
    const unknown = value !== null && typeof value === 'object' && !Array.isArray(value) && value.kind === 'unknown'
    return [...result.content, { type: 'text', text: JSON.stringify({ library_mutation: {
      operation, status: value === undefined ? 'unconfirmed' : unknown ? 'unknown' : 'saved',
      ...value === undefined ? {} : { result: value },
      notice: value === undefined
        ? 'No completed Library save result was obtained. Cancellation or tool failure does not prove the reference is unchanged. Read current references before an explicit follow-up; do not automatically repeat the mutation.'
        : unknown
          ? 'The Library save returned an unconfirmed outcome. Preserve its actual effect and saving boundary; read current references before an explicit follow-up and do not automatically repeat the mutation.'
          : 'This Library reference change was saved before the tool result settled. The current run is interrupted or failed; this saved change was not rolled back.',
    } }) }]
  }
  try {
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'project_library_list',
      description: 'Browse the current Project file directory and explicit external references. Project files are visible without registration. Each part reports its real read errors separately. This reads no work, result, review or recognition records.',
      parameters: { directory: { type: 'string', description: 'Relative Project file directory; omitted or empty means its root. Lists one directory layer.' } }, output: output(),
      execute: (args, exec) => run(exec, request => bindings.service.list({ ...request, directory: args.directory }, exec.signal)),
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'project_library_add',
      description: 'Add an actual file, directory or http/https reference without moving or copying it. Project files need no registration to appear. Use ordinary DSH tools for file edits and chat for reports or feedback. Adding a reference neither creates nor checks the original, and sends no message. A result with kind:"unknown" means the reference may already be published but saving is unconfirmed; read current references before an explicit follow-up and do not automatically repeat the add.',
      parameters: {
        name: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['file', 'directory', 'url'] },
        location: { type: 'string', required: true, description: 'Actual path in this session execution world, or http/https URL.' },
        description: { type: 'string' },
      }, output: output(),
      execute: (args, exec) => mutate(exec, async request => {
        const source = await bindings.sourceForCall(exec)
        exec.signal.throwIfAborted()
        return bindings.service.add({
          ...request, name: args.name, description: args.description,
          target: args.kind === 'url' ? { kind: 'url', url: args.location } : { kind: args.kind, path: args.location },
          sources: [source],
        }, exec.signal)
      }),
      finalizeContent: finalizeMutation('add'),
    })))
    disposers.push(agent.ctx.tools.register(pager.wrap(defineTool({
      name: 'project_library_open',
      description: 'Read current actual content using either project_relative_path or entry_id, never both. Empty project_relative_path opens the Project file root. Missing/denied originals report failure without an old copy. URLs are references with availability not checked; binary files expose metadata rather than base64 to the model.',
      parameters: { project_relative_path: { type: 'string' }, entry_id: { type: 'string' } }, output: output(),
      execute: (args, exec) => run(exec, async request => {
        if ((args.entry_id === undefined) === (args.project_relative_path === undefined)) throw new Error('Specify exactly one Library file location')
        const location: LibraryFileLocation = args.entry_id === undefined
          ? { kind: 'project-file', relativePath: args.project_relative_path! }
          : { kind: 'reference', entryId: args.entry_id }
        return modelContent(await bindings.service.open({ ...request, location }, exec.signal))
      }),
    }), { textField: 'text' })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'project_library_remove',
      description: 'Remove only the explicit reference entry. Retain the actual original; a Project file remains visible in its directory. Does not notify another session. A result with kind:"unknown" means removal may already be visible but saving is unconfirmed; read current references before an explicit follow-up and do not automatically repeat the removal.',
      parameters: { entry_id: { type: 'string', required: true } }, output: output(),
      execute: (args, exec) => mutate(exec, async request => {
        await bindings.service.remove({ ...request, entryId: args.entry_id }, exec.signal)
        return { removedEntryId: args.entry_id, originalRetained: true }
      }),
      finalizeContent: finalizeMutation('remove'),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function modelContent(value: LibraryOpenResult): unknown {
  if (value.status !== 'file') return value
  const { base64, ...metadata } = value
  if (!value.mediaType.startsWith('text/') && !['application/json', 'image/svg+xml'].includes(value.mediaType)) return { ...metadata, content: 'binary', previewAvailable: true }
  try {
    const data = Buffer.from(base64, 'base64')
    if (data.includes(0)) return { ...metadata, content: 'binary', previewAvailable: true }
    return { ...metadata, content: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
  } catch { return { ...metadata, content: 'binary', previewAvailable: true } }
}
