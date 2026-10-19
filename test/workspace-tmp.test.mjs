/**
 * Behavioural tests for dsh-workspace-tmp, run against a minimal fake `ctx`.
 *
 * The fake mirrors the exact contract the harness exposes for the pieces this
 * plugin touches:
 *   - `ctx.effect(factory, label)` runs the factory and returns its disposer
 *   - `ctx.systemPrompt.section(section)` records the registration
 *   - `ctx.tools.register(definition)` records the definition
 *   - `ctx.on(event, listener)` records the listener
 *   - `ctx.get(name)` returns undefined (no optional services in the fake)
 *
 * Real filesystem I/O runs under `os.tmpdir()`, so the tests never write into
 * this repository.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import test from 'node:test'

import {
  ACTIONS,
  MARKER_NAME,
  SECTION_NAME,
  SECTION_ORDER,
  TOOL_NAME,
  apply,
  cleanRoot,
  createRoot,
  listRoot,
  normalizeConfig,
  readMarker,
  renderPolicy,
  resolveInside,
  safeName,
  shortSessionId,
  tempRootFor,
  workspaceOf
} from '../index.js'

/** A fake plugin context recording what the plugin registers. */
function createFakeCtx() {
  const sections = []
  const tools = []
  const listeners = []
  const logs = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      }
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      }
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    get() {
      return undefined
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args])
    }
  }
  return { ctx, sections, tools, listeners, logs }
}

/** A fake agent with one workspace directory. */
function fakeAgent(workspace, id = 'session-0123abcd') {
  return { id, session: { id, header: { cwd: workspace } } }
}

/** Create a throwaway workspace under the OS temp directory. */
async function makeWorkspace() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-tmp-test-'))
  const workspace = join(parent, 'project')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'index.ts'), 'export const value = 1\n', 'utf8')
  return { parent, workspace }
}

test('the temporary root is a sibling of the workspace, never inside it', async () => {
  const { workspace } = await makeWorkspace()
  const root = tempRootFor({ workspace, sessionId: 'session-0123abcd' })
  const rel = relative(workspace, root)
  assert.equal(rel.startsWith('..'), true, `root ${root} must not be inside ${workspace}`)
  assert.equal(dirname(dirname(root)), dirname(workspace))
  assert.equal(basename(dirname(root)), 'tmp')
  assert.equal(basename(root), 'project-0123abcd')
})

test('a workspace literally named tmp cannot collide with the sibling directory', async () => {
  const { parent } = await makeWorkspace()
  const workspace = join(parent, 'tmp')
  await mkdir(workspace, { recursive: true })
  const root = tempRootFor({ workspace, sessionId: 'abc12345' })
  assert.equal(root, join(parent, 'tmp', 'tmp-abc12345'))
  assert.equal(relative(workspace, root).startsWith('..'), false)
})

test('safeName and shortSessionId normalise hostile input', () => {
  assert.equal(safeName('my project'), 'my project')
  assert.equal(safeName('a/b:c*d'), 'a-b-c-d')
  assert.equal(safeName('   '), 'workspace')
  assert.equal(safeName('..hidden..'), 'hidden')
  assert.equal(shortSessionId('Session-0123-ABCD-xyz'), '0123abcd')
  assert.equal(shortSessionId('abc12345'), 'abc12345')
  assert.equal(shortSessionId(''), 'session')
})

test('resolveInside accepts nested paths and refuses escapes', () => {
  const root = join(tmpdir(), 'root')
  assert.equal(resolveInside(root, 'a/b.txt'), join(root, 'a', 'b.txt'))
  assert.equal(resolveInside(root, ''), root)
  for (const escape of ['../outside.txt', '../../etc/passwd', '/etc/passwd', 'a/../../b']) {
    assert.throws(() => resolveInside(root, escape), /leaves the temporary directory/)
  }
})

test('normalizeConfig applies defaults and fails loud on bad input', () => {
  assert.deepEqual(normalizeConfig(undefined), { siblingDir: 'tmp', autoClean: 'turn' })
  assert.deepEqual(normalizeConfig({}), { siblingDir: 'tmp', autoClean: 'turn' })
  assert.deepEqual(normalizeConfig({ siblingDir: 'scratch', autoClean: 'SESSION' }), {
    siblingDir: 'scratch',
    autoClean: 'session'
  })
  assert.deepEqual(normalizeConfig({ autoClean: false }), { siblingDir: 'tmp', autoClean: 'off' })
  assert.deepEqual(normalizeConfig({ autoClean: true }), { siblingDir: 'tmp', autoClean: 'turn' })

  assert.throws(() => normalizeConfig({ unknown: 1 }), /unknown config key/)
  assert.throws(() => normalizeConfig({ siblingDir: '' }), /one directory name/)
  assert.throws(() => normalizeConfig({ siblingDir: 'a/b' }), /one directory name/)
  assert.throws(() => normalizeConfig({ siblingDir: 7 }), /must be a string/)
  assert.throws(() => normalizeConfig({ autoClean: 'forever' }), /autoClean/)
})

test('workspaceOf reads the session directory and tolerates absence', () => {
  assert.equal(workspaceOf({ session: { header: { cwd: '/work' } } }), '/work')
  assert.equal(workspaceOf({ session: { header: {} } }), undefined)
  assert.equal(workspaceOf(undefined), undefined)
})

test('renderPolicy names the root and the cleanup mode', () => {
  const turn = renderPolicy({ autoClean: 'turn' }, '/parent/tmp/p-1')
  assert.match(turn, /\/parent\/tmp\/p-1/)
  assert.match(turn, /deleted automatically when this turn ends/)
  assert.match(turn, /workspace_tmp/)

  const session = renderPolicy({ autoClean: 'session' }, '/parent/tmp/p-1')
  assert.match(session, /deleted automatically when this session closes/)

  const off = renderPolicy({ autoClean: 'off' }, '/parent/tmp/p-1')
  assert.match(off, /action: "clean"/)
})

test('createRoot, listRoot and cleanRoot round-trip without touching the workspace', async () => {
  const { parent, workspace } = await makeWorkspace()
  const root = tempRootFor({ workspace, sessionId: 'session-abcdef01' })

  await createRoot(root, 'tests/probe.test.ts', { sessionId: 'session-abcdef01', workspace })
  assert.equal((await readMarker(root))?.tool, 'dsh-workspace-tmp')
  assert.equal((await readMarker(root))?.workspace, workspace)
  assert.deepEqual(await readdir(workspace), ['index.ts'], 'workspace must stay untouched')

  await writeFile(join(root, 'tests', 'probe.test.ts'), 'assert.ok(true)\n', 'utf8')
  const entries = await listRoot(root)
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['tests/', 'tests/probe.test.ts']
  )
  assert.equal(entries[1].bytes, 16)
  assert.equal(entries.some((entry) => entry.path.includes(MARKER_NAME)), false)

  const cleaned = await cleanRoot(root, 'tmp')
  assert.equal(cleaned.removed, 2)
  await assert.rejects(readdir(root))
  // The sibling `tmp/` is pruned once it is empty, and the workspace survives.
  assert.deepEqual(await readdir(parent), ['project'])
  assert.deepEqual(await readdir(workspace), ['index.ts'])
})

test('cleanRoot refuses a directory this plugin did not create', async () => {
  const { parent } = await makeWorkspace()
  const stranger = join(parent, 'stranger')
  await mkdir(stranger, { recursive: true })
  await writeFile(join(stranger, 'keep.txt'), 'do not delete me\n', 'utf8')

  await assert.rejects(cleanRoot(stranger, 'tmp'), /refusing to delete/)
  assert.deepEqual(await readdir(stranger), ['keep.txt'])

  // A missing root is not an error: cleanup stays idempotent.
  assert.deepEqual(await cleanRoot(join(parent, 'absent'), 'tmp'), { removed: 0, root: join(parent, 'absent') })
})

test('apply registers one section and one tool, and cleans up at turn end', async () => {
  const { parent, workspace } = await makeWorkspace()
  const agent = fakeAgent(workspace)
  const { ctx, sections, tools, listeners } = createFakeCtx()

  apply(ctx, {})

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, SECTION_NAME)
  assert.equal(sections[0].order, SECTION_ORDER)
  const text = sections[0].text({ agent })
  assert.match(text, /## Scratch files stay out of the project tree/)
  assert.equal(sections[0].text({}), '', 'a session without a workspace gets no section')

  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, TOOL_NAME)
  assert.deepEqual(tool.parameters.properties.action.enum, ACTIONS)
  assert.deepEqual(tool.parameters.required, ['action'])

  const root = tempRootFor({ workspace, sessionId: agent.id })
  const exec = { agent, signal: new AbortController().signal }

  const created = await tool.execute({ action: 'create', name: 'cases' }, exec)
  assert.equal(created.root, root)
  assert.equal(created.path, join(root, 'cases'))

  const written = await tool.execute({ action: 'write', name: 'cases/a.test.ts', content: 'ok\n' }, exec)
  assert.equal(written.path, join(root, 'cases', 'a.test.ts'))
  assert.equal(await readFile(join(root, 'cases', 'a.test.ts'), 'utf8'), 'ok\n')

  const listed = await tool.execute({ action: 'list' }, exec)
  assert.deepEqual(
    listed.entries.map((entry) => entry.path),
    ['cases/', 'cases/a.test.ts']
  )

  await assert.rejects(tool.execute({ action: 'nope' }, exec), /action/)
  await assert.rejects(tool.execute({ action: 'list', extra: 1 }, exec), /unknown key/)
  await assert.rejects(tool.execute({ action: 'write', name: 'x' }, exec), /requires string `content`/)
  await assert.rejects(tool.execute({ action: 'write', name: '../escape', content: 'x' }, exec), /leaves the temporary directory/)
  await assert.rejects(tool.execute({ action: 'list' }, { signal: exec.signal }), /no workspace directory/)

  // The turn-stopping listener is the default cleanup path.
  const stopping = listeners.filter((entry) => entry.event === 'agent/turn-stopping')
  assert.equal(stopping.length, 1)
  await stopping[0].listener({ agent, turn: 1, signal: exec.signal })
  await assert.rejects(readdir(root))
  assert.deepEqual(await readdir(parent), ['project'])

  // Idempotent: a second turn with nothing created does not throw.
  await stopping[0].listener({ agent, turn: 2, signal: exec.signal })
})

/** Poll until `path` is gone, or fail after a bounded wait. */
async function expectGone(path) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await readdir(path)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`${path} still exists`)
}

test('turn/end also cleans up, covering error and abort endings', async () => {
  const { workspace } = await makeWorkspace()
  const agent = fakeAgent(workspace)
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, {})

  const root = tempRootFor({ workspace, sessionId: agent.id })
  await createRoot(root, 'probe.txt', { sessionId: agent.id, workspace })
  await writeFile(join(root, 'probe.txt'), 'probe\n', 'utf8')

  const turnEnd = listeners.find((entry) => entry.event === 'session/event')
  assert.ok(turnEnd, 'a turn/end listener is registered')
  turnEnd.listener(agent.session, { type: 'step/end' })
  assert.deepEqual(await readdir(root).then((names) => names.sort()), ['.dsh-workspace-tmp.json', 'probe.txt'])

  turnEnd.listener(agent.session, { type: 'turn/end' })
  await expectGone(root)
})

test('autoClean "session" cleans on disposal and leaves the turn alone', async () => {
  const { workspace } = await makeWorkspace()
  const agent = fakeAgent(workspace)
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, { autoClean: 'session' })

  assert.equal(listeners.some((entry) => entry.event === 'agent/turn-stopping'), false)
  assert.equal(listeners.some((entry) => entry.event === 'session/event'), false)

  const root = tempRootFor({ workspace, sessionId: agent.id })
  await createRoot(root, undefined, { sessionId: agent.id, workspace })

  const disposed = listeners.find((entry) => entry.event === 'agent/disposed')
  disposed.listener({ agent })
  await expectGone(root)
})

test('autoClean "off" registers no cleanup at all', async () => {
  const { workspace } = await makeWorkspace()
  const { ctx, listeners } = createFakeCtx()
  apply(ctx, { autoClean: 'off' })
  assert.deepEqual(listeners, [])

  const agent = fakeAgent(workspace)
  const root = tempRootFor({ workspace, sessionId: agent.id })
  await createRoot(root, undefined, { sessionId: agent.id, workspace })
  assert.deepEqual(await readdir(root), [MARKER_NAME])
})

test('a custom siblingDir is honoured end to end', async () => {
  const { parent, workspace } = await makeWorkspace()
  const agent = fakeAgent(workspace)
  const { ctx, sections } = createFakeCtx()
  apply(ctx, { siblingDir: 'scratch' })

  const root = tempRootFor({ workspace, sessionId: agent.id, siblingDir: 'scratch' })
  assert.equal(basename(dirname(root)), 'scratch')
  assert.match(sections[0].text({ agent }), /scratch/)

  await createRoot(root, 'a.txt', { sessionId: agent.id, workspace })
  await rm(join(parent, 'scratch'), { recursive: true })
})
