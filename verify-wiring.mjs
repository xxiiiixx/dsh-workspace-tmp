/**
 * Integration proof against the real harness packages, not a fake context.
 *
 * Mounts the plugin on a real cordis `Context` together with the shipped
 * `dsh-system-prompt` and `dsh-tools` registries, then reads what the model
 * would actually receive: the assembled prompt text and the registered tool
 * schema — plus one real tool round-trip through the registry, and the real
 * `agent/turn-stopping` waterfall that deletes the directory.
 *
 * Everything it writes lives under the OS temp directory, so running this
 * script never touches the repository or the workspace.
 *
 * @module dsh-workspace-tmp/verify-wiring
 */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'

import { SECTION_NAME, TOOL_NAME, apply, tempRootFor } from './index.js'

/**
 * Resolve a harness package the way the running profile does.
 *
 * A plugin checkout has no `node_modules`; the harness packages live in the
 * dsh installation and reach a profile through its own resolution. Try the
 * local checkout first (when the plugin was installed with dependencies), then
 * every profile that has a `package.json`.
 */
const PROFILE_ROOTS = [
  process.cwd(),
  ...[join(homedir(), '.dsh', 'profiles', 'desktop'), join(homedir(), '.dsh', 'profiles', 'web')]
]

function resolvePackage(specifier) {
  for (const root of PROFILE_ROOTS) {
    try {
      return createRequire(join(root, 'package.json')).resolve(specifier)
    } catch {
      /* not resolvable from here — try the next root */
    }
  }
  throw new Error(
    `cannot resolve ${specifier}; install dsh (or run this from a profile with the harness packages present)`
  )
}

async function load(specifier) {
  if (isBuiltin(specifier)) return import(specifier)
  return import(pathToFileURL(resolvePackage(specifier)).href)
}

const { Context } = await load('@deepseek-ai/cordis')
const systemPrompt = (await load('@deepseek-ai/dsh-system-prompt')).default
const tools = (await load('@deepseek-ai/dsh-tools')).default

let failures = 0
function check(ok, title, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-tmp-verify-'))
const workspace = join(parent, 'project')
await mkdir(workspace, { recursive: true })

const agent = { id: 'session-verify01', session: { id: 'session-verify01', header: { cwd: workspace } } }

const ctx = new Context()
ctx.plugin(systemPrompt)
ctx.plugin(tools)
await new Promise((resolve) => setTimeout(resolve, 50))
// The loader attaches `inject` from the module's named export; a direct
// `ctx.plugin(fn)` call has to carry it on the function itself.
const mount = (pluginCtx) => apply(pluginCtx, {})
mount.inject = ['tools', 'systemPrompt']
ctx.plugin(mount)
await new Promise((resolve) => setTimeout(resolve, 50))

const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
const rendered = assembly.sections.map((section) => section.text).join('\n\n')

check(assembly.sections.some((section) => section.name === SECTION_NAME), 'policy section is registered')
check(rendered.includes('## Scratch files stay out of the project tree'), 'the section reaches the prompt')
check(rendered.includes('temporary directory'), 'the section names the temporary directory')
check(rendered.includes(TOOL_NAME), 'the section names the tool')
check(rendered.includes('deleted automatically when this turn ends'), 'the section states the cleanup default')

const second = (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections.map((s) => s.text).join('\n\n')
check(second === rendered, 'two assemblies render identically (KV-cache safe)')

const schema = ctx.tools.schemas(agent).find((tool) => tool.name === TOOL_NAME)
check(schema !== undefined, 'the tool is visible to an agent scope')
check(schema?.parameters?.required?.includes('action'), 'the schema requires `action`')
check(
  JSON.stringify(schema?.parameters?.properties?.action?.enum) === JSON.stringify(['create', 'write', 'list', 'clean']),
  'the schema lists every action'
)

const signal = new AbortController().signal
const root = tempRootFor({ workspace, sessionId: agent.id })

const created = await ctx.tools.execute({
  callId: 'verify-create',
  name: TOOL_NAME,
  arguments: { action: 'create', name: 'cases' },
  agent,
  signal
})
check(created.isError === false, 'create succeeds through the registry', JSON.stringify(created.error))
check(created.value?.root === root, 'create reports the sibling root', created.value?.root)
check(created.value?.path === join(root, 'cases'), 'create reserves the requested path', created.value?.path)

const written = await ctx.tools.execute({
  callId: 'verify-write',
  name: TOOL_NAME,
  arguments: { action: 'write', name: 'cases/probe.test.ts', content: 'assert.ok(true)\n' },
  agent,
  signal
})
check(written.isError === false, 'write succeeds through the registry', JSON.stringify(written.error))
check(
  written.value?.path === join(root, 'cases', 'probe.test.ts'),
  'write reports the file it created',
  written.value?.path
)
check(written.content?.[0]?.type === 'text', 'write returns model-facing text content')

const listed = await ctx.tools.execute({
  callId: 'verify-list',
  name: TOOL_NAME,
  arguments: { action: 'list' },
  agent,
  signal
})
const listedPaths = (listed.value?.entries ?? []).map((entry) => entry.path)
check(listedPaths.includes('cases/'), 'list shows the directory', listedPaths.join(' | '))
check(listedPaths.includes('cases/probe.test.ts'), 'list shows the file', listedPaths.join(' | '))

check((await readdir(workspace)).length === 0, 'the workspace stayed empty')
check((await readdir(parent)).sort().join(',') === 'project,tmp', 'the temporary root is a sibling, not a child')

// The real waterfall the loop dispatches at the end of a turn.
await ctx.waterfall(
  'agent/turn-stopping',
  { agent, turn: 1, signal },
  async () => undefined
)

let gone = false
try {
  await readdir(root)
} catch {
  gone = true
}
check(gone, 'turn-stopping deletes the temporary directory')
check((await readdir(parent)).join(',') === 'project', 'the sibling directory is pruned when empty')
check((await readdir(workspace)).length === 0, 'the workspace is still untouched')

await rm(parent, { recursive: true, force: true })

console.log(failures === 0 ? '\nIntegration OK.\n' : `\n${failures} integration check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
