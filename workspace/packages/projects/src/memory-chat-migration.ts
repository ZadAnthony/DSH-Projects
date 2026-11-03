/** Offline, copy-only upgrade of Projects identity, memory references and pending Bot state. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { ProjectStore } from './records.ts'
import { ProjectMemoryStore, validateSource } from './memory-store.ts'
import { upgradeMemoryBotState, writeMemoryBotState } from './memory-bot/state.ts'
import type { MemoryBotState } from './memory-bot/types.ts'
import { readNativeProjectSourceFromPrefix } from './source-reader.ts'
import type { ProjectSnapshot } from './records-types.ts'
import type { NativeEventSource, NativeProjectSource } from './source-reference-types.ts'

type JsonRecord = Record<string, unknown>
const DATA_DIRECTORIES = ['projects', 'sessions', 'attachments'] as const

/** No body, credential or external-workspace content enters a migration report. */
export interface MemoryChatMigrationFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly mode: number
}
export interface MemoryChatMigrationIssue {
  readonly path: string
  readonly kind: 'retained' | 'unavailable' | 'conflict' | 'failed'
  readonly reason: string
}
export interface MemoryChatMigrationManifest {
  readonly root: string
  readonly files: readonly MemoryChatMigrationFile[]
  readonly issues: readonly MemoryChatMigrationIssue[]
  readonly digest: string
}
export interface MemoryChatMigrationSavedSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: number
}
/** Implement with the real persistence read handle; never return synthetic interrupted-turn closers. */
export interface MemoryChatMigrationSessions {
  read(hostSessionId: string): Promise<MemoryChatMigrationSavedSession>
  close(): Promise<void>
}
export interface MemoryChatMigrationPorts {
  /** Opens only the explicitly supplied copied/source sessions directory, with no Agent or application. */
  openSessions(directory: string): Promise<MemoryChatMigrationSessions>
}
export interface MemoryChatMigrationPreflight {
  readonly manifest: MemoryChatMigrationManifest
  readonly projects: readonly { readonly projectId: string; readonly version: number; readonly sessions: number; readonly readableCarriers: number; readonly memoryFiles: number; readonly pendingRequests: number; readonly frozen: boolean }[]
  readonly issues: readonly MemoryChatMigrationIssue[]
}
export interface MemoryChatMigrationResult {
  readonly status: 'upgraded' | 'partial'
  readonly source: MemoryChatMigrationManifest
  readonly target: MemoryChatMigrationManifest
  readonly projectIds: readonly string[]
  readonly sourceConversions: readonly { readonly path: string; readonly legacy: NativeProjectSource; readonly exact: NativeEventSource }[]
  readonly issues: readonly MemoryChatMigrationIssue[]
  readonly automaticWorkStarted: false
}

/** Enumerate only owned data, refusing symlinks; profile/config/credentials and derived caches are excluded. */
export async function inspectMemoryChatData(root: string): Promise<MemoryChatMigrationManifest> {
  const actual = await dataRoot(root)
  const files: MemoryChatMigrationFile[] = [], issues: MemoryChatMigrationIssue[] = []
  const walk = async (path: string): Promise<void> => {
    const local = relative(actual, path), info = await lstat(path)
    if (info.isSymbolicLink()) { issues.push({ path: local, kind: 'conflict', reason: 'A data symlink is retained in the source and is not followed or copied.' }); return }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name))
      return
    }
    if (!info.isFile()) { issues.push({ path: local, kind: 'conflict', reason: 'Unsupported data entry; source remains unchanged.' }); return }
    files.push({ path: local, bytes: info.size, sha256: await fileDigest(path), mode: info.mode & 0o777 })
  }
  for (const directory of DATA_DIRECTORIES) {
    const path = join(actual, directory)
    if (await exists(path)) await walk(path)
  }
  return { root: actual, files, issues, digest: manifestDigest(files) }
}

/** Validate current owners and canonical logs without creating directories, repairing tails or changing state. */
export async function preflightMemoryChatMigration(root: string, ports: MemoryChatMigrationPorts): Promise<MemoryChatMigrationPreflight> {
  const manifest = await inspectMemoryChatData(root), issues = [...manifest.issues]
  const projects: Array<MemoryChatMigrationPreflight['projects'][number]> = []
  const projectRoot = join(manifest.root, 'projects')
  if (!await exists(projectRoot)) return { manifest, projects, issues }
  const projectInfo = await lstat(projectRoot)
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) return { manifest, projects, issues }
  const store = new ProjectStore(projectRoot), sessions = await openSessions(manifest.root, ports)
  const hosts = new Set<string>()
  try {
    for (const projectId of await projectIds(projectRoot)) {
      const recordPath = join('projects', projectId, 'record.json')
      try {
        const raw = record(await readJson(join(manifest.root, recordPath)))
        if (raw.version === 12 && raw.terminal === true) issues.push({ path: recordPath, kind: 'retained', reason: 'Legacy terminal per-carrier times are unknown; the relation owner retains lifecycleTimeBasis=project-deletion.' })
        const snapshot = await store.getSnapshot(projectId)
        let readableCarriers = 0
        for (const session of snapshot.sessions) for (const carrier of session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle }]) {
          if (hosts.has(carrier.hostSessionId)) issues.push({ path: recordPath, kind: 'conflict', reason: 'A native Session is claimed by more than one carrier.' })
          hosts.add(carrier.hostSessionId)
          if (carrier.sourceLifecycle.kind === 'deleted') {
            issues.push({ path: recordPath, kind: 'retained', reason: 'A legitimately deleted carrier remains a source identity; its content is not reopened.' })
            continue
          }
          try { await sessions.read(carrier.hostSessionId); readableCarriers += 1 }
          catch (error) { issues.push({ path: recordPath, kind: 'unavailable', reason: `Canonical native Session ${carrier.hostSessionId} is unreadable: ${message(error)}` }) }
        }
        const memory = await new ProjectMemoryStore(projectId, join(projectRoot, projectId)).readAll()
        issues.push(...memory.snapshot.issues.map(issue => ({ path: join('projects', projectId, issue.path), kind: 'retained' as const, reason: issue.message })))
        const botPath = join(projectRoot, projectId, 'memory', '.bot-state.json')
        const bot = await exists(botPath) ? record(await readJson(botPath)) : undefined
        projects.push({ projectId, version: number(raw.version), sessions: snapshot.sessions.length, readableCarriers,
          memoryFiles: memory.memories.length, pendingRequests: Array.isArray(bot?.requests) ? bot.requests.length : 0,
          frozen: bot?.frozen !== undefined || Array.isArray(bot?.pendingBatches) && bot.pendingBatches.length > 0 })
      } catch (error) { issues.push({ path: recordPath, kind: 'failed', reason: message(error) }) }
    }
  } finally { await sessions.close() }
  return { manifest, projects, issues }
}

/** Copy into an absent explicit root and upgrade there; originals and failed/pending work remain untouched. */
export async function upgradeMemoryChatCopy(input: { readonly sourceRoot: string; readonly targetRoot: string }, ports: MemoryChatMigrationPorts): Promise<MemoryChatMigrationResult> {
  const preflight = await preflightMemoryChatMigration(input.sourceRoot, ports), source = preflight.manifest
  await copyData(source, input.targetRoot)
  const targetRoot = await dataRoot(input.targetRoot), projectRoot = join(targetRoot, 'projects')
  const store = new ProjectStore(projectRoot), issues = [...preflight.issues], projectResults: string[] = []
  const sourceConversions: Array<MemoryChatMigrationResult['sourceConversions'][number]> = []
  const sessions = await openSessions(targetRoot, ports)
  try {
    if (await exists(projectRoot)) for (const projectId of await projectIds(projectRoot)) {
      const path = join('projects', projectId)
      try {
        const snapshot = await store.upgradeCarrierRelations(projectId)
        projectResults.push(projectId)
        const directory = join(projectRoot, projectId), memoryDirectory = join(directory, 'memory')
        if (!await exists(memoryDirectory)) continue
        const resolveSource = async (raw: unknown, file: string): Promise<unknown> => {
          const sourceValue = validateSource(raw)
          if (sourceValue.kind !== 'message' && sourceValue.kind !== 'tool' && sourceValue.kind !== 'native-event') return raw
          const owner = carrierOwner(snapshot, sourceValue.hostSessionId)
          if (owner === undefined) { issues.push({ path: file, kind: 'unavailable', reason: 'Memory source has no retained carrier in this Project; original locator retained.' }); return raw }
          const lifecycle = owner.carriers?.find(carrier => carrier.hostSessionId === sourceValue.hostSessionId)?.sourceLifecycle ?? owner.sourceLifecycle
          if (lifecycle.kind !== 'available') {
            issues.push({ path: file, kind: lifecycle.kind === 'deleted' ? 'retained' : 'unavailable', reason: 'Source lifecycle prohibits reopening content; original locator retained without resurrection.' })
            return raw
          }
          try {
            const saved = await sessions.read(sourceValue.hostSessionId)
            const read = readNativeProjectSourceFromPrefix({ readable: true, header: saved.header, projectId, sessionId: owner.id, formatVersion: saved.header.version,
              hostSessionId: sourceValue.hostSessionId, sourceRevision: owner.revision, events: saved.events, endSeq: saved.events.length - 1,
              source: 'prepared', sessionCreatedAt: saved.header.createdAt, inheritedEventCount: saved.inheritedEventCount }, sourceValue, { before: 0, after: 0 })
            const targets = read.items.filter(item => item.isTarget)
            const exact = targets.length === 1 ? targets[0]?.nativeSource : undefined
            if (!read.resolved || exact?.kind !== 'native-event') {
              issues.push({ path: file, kind: 'retained', reason: `No unique exact source: ${read.reason ?? 'The reader did not return one canonical event.'}` }); return raw
            }
            // A precise existing source may include a body stream/range; validation never replaces it with a shorter minted reference.
            if (sourceValue.kind === 'native-event') return raw
            sourceConversions.push({ path: file, legacy: sourceValue, exact })
            return exact
          } catch (error) { issues.push({ path: file, kind: 'unavailable', reason: `Original source retained: ${message(error)}` }); return raw }
        }
        for (const name of (await readdir(memoryDirectory)).sort()) {
          if ((!name.endsWith('.md') || name === 'index.md') && name !== '.withdrawn.json') continue
          const file = join(path, 'memory', name), absolute = join(targetRoot, file)
          try {
            const original = await readRegularText(absolute)
            let updated: string
            if (name === '.withdrawn.json') {
              const value = record(JSON.parse(original))
              if (!Array.isArray(value.withdrawals)) throw new Error('Withdrawal marker has no withdrawals array.')
              for (const item of value.withdrawals) await mapSources(record(item), resolveSource, file)
              updated = JSON.stringify(value, null, 2) + '\n'
            } else {
              const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n[\s\S]*)$/.exec(original)
              if (match === null) throw new Error('Memory front matter is unreadable; bytes retained.')
              const metadata = record(JSON.parse(match[2]!))
              if (metadata.projectId !== projectId || metadata.version !== 1) throw new Error('Memory project/format mismatch; bytes retained.')
              await mapSources(metadata, resolveSource, file)
              updated = match[1]! + JSON.stringify(metadata, null, 2) + match[3]!
            }
            if (updated !== original) await replaceFile(absolute, updated)
          } catch (error) { issues.push({ path: file, kind: 'failed', reason: message(error) }) }
        }
        const memory = await new ProjectMemoryStore(projectId, directory).readAll()
        const bodyIssues = memory.snapshot.issues.filter(issue => issue.path !== 'memory/index.md')
        if (bodyIssues.length === 0) await replaceFile(join(memoryDirectory, 'index.md'), memory.snapshot.index)
        else issues.push(...bodyIssues.map(issue => ({ path: join(path, issue.path), kind: 'failed' as const, reason: issue.message })))
        const botPath = join(memoryDirectory, '.bot-state.json')
        if (await exists(botPath)) {
          // The Bot owner validates/migrates structure; no request is attempted and no processed cut is advanced here.
          const value: MemoryBotState = JSON.parse(await readRegularText(botPath))
          if (value.projectId !== projectId) throw new Error('Bot state project identity differs from the copied Project.')
          await writeMemoryBotState(directory, upgradeMemoryBotState(value))
        }
      } catch (error) { issues.push({ path, kind: 'failed', reason: message(error) }) }
    }
  } finally { await sessions.close() }
  const afterSource = await inspectMemoryChatData(source.root)
  if (afterSource.digest !== source.digest) issues.push({ path: '', kind: 'conflict', reason: 'Source changed during offline migration; target must remain offline.' })
  const target = await inspectMemoryChatData(targetRoot)
  return { status: issues.some(issue => issue.kind !== 'retained') ? 'partial' : 'upgraded', source, target, projectIds: projectResults,
    sourceConversions, issues, automaticWorkStarted: false }
}

/** Compare the post-upgrade baseline with current data; changed/new data prohibits replacing it with the old copy. */
export async function inspectMemoryChatRecovery(baseline: MemoryChatMigrationManifest, currentRoot: string): Promise<{ readonly kind: 'no-new-data' | 'preserve-new-data'; readonly current: MemoryChatMigrationManifest; readonly changedPaths: readonly string[] }> {
  const current = await inspectMemoryChatData(currentRoot), before = new Map(baseline.files.map(file => [file.path, file.sha256])), after = new Map(current.files.map(file => [file.path, file.sha256]))
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
  return { kind: changedPaths.length === 0 && current.issues.length === 0 ? 'no-new-data' : 'preserve-new-data', current, changedPaths }
}

/** Preserve all upgrade-era data in another absent root; never overwrite a baseline or perform a lossy downgrade. */
export async function preserveMemoryChatRecoveryCopy(input: { readonly currentRoot: string; readonly targetRoot: string }): Promise<MemoryChatMigrationManifest> {
  const current = await inspectMemoryChatData(input.currentRoot)
  if (current.issues.length > 0) throw new Error('Recovery copy cannot certify all data entries; current data remains retained in place.')
  await copyData(current, input.targetRoot)
  return inspectMemoryChatData(input.targetRoot)
}

async function copyData(source: MemoryChatMigrationManifest, target: string): Promise<void> {
  if (!isAbsolute(target)) throw new Error('An explicit absolute target data root is required.')
  const parent = await realpath(dirname(target)), actual = join(parent, relative(dirname(resolve(target)), resolve(target)))
  if (actual === source.root || actual.startsWith(source.root + sep) || source.root.startsWith(actual + sep)) throw new Error('Source and target data roots must be independent.')
  await mkdir(actual) // Existing targets are never overwritten or merged.
  try {
    for (const file of source.files) {
      const from = join(source.root, file.path), to = join(actual, file.path)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to, constants.COPYFILE_EXCL)
      await chmod(to, file.mode)
      const [left, right] = await Promise.all([lstat(from), lstat(to)])
      if (left.dev === right.dev && left.ino === right.ino || right.nlink !== 1 || await fileDigest(to) !== file.sha256) throw new Error('Copied data did not retain independent exact bytes.')
    }
  } catch (error) { throw new Error(`Copy is incomplete and remains offline at ${actual}: ${message(error)}`, { cause: error }) }
}
async function mapSources(value: JsonRecord, transform: (raw: unknown, path: string) => Promise<unknown>, path: string): Promise<void> {
  for (const key of ['sources', 'originSources']) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key])) throw new Error(`${key} is not an array.`)
    value[key] = await Promise.all(value[key].map(source => transform(source, path)))
  }
  if (value.reconfirmedBy !== undefined) value.reconfirmedBy = await transform(value.reconfirmedBy, path)
}
function carrierOwner(snapshot: ProjectSnapshot, host: string) {
  return snapshot.sessions.find(session => session.hostSessionId === host || session.carriers?.some(carrier => carrier.hostSessionId === host))
}
async function projectIds(root: string): Promise<string[]> { return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() }
async function openSessions(root: string, ports: MemoryChatMigrationPorts): Promise<MemoryChatMigrationSessions> {
  const path = join(root, 'sessions')
  if (await exists(path)) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session data must be a real directory; links are not followed.') }
  return ports.openSessions(path)
}
async function dataRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('An explicit absolute data root is required.')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Data root must be an existing real directory.')
  return realpath(path)
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function readRegularText(path: string): Promise<string> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Migration reads only regular owned files.'); return readFile(path, 'utf8') }
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readRegularText(path)) }
function record(value: unknown): JsonRecord { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.'); return value as JsonRecord }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Expected an integer format version.'); return value }
function message(error: unknown): string { return error instanceof SyntaxError ? 'Invalid JSON; original bytes retained.' : error instanceof Error ? error.message : String(error) }
async function fileDigest(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
function manifestDigest(files: readonly MemoryChatMigrationFile[]): string { return createHash('sha256').update(JSON.stringify(files)).digest('hex') }
async function replaceFile(path: string, content: string): Promise<void> {
  if (await exists(path)) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Migration writes only regular copied files.')
    if (await readFile(path, 'utf8') === content) return
  }
  const temporary = path + '.' + randomUUID() + '.tmp'
  try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
