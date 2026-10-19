/**
 * Verify the INSTALLED copy (profile/node_modules), not the workspace source.
 *
 * Resolves the plugin through the desktop profile exactly as the Loader does,
 * mounts it beside the shipped `dsh-system-prompt` and `dsh-tools` registries,
 * and asserts what the model would actually receive.
 *
 * Run: node verify-installed.mjs [profileDir]
 */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const profileDir = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const require = createRequire(join(profileDir, 'package.json'))

const load = async (specifier) => import(pathToFileURL(require.resolve(specifier)).href)

let failures = 0
function check(ok, title, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const installedEntry = require.resolve('dsh-workspace-tmp')
console.log(`installed entry: ${installedEntry}`)
const plugin = await load('dsh-workspace-tmp')

const { Context } = await load('@deepseek-ai/cordis')
const systemPrompt = (await load('@deepseek-ai/dsh-system-prompt')).default
const tools = (await load('@deepseek-ai/dsh-tools')).default

const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-tmp-installed-'))
const workspace = join(parent, 'project')
await mkdir(workspace, { recursive: true })
const agent = { id: 'session-install1', session: { id: 'session-install1', header: { cwd: workspace } } }

const ctx = new Context()
ctx.plugin(systemPrompt)
ctx.plugin(tools)
await new Promise((resolve) => setTimeout(resolve, 50))
const mount = (pluginCtx) => plugin.apply(pluginCtx, {})
mount.inject = plugin.inject
ctx.plugin(mount)
await new Promise((resolve) => setTimeout(resolve, 50))

check(typeof plugin.apply === 'function', 'the installed package exports apply()')
check(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), 'inject names the tool registry')

const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
const rendered = assembly.sections.map((section) => section.text).join('\n\n')
const expectedRoot = join(parent, 'tmp', 'project-install1')

check(
  assembly.sections.some((section) => section.name === plugin.SECTION_NAME),
  'the policy section is registered'
)
check(rendered.includes(expectedRoot), 'the section names this session\'s root', expectedRoot)
check(rendered.includes('## Scratch files stay out of the project tree'), 'the heading reaches the prompt')
check(rendered.includes('workspace_tmp'), 'the section names the tool')
check(rendered.includes('workspace'), 'the section names the workspace boundary')

const schema = ctx.tools.schemas(agent).find((tool) => tool.name === plugin.TOOL_NAME)
check(schema !== undefined, 'the tool is visible to the agent scope')

const signal = new AbortController().signal
const exec = { agent, signal }

const created = await ctx.tools.execute({
  callId: 'inst-create',
  name: plugin.TOOL_NAME,
  arguments: { action: 'create', name: 'cases' },
  agent,
  signal
})
check(created.isError === false, 'create succeeds through the real registry', JSON.stringify(created.error))
check(created.value.root === expectedRoot, 'the root is the sibling directory', created.value.root)

const written = await ctx.tools.execute({
  callId: 'inst-write',
  name: plugin.TOOL_NAME,
  arguments: { action: 'write', name: 'cases/run.test.mjs', content: 'export default 1\n' },
  agent,
  signal
})
check(written.isError === false, 'write succeeds through the real registry', JSON.stringify(written.error))
check(written.content[0].type === 'text', 'write returns model-facing text')

const listed = await ctx.tools.execute({
  callId: 'inst-list',
  name: plugin.TOOL_NAME,
  arguments: { action: 'list' },
  agent,
  signal
})
const paths = listed.value.entries.map((entry) => entry.path)
check(paths.includes('cases/run.test.mjs'), 'list shows the written file', paths.join(' | '))
check((await readdir(workspace)).length === 0, 'the workspace stayed empty')

await ctx.waterfall('agent/turn-stopping', { agent, turn: 1, signal }, async () => undefined)
let gone = false
try {
  await readdir(expectedRoot)
} catch {
  gone = true
}
check(gone, 'the turn end removes the directory')
check((await readdir(workspace)).length === 0, 'the workspace is still untouched')

await rm(parent, { recursive: true, force: true })

console.log(failures === 0 ? '\nInstalled copy OK.\n' : `\n${failures} installed check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
