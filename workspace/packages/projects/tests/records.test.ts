import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Session as InspectorSession } from "node:inspector/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/records.ts";
import { durableMutationDetails } from "../src/metadata-files.ts";
import type { ProjectSession, SessionCleanupProgress, SessionOwnedLifecycle, SessionOwnedSessionHeader } from "../src/records-types.ts";
import { canonicalSendArgs, operationReference } from "../src/communication/contract.ts";
import type { CommunicationInvocationSource } from "../src/communication/types.ts";
import { CommunicationOperationRepository, type CommunicationOperation } from "../src/communication/records.ts";

const TIMESTAMP = "2026-01-02T03:04:05.000Z";
const TEST_SCRATCH_ROOT = process.env.DSH_COMMUNICATION_RECORDS_TEST_ROOT ?? resolve(import.meta.dirname, "../../../../.build/test-runs/records");

async function createTemporaryDirectory(label: string): Promise<string> {
  await mkdir(TEST_SCRATCH_ROOT, { recursive: true });
  return mkdtemp(join(TEST_SCRATCH_ROOT, label + "-"));
}

async function readRecord(root: string, projectId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, projectId, "record.json"), "utf8")) as Record<string, unknown>;
}

/** V8 counts only synchronous codec entries; the real file/transaction owners run unchanged. */
async function measureCommunicationDecode<T>(action: () => Promise<T>) {
  const inspector = new InspectorSession(); inspector.connect();
  try {
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    const result = await action(), coverage = await inspector.post('Profiler.takePreciseCoverage');
    const calls: Record<string, number> = {};
    for (const script of coverage.result) if (script.url.endsWith('/src/communication/records.ts') || script.url.endsWith('/src/records.ts')) {
      for (const fn of script.functions) if (['parseProjectRecord', 'decodeOperationCollection', 'decodeOperation'].includes(fn.functionName)) {
        calls[fn.functionName] = (calls[fn.functionName] ?? 0) + (fn.ranges[0]?.count ?? 0);
      }
    }
    return { result, calls };
  } finally { await inspector.post('Profiler.stopPreciseCoverage'); inspector.disconnect(); }
}

function decodeProbeOperation(projectId: string, index: number): CommunicationOperation {
  const invocationSource: CommunicationInvocationSource = { sessionId: 'decode-host' as never, sessionCreatedAt: 1,
    startEventSeq: index as never, callId: `decode-${index}` as never, rootCallId: `decode-${index}` as never };
  const binding = canonicalSendArgs({ target_session_id: 'decode-main', message: `body-${index}` });
  return { format: 'projects-communication-operation/v1', projectId, operationRef: operationReference(invocationSource), invocationSource,
    argumentsFormat: binding.format, argumentsDigest: binding.digest, registeredAt: TIMESTAMP, updatedAt: TIMESTAMP, phase: 'registered',
    sender: { sessionId: 'decode-sender', hostSessionId: 'decode-host', role: 'execution', title: 'Decode sender' },
    senderPersistence: 'not-started', transport: { insertion: 'not-attempted', recipientPersistence: 'not-started', wakeup: 'not-requested' } };
}

test('stable record files are freshly statted while their validated parse is reused without sharing mutable DTOs', async () => {
  const root = await createTemporaryDirectory('record-parse-reuse'), path = join(root, 'parsed', 'record.json');
  const originalStat = fs.stat, originalOpen = fs.open;
  let stats = 0, opens = 0;
  try {
    const store = new ProjectStore(root);
    await store.createProject({ id: 'parsed', name: 'Original name' });
    await store.bindSession('parsed', { id: 'worker', hostSessionId: 'host-parsed', role: 'execution', title: 'Worker' });
    fs.stat = (async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === path) stats++;
      return originalStat(...args);
    }) as typeof fs.stat;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === path) opens++;
      return originalOpen(...args);
    }) as typeof fs.open;
    syncBuiltinESMExports();
    const measured = await measureCommunicationDecode(async () => {
      const first = await store.findCarrierByHostSessionId('host-parsed');
      assert(first);
      first.project.name = 'Caller-local edit';
      first.session.title = 'Caller-local title';
      for (let index = 0; index < 4; index++) {
        const current = await store.findCarrierByHostSessionId('host-parsed');
        assert.equal(current?.project.name, 'Original name');
        assert.equal(current?.session.title, 'Worker');
      }
    });
    assert.equal(measured.calls.parseProjectRecord, 1);
    assert.equal(measured.calls.decodeOperationCollection, 1);
    assert.equal(opens, 1);
    assert.equal(stats, 6, 'each of five lookups stats the current path, plus the miss publication check');
    fs.stat = originalStat; fs.open = originalOpen; syncBuiltinESMExports();
    await store.updateProject('parsed', { name: 'Saved from a new envelope' });
    assert.equal((await store.getProject('parsed'))?.name, 'Saved from a new envelope');
    assert.equal((await readRecord(root, 'parsed')).version, 15);
  } finally { fs.stat = originalStat; fs.open = originalOpen; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test('another Store and another process invalidate parsed records for carrier, archive and source changes', async () => {
  const root = await createTemporaryDirectory('record-external-commit');
  try {
    const store = new ProjectStore(root), other = new ProjectStore(root);
    await store.createProject({ id: 'external', name: 'Before' });
    await store.bindSession('external', { id: 'worker', hostSessionId: 'host-before', role: 'execution', title: 'Worker' });
    assert.equal((await store.findCarrierByHostSessionId('host-before'))?.carrier.isCurrent, true);
    await other.updateProject('external', { name: 'After another Store' });
    assert.equal((await store.getProject('external'))?.name, 'After another Store');
    const child = (deleting: boolean) => {
      const script = `const { ProjectStore } = await import(process.argv[1]); const store = new ProjectStore(process.argv[2]);
const session = await store.getSession('external', 'worker');
if (process.argv[3] === 'delete') await store.beginExecutionSourceDeletion({projectId:'external',sessionId:'worker',carrierHostSessionId:'host-next',expectedRevision:session.revision});
else { await store.bindSessionCarrier({projectId:'external',sessionId:'worker',hostSessionId:'host-next',expectedRevision:session.revision}); await store.updateSession('external','worker',{archived:true}); }`;
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '-e', script,
        new URL('../src/records.ts', import.meta.url).href, root, deleting ? 'delete' : 'switch'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    child(false);
    const historical = await store.findCarrierByHostSessionId('host-before');
    assert.equal(historical?.carrier.isCurrent, false);
    assert.equal(historical?.session.hostSessionId, 'host-next');
    assert.equal(historical?.session.archived, true);
    assert.equal((await store.findCarrierByHostSessionId('host-next'))?.carrier.sourceLifecycle.kind, 'available');
    child(true);
    assert.equal((await store.findCarrierByHostSessionId('host-next'))?.carrier.sourceLifecycle.kind, 'deleting');
    assert.equal((await store.findSessionSourceByHostSessionId('host-next'))?.sourceLifecycle.kind, 'deleting');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const replacement of ['rename', 'in-place', 'unlink'] as const) test(`a ${replacement} during an opened record read preserves that snapshot without caching it under a later path`, async () => {
  const root = await createTemporaryDirectory('record-opened-snapshot'), path = join(root, 'racing', 'record.json');
  const originalOpen = fs.open;
  try {
    const store = new ProjectStore(root), writer = new ProjectStore(root);
    await store.createProject({ id: 'racing', name: 'Initially cached' });
    await store.getProject('racing');
    await writer.updateProject('racing', { name: 'Opened snapshot' });
    const next = await readRecord(root, 'racing');
    (next.project as Record<string, unknown>).name = 'Replacement snapshot';
    let armed = true;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === path && armed) {
        const read = handle.readFile.bind(handle);
        handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
          const contents = await read(...readArgs);
          if (armed) {
            armed = false;
            if (replacement === 'unlink') await fs.unlink(path);
            else if (replacement === 'in-place') await writeFile(path, JSON.stringify(next));
            else { const scratch = path + '.replacement'; await writeFile(scratch, JSON.stringify(next)); await fs.rename(scratch, path); }
          }
          return contents;
        }) as typeof handle.readFile;
      }
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    assert.equal((await store.getProject('racing'))?.name, 'Opened snapshot');
    fs.open = originalOpen; syncBuiltinESMExports();
    if (replacement === 'unlink') await assert.rejects(store.getProject('racing'), /Project record is missing/);
    else assert.equal((await store.getProject('racing'))?.name, 'Replacement snapshot');
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test('reused parses never hide missing, corrupt, unreadable or newly duplicate record facts', async () => {
  const root = await createTemporaryDirectory('record-reuse-errors'), originalStat = fs.stat;
  try {
    const store = new ProjectStore(root);
    for (const id of ['first', 'second']) {
      await store.createProject({ id, name: id });
      await store.bindSession(id, { id: 'worker', hostSessionId: 'host-' + id, role: 'execution', title: id });
    }
    await store.findCarrierByHostSessionId('host-first');
    const path = join(root, 'second', 'record.json'), original = await readRecord(root, 'second');
    const duplicate = structuredClone(original);
    ((duplicate.sessions as Record<string, unknown>[])[0]!.carriers as Record<string, unknown>[])[0]!.hostSessionId = 'host-first';
    await writeFile(path, JSON.stringify(duplicate));
    await assert.rejects(store.findCarrierByHostSessionId('host-first'), /Duplicate host session binding/);
    await writeFile(path, '{invalid JSON');
    await assert.rejects(store.findCarrierByHostSessionId('host-first'), /invalid JSON/);
    await writeFile(path, JSON.stringify({ ...original, version: 999 }));
    await assert.rejects(store.findCarrierByHostSessionId('host-first'), /Unsupported project record version/);
    await writeFile(path, JSON.stringify(original));
    assert.equal((await store.findCarrierByHostSessionId('host-second'))?.project.id, 'second');
    const denied = Object.assign(new Error('actual fresh stat denial'), { code: 'EACCES' });
    fs.stat = (async (...args: Parameters<typeof fs.stat>) => { if (String(args[0]) === path) throw denied; return originalStat(...args); }) as typeof fs.stat;
    syncBuiltinESMExports();
    await assert.rejects(store.getProject('second'), error => error === denied);
    fs.stat = originalStat; syncBuiltinESMExports();
    await fs.unlink(path);
    await assert.rejects(store.getProject('second'), /Project record is missing/);
    await rm(join(root, 'second'), { recursive: true });
    assert.equal(await store.getProject('second'), undefined);
    await new ProjectStore(root).createProject({ id: 'second', name: 'Recreated after absence' });
    assert.equal((await store.getProject('second'))?.name, 'Recreated after absence');
  } finally { fs.stat = originalStat; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test('same-read communication codec counts retain repository results, raw envelopes, cold reads, CAS and immutable identity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(TIMESTAMP) });
  const root = await createTemporaryDirectory('communication-decode-reuse'), projectId = 'decode-project', count = 64;
  try {
    const store = new ProjectStore(root), repository = new CommunicationOperationRepository(store);
    await store.createProject({ id: projectId, name: 'Decode reuse' });
    const raw = await readRecord(root, projectId), operations = Array.from({ length: count }, (_, index) => decodeProbeOperation(projectId, index));
    raw.communicationOperations = { format: 'projects-communication-operations/v1', operations };
    raw.foreignOwner = { nested: [null, true, { exact: '  unknown envelope  ' }] };
    const path = join(root, projectId, 'record.json'), before = JSON.stringify(raw);
    await writeFile(path, before);
    const measurements: Record<string, unknown> = {};
    const listed = await measureCommunicationDecode(() => repository.list(projectId)); measurements.list = listed.calls;
    assert.deepEqual(listed.result, operations); assert.equal(Object.isFrozen(listed.result), true);
    assert.equal(Object.isFrozen(listed.result[0]!.transport), true);
    const duplicate = await measureCommunicationDecode(() => repository.register(operations[0]!)); measurements.registerExisting = duplicate.calls;
    assert.deepEqual(duplicate.result, { created: false, operation: operations[0] });
    assert.equal(await readFile(path, 'utf8'), before);
    const added = decodeProbeOperation(projectId, count);
    const registered = await measureCommunicationDecode(() => repository.register(added)); measurements.registerNew = registered.calls;
    assert.deepEqual(registered.result, { created: true, operation: added });
    const advanced: CommunicationOperation = { ...added, phase: 'preparation-failed', senderPersistence: 'unknown',
      failure: { code: 'PROBE_UNKNOWN', message: 'Actual failure fact remains unknown' } };
    const updated = await measureCommunicationDecode(() => repository.update(advanced, added)); measurements.update = updated.calls;
    assert.deepEqual(updated.result, advanced);
    const afterUpdate = await readFile(path, 'utf8');
    await assert.rejects(() => repository.update(added, added), error => {
      assert.equal((error as { code: string }).code, 'COMMUNICATION_OPERATION_CONFLICT');
      assert.deepEqual((error as { current: unknown }).current, advanced); return true;
    });
    await assert.rejects(() => repository.update({ ...advanced, registeredAt: 'other' }, advanced), /immutable identity/);
    assert.throws(() => repository.register({ ...added, transport: { ...added.transport, insertion: 'invalid' } } as never), /Invalid insertion/);
    assert.equal(await readFile(path, 'utf8'), afterUpdate);
    // A different mutation must never publish or persist an obsolete derived collection.
    await store.updateProject(projectId, { name: 'Updated project' });
    const expected = [...operations, advanced], saved = await readRecord(root, projectId);
    assert.deepEqual((saved.communicationOperations as { operations: unknown }).operations, expected);
    assert.deepEqual(saved.foreignOwner, raw.foreignOwner);
    assert.deepEqual(Object.keys(saved).sort(), [...Object.keys(raw)].sort());
    assert.deepEqual(await new CommunicationOperationRepository(new ProjectStore(root)).list(projectId), expected);
    const published: unknown[] = [];
    const release = store.subscribe(snapshot => published.push(snapshot));
    await repository.update({ ...advanced, updatedAt: 'next' }, advanced); release();
    assert.equal(published.length, 1); assert.equal('communications' in (published[0] as object), false);
    const evidence = process.env.DSH_METADATA_EVIDENCE;
    if (evidence) await writeFile(join(evidence, 'communication-decode-counts.json'), JSON.stringify({ count, measurements,
      contract: { listed: listed.result, registered: registered.result, updated: updated.result, saved } }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('communication reuse rejects corrupt, duplicate and foreign collections without writes and retains terminal/legacy read rules', async () => {
  const root = await createTemporaryDirectory('communication-decode-invalid'), projectId = 'decode-invalid';
  try {
    const store = new ProjectStore(root), repository = new CommunicationOperationRepository(store);
    await store.createProject({ id: projectId, name: 'Invalid collection' });
    const raw = await readRecord(root, projectId), operation = decodeProbeOperation(projectId, 0), path = join(root, projectId, 'record.json');
    const established = (input: CommunicationOperation): CommunicationOperation => ({ ...input, deliveryId: 'same-delivery', nativeMessageId: 'same-message', snapshotDigest: 'same-digest',
      recipient: { sessionId: 'target', hostSessionId: 'target-host', role: 'main', title: 'Target' },
      recipientRecord: { kind: 'recipient-message', holder: { hostSessionId: 'target-host', sessionCreatedAt: 1 }, messageId: 'same-message' } });
    for (const operations of [
      [operation, operation], [operation, { ...decodeProbeOperation(projectId, 1), projectId: 'another-project' }],
      [operation, { ...decodeProbeOperation(projectId, 1), transport: { insertion: 'broken' } }],
      [established(operation), established(decodeProbeOperation(projectId, 1))], [{ ...operation, unsupported: true }],
    ]) {
      const bytes = JSON.stringify({ ...raw, communicationOperations: { format: 'projects-communication-operations/v1', operations } });
      await writeFile(path, bytes);
      await assert.rejects(() => repository.list(projectId));
      await assert.rejects(() => repository.register(decodeProbeOperation(projectId, 2)));
      await assert.rejects(() => repository.update(operation, operation));
      assert.equal(await readFile(path, 'utf8'), bytes);
    }
    // Proposed collections are still decoded: two individually valid operations cannot share a delivery.
    const bytes = JSON.stringify({ ...raw, communicationOperations: { format: 'projects-communication-operations/v1', operations: [established(operation)] } });
    await writeFile(path, bytes);
    await assert.rejects(() => repository.register(established(decodeProbeOperation(projectId, 1))), /Duplicate communication delivery/);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await writeFile(path, JSON.stringify({ ...raw, version: 7 }));
    assert.deepEqual(await repository.list(projectId), []);
    await writeFile(path, JSON.stringify({ ...raw, version: 7, communicationOperations: { format: 'projects-communication-operations/v1', operations: [] } }));
    await assert.rejects(() => repository.list(projectId), /require project record v13/);
    const terminal = { version: 12, terminal: true, project: { id: projectId, revision: 2,
      sourceLifecycle: { kind: 'deleted', requestedAt: TIMESTAMP, deletedAt: TIMESTAMP } }, sources: [], unknownTerminal: [null, true] };
    await writeFile(path, JSON.stringify(terminal));
    assert.deepEqual(await repository.list(projectId), []);
    await writeFile(path, JSON.stringify({ ...terminal, communicationOperations: { format: 'broken', operations: [] } }));
    assert.equal((await store.getProject(projectId))!.sourceLifecycle?.kind, 'deleted');
    await assert.rejects(() => repository.list(projectId), /Unsupported communication operation collection/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("通信操作与会话／项目删除交错时保留v15及原操作，冷读不降格式", async () => {
  const root = await createTemporaryDirectory("communication-deletion-version");
  try {
    for (const scope of ["session", "project"] as const) {
      const store = new ProjectStore(root);
      const project = await store.createProject({ id: `communication-${scope}`, name: scope });
      await store.bindSession(project.id, { id: `${scope}-main`, hostSessionId: `${scope}-host-main`, role: "main", title: "主会话" });
      const sender = await store.bindSession(project.id, { id: `${scope}-sender`, hostSessionId: `${scope}-host-sender`, role: "execution", title: "发送方" });
      const invocationSource: CommunicationInvocationSource = { sessionId: sender.hostSessionId as never,
        sessionCreatedAt: 1, startEventSeq: 0 as never, callId: `${scope}-call` as never, rootCallId: `${scope}-call` as never };
      const binding = canonicalSendArgs({ target_session_id: `${scope}-main`, message: "正文留在聊天中" });
      const { operation } = await store.registerCommunicationOperation({
        format: "projects-communication-operation/v1", projectId: project.id,
        operationRef: operationReference(invocationSource), invocationSource,
        argumentsFormat: binding.format, argumentsDigest: binding.digest,
        registeredAt: TIMESTAMP, updatedAt: TIMESTAMP, phase: "registered",
        sender: { sessionId: sender.id, hostSessionId: sender.hostSessionId, role: "execution", title: sender.title },
        senderPersistence: "not-started",
        transport: { insertion: "not-attempted", recipientPersistence: "not-started", wakeup: "not-requested" },
      });
      if (scope === "session") {
        const started = await store.beginExecutionSourceDeletion({ projectId: project.id, sessionId: sender.id,
          expectedRevision: sender.revision, scheduleDeletion: true });
        assert.equal(started.kind, "started");
      } else {
        const snapshot = await store.getSnapshot(project.id);
        await store.beginProjectSourceDeletion({ projectId: project.id, expectedRevision: snapshot.project.revision,
          sessions: snapshot.sessions.map(session => ({ ...session, sourceLifecycle: {
            kind: "deleting" as const, requestedAt: TIMESTAMP, updatedAt: TIMESTAMP, progress: {},
          } })) });
      }
      const persisted = await readRecord(root, project.id);
      assert.equal(persisted.version, 15);
      assert.deepEqual(await new ProjectStore(root).listCommunicationOperations(project.id), [operation]);
      assert.equal(JSON.stringify(persisted.communicationOperations).includes("正文留在聊天中"), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function legacyProject(projectId: string, name = "Legacy project"): Record<string, unknown> {
  return {
    id: projectId,
    name,
    mainSessionId: projectId + "-main",
    revision: 3,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function legacyMainSession(projectId: string): Record<string, unknown> {
  return {
    id: projectId + "-main",
    projectId,
    hostSessionId: "host-" + projectId + "-main",
    role: "main",
    title: "Main",
    revision: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

test("keeps projects isolated and rejects one of concurrent duplicate host bindings", async () => {
  const root = await createTemporaryDirectory("isolation");
  try {
    const store = new ProjectStore(root);
    const first = await store.createProject({ id: "project-first", name: "First project" });
    const second = await store.createProject({ id: "project-second", name: "Second project" });

    await store.bindSession(first.id, {
      id: "first-main",
      hostSessionId: "host-first-main",
      role: "main",
      title: "First main",
    });
    await store.bindSession(second.id, {
      id: "second-main",
      hostSessionId: "host-second-main",
      role: "main",
      title: "Second main",
    });

    assert.deepEqual(
      (await store.listSessions(first.id)).map((session) => session.hostSessionId),
      ["host-first-main"],
    );
    assert.deepEqual(
      (await store.listSessions(second.id)).map((session) => session.hostSessionId),
      ["host-second-main"],
    );
    const duplicateBindingResults = await Promise.allSettled([
      store.bindSession(first.id, {
        id: "first-race",
        hostSessionId: "host-race",
        role: "execution",
        title: "First concurrent binding",
      }),
      store.bindSession(second.id, {
        id: "second-race",
        hostSessionId: "host-race",
        role: "execution",
        title: "Second concurrent binding",
      }),
    ]);

    assert.deepEqual(
      duplicateBindingResults.map((result) => result.status).sort(),
      ["fulfilled", "rejected"],
    );
    const membership = await store.findMembershipByHostSessionId("host-race");
    assert.ok(membership?.project.id === first.id || membership?.project.id === second.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reopens persisted project and session bindings from a new store instance", async () => {
  const root = await createTemporaryDirectory("reopen");
  try {
    const firstStore = new ProjectStore(root);
    const project = await firstStore.createProject({
      id: "reopen-project",
      name: "Reopen project",
    });
    const session = await firstStore.bindSession(project.id, {
      id: "reopen-main",
      hostSessionId: "host-reopen-main",
      role: "main",
      title: "Reopen main",
    });

    const reopenedStore = new ProjectStore(root);
    const reopenedProject = await reopenedStore.getProject(project.id);
    const reopenedMembership = await reopenedStore.findMembershipByHostSessionId(
      session.hostSessionId,
    );

    assert.equal(reopenedProject?.mainSessionId, session.id);
    assert.equal(reopenedMembership?.project.id, project.id);
    assert.equal(reopenedMembership?.session.id, session.id);
    assert.deepEqual(
      (await reopenedStore.listMemberships()).map((membership) => membership.session.hostSessionId),
      [session.hostSessionId],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes independent project and session patches without losing either field", async () => {
  const root = await createTemporaryDirectory("concurrency");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "concurrent-project", name: "Before update" });
    const session = await store.bindSession(project.id, {
      id: "concurrent-main",
      hostSessionId: "host-concurrent-main",
      role: "main",
      title: "Before update",
    });

    const [projectUpdate, sessionUpdate] = await Promise.all([
      store.updateProject(project.id, { name: "After project update" }),
      store.updateSession(project.id, session.id, { title: "After session update" }),
    ]);

    assert.equal(projectUpdate.kind, "updated");
    assert.equal(sessionUpdate.kind, "updated");
    assert.equal((await store.getProject(project.id))?.name, "After project update");
    assert.equal((await store.getSession(project.id, session.id))?.title, "After session update");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns revision conflicts without overwriting current project or session state", async () => {
  const root = await createTemporaryDirectory("revision");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "revision-project", name: "Original name" });
    const updated = await store.updateProject(
      project.id,
      { name: "Current name" },
      { expectedRevision: project.revision },
    );
    const conflict = await store.updateProject(
      project.id,
      { name: "Stale update" },
      { expectedRevision: project.revision },
    );

    assert.equal(updated.kind, "updated");
    assert.equal(conflict.kind, "conflict");
    assert.equal(conflict.project.name, "Current name");
    assert.equal((await store.getProject(project.id))?.archived, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changes only the project archive bit through an exact roster CAS", async () => {
  const root = await createTemporaryDirectory("project-archive-cas");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "archive-project", name: "Archive" });
    const main = await store.bindSession(project.id, {
      id: "archive-main", hostSessionId: "host-archive-main", role: "main", title: "Main",
    });
    const execution = await store.bindSession(project.id, {
      id: "archive-execution", hostSessionId: "host-archive-execution", role: "execution", title: "Execution",
    });
    const before = await store.getSnapshot(project.id);
    const roster = before.sessions.map((session) => ({
      id: session.id, hostSessionId: session.hostSessionId, role: session.role, archived: session.archived,
    }));

    const renamed = await store.updateSession(project.id, execution.id, { title: "Renamed" });
    assert.equal(renamed.kind, "updated");
    const archived = await store.setProjectArchived(project.id, true, roster);
    assert.equal(archived.kind, "updated");
    assert.equal(archived.snapshot.project.archived, true);
    assert.equal(archived.snapshot.sessions.find((session) => session.id === main.id)?.archived, false);
    assert.equal(archived.snapshot.sessions.find((session) => session.id === execution.id)?.title, "Renamed");
    await assert.rejects(
      () => store.bindSession(project.id, {
        id: "archive-late", hostSessionId: "host-archive-late", role: "execution", title: "Late",
      }),
      /archived project/,
    );
    await assert.rejects(
      () => store.updateProject(project.id, { archived: true } as never),
      /must update at least one field/,
    );

    const restored = await store.setProjectArchived(project.id, false, roster);
    assert.equal(restored.kind, "updated");
    assert.equal(restored.snapshot.project.archived, false);
    assert.equal(restored.snapshot.sessions.find((session) => session.id === execution.id)?.archived, false);

    const staleRoster = roster;
    await store.bindSession(project.id, {
      id: "archive-new", hostSessionId: "host-archive-new", role: "execution", title: "New",
    });
    const conflict = await store.setProjectArchived(project.id, true, staleRoster);
    assert.equal(conflict.kind, "conflict");
    assert.equal(conflict.snapshot.project.archived, false);
    assert.equal(conflict.snapshot.sessions.some((session) => session.id === "archive-new"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not leave an empty project directory when creation input is invalid", async () => {
  const root = await createTemporaryDirectory("invalid-create");
  try {
    const store = new ProjectStore(root);
    await assert.rejects(
      () => store.createProject({ id: "invalid-project", name: "   " }),
      /project name must not be empty/,
    );
    const valid = await store.createProject({ id: "valid-project", name: "Valid project" });
    assert.deepEqual(
      (await store.listProjects()).map((project) => project.id),
      [valid.id],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed initial record sync leaves existing projects readable and the new id reusable", async () => {
  const root = await createTemporaryDirectory("create-record-failure");
  const originalOpen = fs.open;
  try {
    const store = new ProjectStore(root);
    await store.createProject({ id: "existing", name: "Existing" });
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) handle.sync = async () => { throw new Error("controlled initial record sync"); };
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    await assert.rejects(store.createProject({ id: "new", name: "New" }), error => durableMutationDetails(error)?.effect === "none");
    fs.open = originalOpen; syncBuiltinESMExports();
    await assert.rejects(fs.stat(join(root, "new")), { code: "ENOENT" });
    assert.deepEqual((await new ProjectStore(root).listProjects()).map(project => project.id), ["existing"]);
    assert.equal((await store.createProject({ id: "new", name: "Retry" })).name, "Retry");
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test("a separate reader sees only complete project records while the first write is pending", async () => {
  const root = await createTemporaryDirectory("create-record-visibility");
  const originalWrite = fs.writeFile;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let creating: Promise<unknown> | undefined;
  try {
    const store = new ProjectStore(root);
    await store.createProject({ id: "existing", name: "Existing" });
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith(".tmp")) { entered.resolve(); await release.promise; }
      return originalWrite(...args);
    }) as typeof fs.writeFile;
    syncBuiltinESMExports();
    creating = store.createProject({ id: "new", name: "New" });
    await entered.promise;
    assert.deepEqual((await new ProjectStore(root).listProjects()).map(project => project.id), ["existing"]);
    release.resolve(); await creating;
    assert.deepEqual((await new ProjectStore(root).listProjects()).map(project => project.id).sort(), ["existing", "new"]);
  } finally {
    release.resolve(); fs.writeFile = originalWrite; syncBuiltinESMExports();
    try { await creating; } finally { await rm(root, { recursive: true, force: true }); }
  }
});

for (const afterRename of [false, true]) test(`project directory rename ${afterRename ? "after publication stays unknown" : "before publication leaves no project"}`, async () => {
  const root = await createTemporaryDirectory("create-directory-rename");
  const originalRename = fs.rename;
  try {
    const store = new ProjectStore(root);
    await store.createProject({ id: "existing", name: "Existing" });
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) !== join(root, "new")) return originalRename(...args);
      if (afterRename) await originalRename(...args);
      throw new Error("controlled project directory rename");
    }) as typeof fs.rename;
    syncBuiltinESMExports();
    await assert.rejects(store.createProject({ id: "new", name: "New" }), error => durableMutationDetails(error)?.effect === (afterRename ? "published-durability-unknown" : "none"));
    fs.rename = originalRename; syncBuiltinESMExports();
    const reader = new ProjectStore(root);
    assert.deepEqual((await reader.listProjects()).map(project => project.id).sort(), afterRename ? ["existing", "new"] : ["existing"]);
    if (afterRename) {
      assert.equal((await reader.getProject("new"))?.name, "New");
      await assert.rejects(store.createProject({ id: "new", name: "Replacement" }), /already exists/);
      assert.equal((await reader.getProject("new"))?.name, "New");
    } else assert.equal((await store.createProject({ id: "new", name: "Retry" })).name, "Retry");
  } finally { fs.rename = originalRename; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test("a directory sync failure after project publication retains its complete record and reports unknown", async () => {
  const root = await createTemporaryDirectory("create-directory-sync");
  const originalOpen = fs.open, originalRename = fs.rename;
  let published = false;
  try {
    const store = new ProjectStore(root);
    await store.createProject({ id: "existing", name: "Existing" });
    fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
      await originalRename(...args);
      if (String(args[1]) === join(root, "new")) published = true;
    }) as typeof fs.rename;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (published && String(args[0]) === root) handle.sync = async () => { throw new Error("controlled published directory sync"); };
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    await assert.rejects(store.createProject({ id: "new", name: "New" }), error => durableMutationDetails(error)?.stage === "directory-sync" && durableMutationDetails(error)?.effect === "published-durability-unknown");
    fs.open = originalOpen; fs.rename = originalRename; syncBuiltinESMExports();
    assert.equal((await new ProjectStore(root).getProject("new"))?.name, "New");
    assert.equal((await new ProjectStore(root).listProjects()).length, 2);
  } finally { fs.open = originalOpen; fs.rename = originalRename; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test("creation preserves an existing incomplete project path and readers still report its corruption", async () => {
  const root = await createTemporaryDirectory("create-existing-incomplete");
  try {
    const store = new ProjectStore(root);
    await store.init(); await mkdir(join(root, "existing"));
    await assert.rejects(store.createProject({ id: "existing", name: "Replacement" }), /already exists/);
    assert.deepEqual(await fs.readdir(join(root, "existing")), []);
    await assert.rejects(new ProjectStore(root).listProjects(), /Project record is missing: existing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps workspace references external and never copies or changes their files", async () => {
  const root = await createTemporaryDirectory("reference-root");
  const workspace = await createTemporaryDirectory("external-workspace");
  try {
    const externalFile = join(workspace, "source.md");
    await writeFile(externalFile, "unchanged external content\n", "utf8");
    const store = new ProjectStore(root);
    const project = await store.createProject({
      id: "reference-project",
      name: "Reference project",
      workspace: { path: workspace },
    });

    assert.equal((await store.getProject(project.id))?.workspace?.path, workspace);
    assert.equal(await readFile(externalFile, "utf8"), "unchanged external content\n");
    const serializedRecord = await readFile(join(root, project.id, "record.json"), "utf8");
    assert.equal(serializedRecord.includes("unchanged external content"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("publishes committed membership snapshots and only rolls back an uncreated binding", async () => {
  const root = await createTemporaryDirectory("prebinding");
  try {
    const store = new ProjectStore(root);
    const snapshots: Array<{ projectId: string; hostSessionIds: string[] }> = [];
    const unsubscribe = store.subscribe((snapshot) => {
      snapshots.push({
        projectId: snapshot.project.id,
        hostSessionIds: snapshot.sessions.map((session) => session.hostSessionId),
      });
    });
    const project = await store.createProject({ id: "prebinding-project", name: "Prebinding" });
    const session = await store.bindSession(project.id, {
      id: "prebinding-main",
      hostSessionId: "host-preallocated-main",
      role: "main",
      title: "Preallocated main",
    });

    assert.deepEqual(snapshots.at(-1), {
      projectId: project.id,
      hostSessionIds: [session.hostSessionId],
    });
    await assert.rejects(
      () => store.removeSessionBinding(project.id, session.id, {
        expectedHostSessionId: "other-host-session",
      }),
      /does not match binding/,
    );
    const removedBinding = await store.removeSessionBinding(project.id, session.id, {
      expectedHostSessionId: session.hostSessionId,
    });
    assert.deepEqual(snapshots.at(-1), { projectId: project.id, hostSessionIds: [] });
    const removedProject = await store.removeEmptyProject(project.id, {
      expectedCreatedAt: project.createdAt,
      expectedRevision: removedBinding.project.revision,
    });
    unsubscribe();

    assert.equal(removedProject, true);
    assert.equal(await store.getProject(project.id), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not turn corrupt persisted JSON into an empty project", async () => {
  const root = await createTemporaryDirectory("corrupt-json");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "corrupt-project", name: "Corrupt record" });
    await writeFile(join(root, project.id, "record.json"), "{\n", "utf8");
    await assert.rejects(
      () => new ProjectStore(root).getProject(project.id),
      /invalid JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads v1 through v4 envelopes without writing or normalizing them", async () => {
  const root = await createTemporaryDirectory("historical-read-only");
  try {
    for (const version of [1, 2, 3, 4]) {
      const projectId = "historical-v" + version;
      await mkdir(join(root, projectId));
      const record = {
        version,
        project: legacyProject(projectId, "Historical v" + version),
        sessions: [legacyMainSession(projectId)],
        ...(version === 1 ? {} : { deliveries: [] }),
        untouchedHistoricalExtension: { version, preserved: true },
      };
      const serialized = JSON.stringify(record, undefined, 2) + "\n";
      await writeFile(join(root, projectId, "record.json"), serialized, "utf8");

      const snapshot = await new ProjectStore(root).getSnapshot(projectId);
      assert.equal(snapshot.project.name, "Historical v" + version);
      assert.equal(snapshot.deliveries.length, 0);
      assert.equal(await readFile(join(root, projectId, "record.json"), "utf8"), serialized);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a historical raw envelope across rename and read-only legacy receipt queries", async () => {
  const root = await createTemporaryDirectory("historical-preservation");
  const projectId = "historical-project";
  try {
    const historical = {
      version: 4,
      project: {
        id: projectId,
        name: "Historical collaboration",
        goal: "This retired goal must not become current",
        mainSessionId: "historical-main",
        archived: false,
        revision: 7,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        unknownProjectExtension: { keep: "project extension" },
      },
      sessions: [
        {
          id: "historical-main",
          projectId,
          hostSessionId: "host-historical-main",
          role: "main",
          title: "Main",
          archived: false,
          revision: 1,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          unknownSessionExtension: { keep: "main session extension" },
        },
        {
          id: "historical-execution",
          projectId,
          hostSessionId: "host-historical-execution",
          role: "execution",
          title: "Execution",
          archived: false,
          revision: 1,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
      deliveries: [
        {
          id: "historical-delivery",
          intent: "assign",
          senderSessionId: "historical-main",
          targetSessionId: "historical-execution",
          workId: "old-work",
          sources: [
            {
              kind: "record",
              recordKind: "work",
              recordId: "old-work",
              revision: 2,
              untouchedLegacySourceExtension: "keep this source",
            },
            {
              kind: "message",
              hostSessionId: "host-historical-main",
              messageId: "legacy-direct-message",
              untouchedNativeSourceExtension: "also keep",
            },
          ],
          dispatch: "notDelivered",
          processing: "pending",
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          unknownDeliveryExtension: { keep: "delivery extension" },
        },
      ],
      requirements: [
        {
          id: "old-requirement",
          revision: 2,
          text: "Retired business body must never be exposed through the current snapshot",
          sources: [{ kind: "record", recordKind: "work", recordId: "old-work", revision: 2 }],
          decisionSource: {
            kind: "message",
            hostSessionId: "host-historical-main",
            messageId: "legacy-decision-source",
          },
          correction: {
            source: {
              kind: "tool",
              hostSessionId: "host-historical-main",
              toolCallId: "legacy-correction-tool",
            },
            evidence: [
              {
                kind: "message",
                hostSessionId: "host-historical-main",
                messageId: "legacy-correction-evidence",
              },
            ],
          },
          unknownRequirementExtension: { keep: true },
        },
      ],
      work: [{
        id: "old-work",
        ownerSessionId: "missing-owner-does-not-block-current-reads",
        malformedLegacyRelationship: { requirementId: "also-missing" },
      }],
      controls: [{
        id: "old-control",
        sources: [{
          kind: "message",
          hostSessionId: "host-historical-main",
          messageId: "legacy-control-source",
        }],
      }],
      results: [{ id: "old-result", workId: "missing-work", body: "retired" }],
      artifacts: [{ id: "old-artifact", workId: "missing-work" }],
      reviews: [{
        id: "old-review",
        statement: {
          source: {
            kind: "message",
            hostSessionId: "host-historical-main",
            messageId: "legacy-statement-source",
          },
          quote: "Old review body remains private",
        },
      }],
      unknownTopLevelExtension: { keep: ["all", "unknown", "values"] },
    };
    await mkdir(join(root, projectId));
    const originalSerialized = JSON.stringify(historical, undefined, 2) + "\n";
    await writeFile(join(root, projectId, "record.json"), originalSerialized, "utf8");

    const store = new ProjectStore(root);
    const snapshot = await store.getSnapshot(projectId);
    const historicalDelivery = snapshot.deliveries[0];
    if (historicalDelivery === undefined) throw new Error("Historical delivery was not projected");
    assert.deepEqual(Object.keys(snapshot).sort(), ["deliveries", "project", "sessions"]);
    assert.equal("goal" in snapshot.project, false);
    assert.equal("workId" in historicalDelivery, false);
    assert.deepEqual(historicalDelivery.sources, [{
      kind: "message",
      hostSessionId: "host-historical-main",
      messageId: "legacy-direct-message",
    }]);
    assert.equal(await readFile(join(root, projectId, "record.json"), "utf8"), originalSerialized);

    const historicalLocator = await store.readLegacySourceLocators(projectId, {
      kind: "record",
      recordKind: "requirement",
      recordId: "old-requirement",
      revision: 1,
    });
    assert.match(historicalLocator.reason, /stored current historical revision is not exact-old/);
    assert.deepEqual(historicalLocator.sources, [
      {
        kind: "message",
        hostSessionId: "host-historical-main",
        messageId: "legacy-decision-source",
      },
      {
        kind: "tool",
        hostSessionId: "host-historical-main",
        toolCallId: "legacy-correction-tool",
      },
      {
        kind: "message",
        hostSessionId: "host-historical-main",
        messageId: "legacy-correction-evidence",
      },
    ]);
    assert.equal((await store.readLegacySourceLocators(projectId, {
      kind: "record",
      recordKind: "result",
      recordId: "old-result",
    })).sources.length, 0);
    assert.deepEqual((await store.readLegacySourceLocators(projectId, {
      kind: "control",
      controlId: "old-control",
    })).sources, [{
      kind: "message",
      hostSessionId: "host-historical-main",
      messageId: "legacy-control-source",
    }]);
    assert.deepEqual((await store.readLegacySourceLocators(projectId, {
      kind: "record",
      recordKind: "review",
      recordId: "old-review",
    })).sources, [{
      kind: "message",
      hostSessionId: "host-historical-main",
      messageId: "legacy-statement-source",
    }]);

    await store.updateProject(projectId, { name: "Renamed current project" });
    await store.updateSession(projectId, "historical-main", { title: "Renamed main" });
    const afterRename = await readRecord(root, projectId);
    assert.equal(afterRename.version, 4);
    const renamedProject = afterRename.project as Record<string, unknown>;
    assert.equal(renamedProject.name, "Renamed current project");
    assert.equal(renamedProject.goal, historical.project.goal);
    assert.deepEqual(renamedProject.unknownProjectExtension, historical.project.unknownProjectExtension);
    assert.deepEqual(afterRename.requirements, historical.requirements);
    assert.deepEqual(
      (afterRename.sessions as Array<Record<string, unknown>>)[0]?.unknownSessionExtension,
      (historical.sessions[0] as Record<string, unknown>).unknownSessionExtension,
    );
    assert.equal(
      (afterRename.sessions as Array<Record<string, unknown>>)[0]?.title,
      "Renamed main",
    );
    assert.deepEqual(afterRename.unknownTopLevelExtension, historical.unknownTopLevelExtension);
    assert.deepEqual(
      (afterRename.deliveries as Array<Record<string, unknown>>)[0]?.sources,
      (historical.deliveries[0] as Record<string, unknown>).sources,
    );

    const receipt = await store.getDelivery(projectId, 'historical-delivery');
    assert.equal(receipt?.dispatch, 'notDelivered');
    assert.deepEqual(await readRecord(root, projectId), afterRename);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes new projects as minimal current records without creating legacy deliveries", async () => {
  const root = await createTemporaryDirectory("v5-minimal");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "v5-project", name: "Current project" });
    const main = await store.bindSession(project.id, {
      id: "v5-main",
      hostSessionId: "host-v5-main",
      role: "main",
      title: "Main",
    });
    const execution = await store.bindSession(project.id, {
      id: "v5-execution",
      hostSessionId: "host-v5-execution",
      role: "execution",
      title: "Execution",
    });
    const raw = await readRecord(root, project.id);
    const rawProject = raw.project as Record<string, unknown>;

    assert.equal(raw.version, 15);
    assert.deepEqual(Object.keys(raw).sort(), ["deliveries", "project", "sessions", "version"]);
    assert.equal("goal" in rawProject, false);
    assert.equal("requirements" in raw, false);
    assert.equal("work" in raw, false);
    assert.equal("controls" in raw, false);
    assert.equal("results" in raw, false);
    assert.equal("artifacts" in raw, false);
    assert.equal("reviews" in raw, false);
    assert.deepEqual(raw.deliveries, []);
  } catch (cause) {
    throw new Error("Legacy minimal-v5 assertion fixture retained: " + root, { cause });
  }
});

const COMPLETE_CLEANUP: SessionCleanupProgress = {
  projectionCache: "cleared",
  sessionLog: "removed",
  queryIndex: "cleared",
  sessionInstructions: "removed",
};

test("upgrades v1-v5 only for deletion and erases only the deleted target row", async () => {
  const root = await createTemporaryDirectory("source-deletion-versions");
  try {
    for (const version of [1, 2, 3, 4, 5]) {
      const projectId = "deletion-v" + version;
      const targetId = projectId + "-execution";
      const hostSessionId = "host-" + targetId;
      const main = { ...legacyMainSession(projectId), id: projectId + "-main", opaqueMain: { text: "keep B" } };
      const target = {
        ...legacyMainSession(projectId),
        id: targetId, hostSessionId, role: "execution", title: "A private title",
        modelConfiguration: { instructions: "A private instructions" },
        opaqueTarget: { text: "A private opaque content" },
      };
      const delivery = {
        id: projectId + "-delivery", intent: "report", senderSessionId: targetId,
        targetSessionId: main.id, sources: version < 5
          ? [{ kind: "record", recordId: "historical", recordKind: "result" }] : [],
        dispatch: "notDelivered", processing: "pending", createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
        opaqueDelivery: { text: "keep transport" },
      };
      const raw = {
        version, project: legacyProject(projectId), sessions: [main, target],
        ...(version === 1 ? {} : { deliveries: [delivery] }),
        opaqueTop: { text: "keep project extension" },
      };
      await mkdir(join(root, projectId));
      const path = join(root, projectId, "record.json");
      const original = JSON.stringify(raw, undefined, 2) + "\n";
      await writeFile(path, original, "utf8");
      const store = new ProjectStore(root);
      assert.deepEqual((await store.getSession(projectId, targetId))?.sourceLifecycle, { kind: "available" });
      assert.equal(await readFile(path, "utf8"), original);
      await store.updateSession(projectId, main.id as string, { title: "B renamed" });
      const metadataRaw = await readRecord(root, projectId);
      assert.equal(metadataRaw.version, version);
      assert.deepEqual((metadataRaw.sessions as unknown[])[1], target);
      const begin = await store.beginExecutionSourceDeletion({ projectId, sessionId: targetId, expectedRevision: 1 });
      assert.equal(begin.kind, "started");
      const deletingRaw = await readRecord(root, projectId);
      assert.equal(deletingRaw.version, 6);
      assert.deepEqual(deletingRaw.opaqueTop, raw.opaqueTop);
      assert.deepEqual(deletingRaw.deliveries, metadataRaw.deliveries);
      assert.deepEqual((deletingRaw.sessions as unknown[])[0], (metadataRaw.sessions as unknown[])[0]);
      assert.deepEqual((deletingRaw.sessions as Record<string, unknown>[])[1]?.opaqueTarget, target.opaqueTarget);
      const reopened = new ProjectStore(root);
      assert.equal((await reopened.getSession(projectId, targetId))?.sourceLifecycle.kind, "deleting");
      const progress = await reopened.recordExecutionSourceDeletion({
        projectId, sessionId: targetId, expectedRevision: begin.session.revision, progress: COMPLETE_CLEANUP,
      });
      assert.equal(progress.kind, "updated");
      const complete = await reopened.completeExecutionSourceDeletion({
        projectId, sessionId: targetId, expectedRevision: progress.session.revision,
      });
      assert.equal(complete.kind, "updated");
      assert.equal(complete.session.title, "来源已删除");
      const finalRaw = await readRecord(root, projectId);
      const finalTarget = (finalRaw.sessions as Record<string, unknown>[])[1];
      assert.deepEqual(Object.keys(finalTarget ?? {}).sort(), [
        "createdAt", "hostSessionId", "id", "projectId", "revision", "role", "sourceLifecycle", "title", "updatedAt",
      ]);
      assert.equal(finalTarget?.title, "来源已删除");
      assert.deepEqual(finalRaw.opaqueTop, raw.opaqueTop);
      assert.deepEqual(finalRaw.deliveries, metadataRaw.deliveries);
      assert.deepEqual((finalRaw.sessions as unknown[])[0], (metadataRaw.sessions as unknown[])[0]);
      assert.equal((await new ProjectStore(root).findSessionSourceByHostSessionId(hostSessionId))?.sourceLifecycle.kind, "deleted");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains deleted source claims while removing operational lifecycle and dispatch targets", async () => {
  const root = await createTemporaryDirectory("source-deletion-readers");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "readers", name: "Readers" });
    const main = await store.bindSession(project.id, { id: "readers-main", hostSessionId: "host-readers-main", role: "main", title: "Main" });
    const target = await store.bindSession(project.id, { id: "readers-target", hostSessionId: "host-readers-target", role: "execution", title: "Target" });
    const deletion = await store.beginExecutionSourceDeletion({ projectId: project.id, sessionId: target.id, expectedRevision: target.revision });
    for (const reader of [() => store.listOperationalMemberships(), () => store.listMemberships()]) {
      assert.deepEqual((await reader()).map((membership) => membership.session.id), [main.id]);
    }
    assert.equal(await store.findOperationalMembershipByHostSessionId(target.hostSessionId), undefined);
    assert.equal(await store.findMembershipByHostSessionId(target.hostSessionId), undefined);
    assert.deepEqual((await store.listProjectLifecycleTargets(project.id)).map((session) => session.id), [main.id]);
    assert.deepEqual((await store.listDispatchTargets(project.id)).map((session) => session.id), [main.id]);
    assert.equal(await store.findDispatchTarget(project.id, target.id), undefined);
    assert.equal((await store.findDispatchTarget(project.id, main.id))?.id, main.id);
    assert.deepEqual(await store.listCatalogClaims(), [main.hostSessionId, target.hostSessionId]);
    assert.deepEqual((await store.listRetainedSessionSources()).map((session) => session.id), [main.id, target.id]);
    const retained = await store.findSessionSourceByHostSessionId(target.hostSessionId);
    assert.equal(retained?.sourceLifecycle.kind, "deleting");
    assert.equal("archived" in (retained ?? {}), false);
    for (const patch of [{ title: "Reopen" }, { archived: true }]) {
      await assert.rejects(() => store.updateSession(project.id, target.id, patch), /source is unavailable/);
    }
    await assert.rejects(() => store.removeSessionBinding(project.id, target.id, { expectedHostSessionId: target.hostSessionId }), /source is unavailable/);
    await assert.rejects(() => store.bindSession(project.id, {
      id: "reused-source", hostSessionId: target.hostSessionId, role: "execution", title: "Reused",
    }), /already bound/);
    const roster = await store.listProjectLifecycleTargets(project.id);
    const archived = await store.setProjectArchived(project.id, true, roster);
    assert.equal(archived.kind, "updated");
    assert.deepEqual((await store.getSession(project.id, target.id)), deletion.session);
    const withProgress = await store.recordExecutionSourceDeletion({
      projectId: project.id, sessionId: target.id, expectedRevision: deletion.session.revision, progress: COMPLETE_CLEANUP,
    });
    const complete = await store.completeExecutionSourceDeletion({
      projectId: project.id, sessionId: target.id, expectedRevision: withProgress.session.revision,
    });
    assert.equal(complete.session.sourceLifecycle.kind, "deleted");
    assert.equal((await store.findSessionSourceByHostSessionId(target.hostSessionId))?.sourceLifecycle.kind, "deleted");
    assert.deepEqual(await store.listCatalogClaims(), [main.hostSessionId, target.hostSessionId]);
    assert.deepEqual((await store.listProjectLifecycleTargets(project.id)).map((session) => session.id), [main.id]);
    assert.equal((await store.findDispatchTarget(project.id, main.id))?.archived, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves bounded partial facts and source revision CAS through explicit continuation", async () => {
  const root = await createTemporaryDirectory("source-deletion-cas");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "deletion-cas", name: "CAS" });
    const main = await store.bindSession(project.id, { id: "cas-main", hostSessionId: "host-cas-main", role: "main", title: "Main" });
    const target = await store.bindSession(project.id, { id: "cas-target", hostSessionId: "host-cas-target", role: "execution", title: "Target" });
    await assert.rejects(() => store.beginExecutionSourceDeletion({ projectId: project.id, sessionId: main.id, expectedRevision: main.revision }), /execution session/);
    const input = { projectId: project.id, sessionId: target.id, expectedRevision: target.revision };
    await assert.rejects(() => store.beginExecutionSourceDeletion({ ...input, expectedRevision: undefined as never }), /positive integer/);
    const races = await Promise.all([store.beginExecutionSourceDeletion(input), store.beginExecutionSourceDeletion(input)]);
    assert.deepEqual(races.map((result) => result.kind), ["started", "conflict"]);
    const begin = races[0]!;
    assert.equal((await store.beginExecutionSourceDeletion({ ...input, expectedRevision: begin.session.revision })).kind, "already-deleting");
    await assert.rejects(() => store.completeExecutionSourceDeletion({ ...input, expectedRevision: begin.session.revision }), /all cleanup owners/);
    const partial = await store.recordExecutionSourceDeletion({
      ...input, expectedRevision: begin.session.revision, progress: { projectionCache: "cleared" },
      failure: { stage: "session-log", certainty: "known-partial", message: "one artifact remains", knownRemovedArtifacts: 2, knownRemainingArtifacts: 1 },
    });
    assert.equal(partial.session.sourceLifecycle.kind, "partial");
    if (partial.session.sourceLifecycle.kind !== "partial") assert.fail("expected partial");
    const requestedAt = partial.session.sourceLifecycle.requestedAt;
    const persisted = await readRecord(root, project.id);
    const late = await store.recordExecutionSourceDeletion({ ...input, expectedRevision: begin.session.revision, progress: COMPLETE_CLEANUP });
    assert.equal(late.kind, "conflict");
    assert.deepEqual(await readRecord(root, project.id), persisted);
    const reopened = new ProjectStore(root);
    const resumed = await reopened.beginExecutionSourceDeletion({ ...input, expectedRevision: partial.session.revision });
    assert.equal(resumed.kind, "started");
    assert.deepEqual(resumed.session.sourceLifecycle, {
      kind: "deleting", requestedAt, updatedAt: resumed.session.updatedAt, progress: { projectionCache: "cleared" },
    });
    for (const extra of [
      { progress: { arbitraryOwner: "cleared" } },
      { progress: {}, failure: { stage: "session-log", certainty: "unknown", message: "unknown", paths: ["private"] } },
      { progress: {}, failure: { stage: "session-log", certainty: "unknown", message: "unknown", knownRemainingArtifacts: -1 } },
    ]) {
      await assert.rejects(() => reopened.recordExecutionSourceDeletion({
        ...input, expectedRevision: resumed.session.revision, ...extra,
      } as never));
    }
    const progress = await reopened.recordExecutionSourceDeletion({
      ...input, expectedRevision: resumed.session.revision,
      progress: { sessionLog: "removed", queryIndex: "not-present", sessionInstructions: "already-absent" },
    });
    await assert.rejects(() => reopened.recordExecutionSourceDeletion({
      ...input, expectedRevision: progress.session.revision, progress: { sessionLog: "already-absent" },
    }), /cannot be replaced/);
    const complete = await reopened.completeExecutionSourceDeletion({ ...input, expectedRevision: progress.session.revision });
    assert.equal(complete.session.sourceLifecycle.kind, "deleted");
    assert.equal((await reopened.beginExecutionSourceDeletion({ ...input, expectedRevision: complete.session.revision })).kind, "already-deleted");
    assert.equal((await reopened.recordExecutionSourceDeletion({ ...input, progress: {}, expectedRevision: progress.session.revision })).kind, "conflict");
    if (complete.session.sourceLifecycle.kind !== "deleted") assert.fail("expected deleted");
    assert.equal("progress" in complete.session.sourceLifecycle, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes source disposition synchronously before ordinary subscribers see a committed deletion", async () => {
  const root = await createTemporaryDirectory("source-disposition-publication");
  try {
    const store = new ProjectStore(root);
    const project = await store.createProject({ id: "publication", name: "Publication" });
    const target = await store.bindSession(project.id, { id: "publication-target", hostSessionId: "host-publication-target", role: "execution", title: "Target" });
    let nativeKind = "available";
    const order: string[] = [];
    store.subscribe((snapshot) => {
      order.push("ordinary");
      assert.equal(nativeKind, snapshot.sessions[0]?.sourceLifecycle.kind);
    });
    const dispose = store.addSourceDispositionListener((snapshot) => {
      order.push("source");
      nativeKind = snapshot.sessions[0]!.sourceLifecycle.kind;
      const lifecycle = snapshot.sessions[0]!.sourceLifecycle;
      if (lifecycle.kind === "deleting") (lifecycle.progress as { sessionLog?: string }).sessionLog = "removed";
    });
    const begin = await store.beginExecutionSourceDeletion({ projectId: project.id, sessionId: target.id, expectedRevision: target.revision });
    assert.deepEqual(order, ["source", "ordinary"]);
    assert.equal(begin.session.sourceLifecycle.kind, "deleting");
    if (begin.session.sourceLifecycle.kind !== "deleting") assert.fail("expected deleting");
    assert.deepEqual(begin.session.sourceLifecycle.progress, {});
    assert.deepEqual((await store.getSession(project.id, target.id))?.sourceLifecycle, begin.session.sourceLifecycle);
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function carrierHeader(id: string, createdAt = 1): SessionOwnedSessionHeader {
  return { version: 4, id, createdAt, isSeeded: false } as SessionOwnedSessionHeader;
}
function carrierArchive(host: string): SessionOwnedLifecycle {
  return { contract: 'archive-v1', rootHeader: carrierHeader(host), members: [] };
}
function carrierInput(session: ProjectSession, hostSessionId = session.hostSessionId) {
  return { projectId: session.projectId, sessionId: session.id, expectedRevision: session.revision, carrierHostSessionId: hostSessionId };
}
function projectDeletionProposal(session: ProjectSession): ProjectSession {
  const carriers = session.carriers!.map(carrier => ({ ...carrier, sourceLifecycle: carrier.sourceLifecycle.kind === 'deleted'
    ? carrier.sourceLifecycle : { kind: 'deleting' as const, requestedAt: TIMESTAMP, updatedAt: TIMESTAMP, progress: {} } }));
  return { ...session, carriers, sourceLifecycle: carriers.find(row => row.isCurrent)!.sourceLifecycle };
}

test('carrier roots retain logical identity, original source and exact current routing across cold reopen', async () => {
  const root = await createTemporaryDirectory('carrier-routing');
  try {
    const store = new ProjectStore(root), project = await store.createProject({ id: 'carriers', name: 'Carriers' });
    const first = await store.bindSession(project.id, { id: 'logical', hostSessionId: 's1', role: 'main', title: 'Original', header: carrierHeader('s1') });
    const second = await store.bindSessionCarrier({ projectId: project.id, sessionId: first.id, expectedRevision: first.revision,
      hostSessionId: 's2', header: carrierHeader('s2', 2) });
    assert.equal(second.kind, 'updated'); assert.equal(second.session.id, first.id); assert.equal(second.session.hostSessionId, 's2');
    assert.deepEqual(second.session.carriers!.map(row => [row.sequence, row.hostSessionId, row.isCurrent]), [[1, 's1', false], [2, 's2', true]]);
    const renamed = (await store.updateSession(project.id, first.id, { title: 'Renamed' }, { expectedRevision: second.session.revision })).session;
    const cold = new ProjectStore(root);
    assert.equal((await cold.findCarrierByHostSessionId('s1'))?.projectSessionId, first.id);
    assert.equal((await cold.findCarrierByHostSessionId('s1'))?.session.hostSessionId, 's2');
    assert.equal((await cold.findCarrierByHostSessionId('s1'))?.carrier.hostSessionId, 's1');
    assert.equal((await cold.findSessionSourceByHostSessionId('s1'))?.hostSessionId, 's1');
    assert.equal((await cold.findSessionSourceByHostSessionId('s1'))?.header?.createdAt, 1);
    assert.equal(await cold.findOperationalMembershipByHostSessionId('s1'), undefined);
    assert.equal((await cold.findOperationalMembershipByHostSessionId('s2'))?.session.id, first.id);
    assert.equal((await cold.resolveCurrentCarrier(project.id, first.id))?.hostSessionId, 's2');
    assert.deepEqual((await cold.listRetainedSessionSources()).map(row => row.hostSessionId), ['s1', 's2']);
    assert.deepEqual((await cold.listProjectCarriers(project.id)).map(row => [row.projectSessionId, row.carrier.hostSessionId]), [[first.id, 's1'], [first.id, 's2']]);
    assert.deepEqual(await cold.listCatalogClaims(), ['s1', 's2']);
    const raw = await readRecord(root, project.id), saved = (raw.sessions as Record<string, unknown>[])[0]!;
    assert.equal(raw.version, 15); assert.equal('hostSessionId' in saved, false); assert.equal('sourceLifecycle' in saved, false);
    assert.equal('ownedLifecycle' in saved, false); assert.equal((await cold.getSession(project.id, first.id))?.title, renamed.title);
    const closed = await cold.closeSessionCarrier({ projectId: project.id, sessionId: first.id, expectedRevision: renamed.revision,
      hostSessionId: 's1', confirmedAt: TIMESTAMP, reason: 'ended' });
    assert.equal((await cold.resolveCurrentCarrier(project.id, first.id))?.hostSessionId, 's2');
    assert.equal((await cold.findSessionSourceByHostSessionId('s1'))?.sourceLifecycle.kind, 'available');
    assert.equal(closed.session.carriers![0]!.closed?.reason, 'ended');
    // 普通停止／恢复没有 close 写入；此处模拟生命周期 archive 位的可逆往返。
    await cold.setProjectArchived(project.id, true, [{ id: first.id, hostSessionId: 's2', role: 'main', archived: false, carrierHostSessionIds: ['s1', 's2'] }]);
    await cold.setProjectArchived(project.id, false, [{ id: first.id, hostSessionId: 's2', role: 'main', archived: false, carrierHostSessionIds: ['s1', 's2'] }]);
    assert.equal((await cold.resolveCurrentCarrier(project.id, first.id))?.hostSessionId, 's2');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('carrier binding serializes uniqueness and CAS, rejects native children and retains all claimed roots', async () => {
  const root = await createTemporaryDirectory('carrier-claims');
  try {
    const store = new ProjectStore(root), a = await store.createProject({ id: 'a', name: 'A' }), b = await store.createProject({ id: 'b', name: 'B' });
    const first = await store.bindSession(a.id, { id: 'first', hostSessionId: 'root1', role: 'execution', title: 'First' });
    const other = await store.bindSession(b.id, { id: 'other', hostSessionId: 'other-root', role: 'main', title: 'Other' });
    const raced = await Promise.allSettled([first, other].map(session => store.bindSessionCarrier({ projectId: session.projectId,
      sessionId: session.id, expectedRevision: session.revision, hostSessionId: 'same-root', header: carrierHeader('same-root') })));
    assert.equal(raced.filter(row => row.status === 'fulfilled').length, 1);
    const updated = (await store.getSession(a.id, first.id))!;
    const conflict = await store.bindSessionCarrier({ projectId: a.id, sessionId: first.id, expectedRevision: first.revision,
      hostSessionId: 'stale-root', header: carrierHeader('stale-root') });
    assert.equal(conflict.kind, 'conflict');
    await assert.rejects(() => store.bindSession(a.id, { id: 'steal-old', hostSessionId: 'root1', role: 'execution', title: 'Bad' }), /already/);
    await assert.rejects(() => store.bindSessionCarrier({ projectId: a.id, sessionId: first.id, expectedRevision: updated.revision,
      hostSessionId: 'native-child', header: { ...carrierHeader('native-child'), parentSession: 'root1', origin: 'subagent' } as SessionOwnedSessionHeader }), /root creation/);
    await assert.rejects(() => store.removeSessionBinding(a.id, first.id, { expectedHostSessionId: updated.hostSessionId }), /multi-carrier/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v7/v13 relation migration preserves unknown fields, failures and source identity without writes on open', async () => {
  const root = await createTemporaryDirectory('carrier-migration');
  try {
    for (const version of [7, 13]) {
      const id = 'legacy-' + version, directory = join(root, id); await mkdir(directory);
      const main = legacyMainSession(id), target = { ...main, id: 'exec-' + version, role: 'execution', hostSessionId: 'host-exec-' + version,
        archived: true, sourceLifecycle: { kind: 'partial', requestedAt: TIMESTAMP, updatedAt: TIMESTAMP,
          progress: { projectionCache: 'cleared' }, failure: { stage: 'session-log', certainty: 'unknown', message: 'original failure' } },
        unknownSessionExtension: { unchanged: ['retain'] } };
      const original = { version, project: legacyProject(id), sessions: [main, target], deliveries: [],
        unknownOwner: { nested: 'preserve' }, ...(version === 13 ? { communicationOperations: { format: 'projects-communication-operations/v1', operations: [] } } : {}) };
      const path = join(directory, 'record.json'); await writeFile(path, JSON.stringify(original));
      const store = new ProjectStore(root), before = await readFile(path, 'utf8'), snapshot = await store.getSnapshot(id);
      assert.equal(await readFile(path, 'utf8'), before);
      assert.equal(snapshot.sessions[0]!.carriers![0]!.boundAt, undefined);
      assert.equal(snapshot.sessions[0]!.carriers![0]!.header, undefined);
      const migrated = await store.upgradeCarrierRelations(id), raw = await readRecord(root, id);
      assert.equal(raw.version, 14); assert.deepEqual(raw.unknownOwner, original.unknownOwner);
      assert.deepEqual((raw.sessions as Record<string, unknown>[])[1]!.unknownSessionExtension, target.unknownSessionExtension);
      assert.equal(migrated.sessions[1]!.archived, true);
      assert.deepEqual(migrated.sessions[1]!.carriers![0]!.sourceLifecycle, target.sourceLifecycle);
      assert.equal((await new ProjectStore(root).findSessionSourceByHostSessionId(target.hostSessionId))?.id, target.id);
      assert.deepEqual((raw.sessions as Record<string, unknown>[])[1]!.carriers, migrated.sessions[1]!.carriers);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('carrier deletion advances only its exact source while other carriers and current dispatch remain available', async () => {
  const root = await createTemporaryDirectory('carrier-deletion');
  try {
    const store = new ProjectStore(root), project = await store.createProject({ id: 'p', name: 'P' });
    let session = await store.bindSession(project.id, { id: 'exec', hostSessionId: 'old', role: 'execution', title: 'Keep title' });
    session = (await store.bindSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision, hostSessionId: 'now' })).session;
    await assert.rejects(() => store.beginExecutionSourceDeletion({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision }), /carrierHostSessionId/);
    session = (await store.beginExecutionSourceDeletion(carrierInput(session, 'old'))).session;
    session = (await store.recordExecutionSourceDeletion({ ...carrierInput(session, 'old'), progress: { projectionCache: 'cleared' },
      failure: { stage: 'session-log', certainty: 'unknown', message: 'old segment only' } })).session;
    assert.equal(session.sourceLifecycle.kind, 'available'); assert.equal(session.carriers![0]!.sourceLifecycle.kind, 'partial');
    assert.equal((await store.resolveCurrentCarrier(project.id, session.id))?.hostSessionId, 'now');
    session = (await store.beginExecutionSourceDeletion(carrierInput(session, 'old'))).session;
    session = (await store.recordExecutionSourceDeletion({ ...carrierInput(session, 'old'), progress: COMPLETE_CLEANUP })).session;
    session = (await store.completeExecutionSourceDeletion(carrierInput(session, 'old'))).session;
    assert.equal(session.title, 'Keep title'); assert.equal(session.hostSessionId, 'now');
    assert.equal((await new ProjectStore(root).findSessionSourceByHostSessionId('old'))?.sourceLifecycle.kind, 'deleted');
    assert.equal((await store.findSessionSourceByHostSessionId('now'))?.sourceLifecycle.kind, 'available');
    assert.deepEqual(await store.listCatalogClaims(), ['old', 'now']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execution and project archive require all carrier proofs and keep each original owned root', async () => {
  const root = await createTemporaryDirectory('carrier-archive');
  try {
    const store = new ProjectStore(root), project = await store.createProject({ id: 'p', name: 'P' });
    let session = await store.bindSession(project.id, { id: 'exec', hostSessionId: 's1', role: 'execution', title: 'Exec', header: carrierHeader('s1') });
    session = (await store.bindSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      hostSessionId: 's2', header: carrierHeader('s2') })).session;
    await assert.rejects(() => store.commitExecutionArchive({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      ownedLifecycle: carrierArchive('s2') }), /Multi-carrier/);
    await assert.rejects(() => store.commitExecutionArchive({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      carrierLifecycles: [{ hostSessionId: 's2', ownedLifecycle: carrierArchive('s2') }] }), /complete exact/);
    session = (await store.commitExecutionArchive({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      carrierLifecycles: ['s1', 's2'].map(hostSessionId => ({ hostSessionId, ownedLifecycle: carrierArchive(hostSessionId) })) })).session;
    assert.equal(session.archived, true);
    assert.deepEqual(session.carriers!.map(row => row.ownedLifecycle!.rootHeader.id), ['s1', 's2']);
    const minimalRoster = [{ id: session.id, hostSessionId: session.hostSessionId, role: session.role, archived: true }];
    assert.equal((await store.setProjectArchived(project.id, true, minimalRoster)).kind, 'conflict');
    const exactRoster = minimalRoster.map(row => ({ ...row, carrierHostSessionIds: ['s1', 's2'] }));
    const archived = await store.setProjectArchived(project.id, true, exactRoster, ['s1', 's2'].map(carrierHostSessionId => ({
      sessionId: session.id, carrierHostSessionId, ownedLifecycle: carrierArchive(carrierHostSessionId) })));
    assert.equal(archived.kind, 'updated');
    const flatRoster = ['s1', 's2'].map(hostSessionId => ({ ...minimalRoster[0]!, hostSessionId }));
    assert.equal((await store.setProjectArchived(project.id, false, flatRoster)).kind, 'updated');
    assert.deepEqual((await new ProjectStore(root).listSessionCarriers(project.id, session.id)).map(row => row.ownedLifecycle!.rootHeader.id), ['s1', 's2']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project terminal source waits for all carriers and retains each deleted source after cold reopen', async () => {
  const root = await createTemporaryDirectory('carrier-terminal');
  try {
    const store = new ProjectStore(root), project = await store.createProject({ id: 'p', name: 'P' });
    let session = await store.bindSession(project.id, { id: 'main', hostSessionId: 's1', role: 'main', title: 'Main' });
    session = (await store.bindSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision, hostSessionId: 's2' })).session;
    let snapshot = await store.getSnapshot(project.id);
    await assert.rejects(() => store.beginProjectSourceDeletion({ projectId: project.id, expectedRevision: snapshot.project.revision,
      sessions: [{ ...projectDeletionProposal(session), carriers: [session.carriers![1]!] }] }), /complete exact/);
    const flat = snapshot.sessions.flatMap(row => row.carriers!.map(carrier => ({ ...row, hostSessionId: carrier.hostSessionId,
      sourceLifecycle: { kind: 'deleting' as const, requestedAt: TIMESTAMP, updatedAt: TIMESTAMP, progress: {} } })));
    snapshot = await store.beginProjectSourceDeletion({ projectId: project.id, expectedRevision: snapshot.project.revision, sessions: flat });
    snapshot = await store.recordProjectSourceDeletion(project.id, undefined, 'removed');
    for (const host of ['s1', 's2']) {
      session = (await store.getSession(project.id, session.id))!;
      session = (await store.recordExecutionSourceDeletion({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision, hostSessionId: host, projectDeletion: true,
        progress: { ...COMPLETE_CLEANUP, projectSchedules: 'cleared', nativeSchedules: 'cleared' } })).session;
      await store.completeExecutionSourceDeletion({ ...carrierInput(session, host), projectDeletion: true });
      if (host === 's1') await assert.rejects(() => store.completeProjectSourceDeletion(project.id), /not complete/);
    }
    await store.completeProjectSourceDeletion(project.id);
    const cold = new ProjectStore(root); assert.deepEqual(await cold.listProjects(), []);
    assert.deepEqual((await cold.listRetainedSessionSources()).map(row => [row.hostSessionId, row.sourceLifecycle.kind]), [['s1', 'deleted'], ['s2', 'deleted']]);
    assert.equal((await cold.listRetainedSessionSources()).some(row => row.lifecycleTimeBasis !== undefined), false);
    assert.equal((await readRecord(root, project.id)).version, 15);
    assert.equal(await cold.findOperationalMembershipByHostSessionId('s2'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('carrier creation confirmation preserves unknown fields and native child ownership stays separate from handoff', async () => {
  const root = await createTemporaryDirectory('carrier-header-owned');
  try {
    const store = new ProjectStore(root), project = await store.createProject({ id: 'p', name: 'P' });
    let session = await store.bindSession(project.id, { id: 'exec', hostSessionId: 's1', role: 'execution', title: 'Exec' });
    const path = join(root, project.id, 'record.json'), raw = await readRecord(root, project.id);
    const row = (raw.sessions as Record<string, unknown>[])[0]!, first = (row.carriers as Record<string, unknown>[])[0]!;
    first.unknownCarrierExtension = { owner: 'unrelated' }; row.unknownSessionExtension = { preserve: true };
    await writeFile(path, JSON.stringify(raw));
    session = (await store.confirmSessionCarrierHeader({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      hostSessionId: 's1', header: carrierHeader('s1') })).session;
    await assert.rejects(() => store.removeSessionBinding(project.id, session.id, { expectedHostSessionId: 's1' }), /confirmed native creation/);
    await assert.rejects(() => store.confirmSessionCarrierHeader({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      hostSessionId: 's1', header: carrierHeader('s1', 2) }), /cannot change/);
    session = (await store.bindSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision, hostSessionId: 's2' })).session;
    const child = { header: { ...carrierHeader('child', 3), parentSession: 's1', origin: 'subagent' as const, delegationDepth: 1 } as SessionOwnedSessionHeader,
      parentSessionId: 's1', mode: 'one-shot' as const };
    session = (await store.commitExecutionArchive({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      carrierLifecycles: [{ hostSessionId: 's1', ownedLifecycle: { ...carrierArchive('s1'), members: [child] } },
        { hostSessionId: 's2', ownedLifecycle: carrierArchive('s2') }] })).session;
    assert.equal(await store.findCarrierByHostSessionId('child'), undefined);
    assert.equal(session.carriers!.length, 2); assert.equal(session.carriers![0]!.ownedLifecycle!.members[0]!.header.id, 'child');
    session = (await store.updateSession(project.id, session.id, { archived: false }, { expectedRevision: session.revision })).session;
    await assert.rejects(() => store.bindSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      hostSessionId: 'child' }), /already claimed/);
    const saved = await readRecord(root, project.id), savedRow = (saved.sessions as Record<string, unknown>[])[0]!;
    assert.deepEqual(savedRow.unknownSessionExtension, { preserve: true });
    assert.deepEqual((savedRow.carriers as Record<string, unknown>[])[0]!.unknownCarrierExtension, { owner: 'unrelated' });
    session = (await store.closeSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision,
      hostSessionId: 's2', confirmedAt: TIMESTAMP, reason: 'retired' })).session;
    assert.equal(await store.resolveCurrentCarrier(project.id, session.id), undefined);
    assert.equal((await store.findSessionSourceByHostSessionId('s2'))?.sourceLifecycle.kind, 'available');
    assert.equal((await store.setProjectArchived(project.id, true, [{ id: session.id, hostSessionId: 's2', role: session.role,
      archived: false, carrierHostSessionIds: ['s1', 's2'] }])).kind, 'updated');
    await store.setProjectArchived(project.id, false, [{ id: session.id, hostSessionId: 's2', role: session.role,
      archived: false, carrierHostSessionIds: ['s1', 's2'] }]);
    session = (await store.bindSessionCarrier({ projectId: project.id, sessionId: session.id, expectedRevision: session.revision, hostSessionId: 's3' })).session;
    assert.equal((await store.resolveCurrentCarrier(project.id, session.id))?.hostSessionId, 's3');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy terminal exposes project deletion time basis before and after explicit carrier upgrade', async () => {
  const root = await createTemporaryDirectory('carrier-legacy-terminal');
  try {
    const projectId = 'terminal', dir = join(root, projectId); await mkdir(dir);
    const original = { version: 12, terminal: true, unknownTerminalOwner: { keep: true },
      project: { id: projectId, revision: 9, sourceLifecycle: { kind: 'deleted', requestedAt: TIMESTAMP, deletedAt: '2026-01-02T03:09:05.000Z' } },
      sources: [{ id: 'logical', hostSessionId: 'old-root', role: 'execution', revision: 10, unknownSourceExtension: { retain: true } }] };
    const path = join(dir, 'record.json'); await writeFile(path, JSON.stringify(original));
    const store = new ProjectStore(root), before = await readFile(path, 'utf8');
    const source = (await store.findSessionSourceByHostSessionId('old-root'))!;
    assert.equal(source.lifecycleTimeBasis, 'project-deletion'); assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(source.header, undefined);
    const legacy = (await store.getSession(projectId, 'logical'))!;
    assert.equal(legacy.carriers![0]!.lifecycleTimeBasis, 'project-deletion'); assert.equal(legacy.carriers![0]!.boundAt, undefined);
    await store.upgradeCarrierRelations(projectId);
    const raw = await readRecord(root, projectId), saved = (raw.sources as Record<string, unknown>[])[0]!;
    assert.equal(raw.version, 14); assert.equal('hostSessionId' in saved, false);
    assert.deepEqual(raw.unknownTerminalOwner, original.unknownTerminalOwner);
    assert.deepEqual(saved.unknownSourceExtension, original.sources[0]!.unknownSourceExtension);
    const carrier = (saved.carriers as Record<string, unknown>[])[0]!;
    assert.equal(carrier.lifecycleTimeBasis, 'project-deletion'); assert.equal('boundAt' in carrier, false); assert.equal('header' in carrier, false);
    assert.deepEqual((await new ProjectStore(root).findSessionSourceByHostSessionId('old-root'))?.sourceLifecycle, source.sourceLifecycle);
    assert.equal((await new ProjectStore(root).findSessionSourceByHostSessionId('old-root'))?.lifecycleTimeBasis, 'project-deletion');
  } finally { await rm(root, { recursive: true, force: true }); }
});
