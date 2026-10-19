/**
 * dsh-workspace-tmp — scratch files never land in the project tree.
 *
 * The plugin contributes exactly two model-visible surfaces:
 *
 * 1. One system-prompt section (`workspace-tmp:policy`) that names the
 *    session's temporary directory and states the rule: test files you write to
 *    try something, fixtures, generated data, logs and probes go there, not
 *    next to project sources.
 * 2. One tool (`workspace_tmp`) that creates, writes, lists and deletes that
 *    directory, so the rule is mechanically usable rather than advice only.
 *
 * The directory itself is a *sibling* of the workspace, never a child:
 *
 *   <workspace parent>/tmp/<workspace name>-<session short id>/
 *
 * Keeping it out of the workspace means it is never part of a repository, so
 * no `.gitignore` entry and no `git status` noise, and the project directory
 * stays exactly as the user left it.
 *
 * Cleanup is automatic: the directory is removed when the turn ends (default),
 * when the session is disposed (`autoClean: "session"`), or never
 * (`autoClean: "off"`). A marker file records ownership, and deletion refuses
 * to touch a directory the plugin did not create.
 *
 * @module dsh-workspace-tmp
 */

import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'workspace-tmp'

/** The two registries this row contributes to. */
export const inject = ['tools', 'systemPrompt']

/** Section name; the `workspace-tmp:` prefix keeps it in the plugin's own band. */
export const SECTION_NAME = 'workspace-tmp:policy'

/**
 * Order band. `100-199` is shipped tool guidance, and ask-first sits at 150;
 * this behavioural rule reads right beside it.
 */
export const SECTION_ORDER = 152

/** Model-facing tool name. */
export const TOOL_NAME = 'workspace_tmp'

/** Marker file written into every root; its presence is the ownership proof. */
export const MARKER_NAME = '.dsh-workspace-tmp.json'

/** Value of `tool` inside the marker. */
export const MARKER_TOOL = 'dsh-workspace-tmp'

/** Every action the tool accepts, in the order the description names them. */
export const ACTIONS = ['create', 'write', 'list', 'clean']

/** Bound on entries returned by one `list`; the model can re-list after cleanup. */
export const MAX_LISTED_ENTRIES = 200

/** Maximum directory depth `list` descends, guarding against runaway trees. */
export const MAX_LIST_DEPTH = 6

/** Strip characters that cannot appear in a portable path segment. */
export function safeName(value) {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
  return cleaned === '' ? 'workspace' : cleaned
}

/** A stable, filesystem-safe short form of the session id. */
export function shortSessionId(sessionId) {
  const cleaned = String(sessionId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  const withoutPrefix = cleaned.startsWith('session') ? cleaned.slice('session'.length) : cleaned
  return withoutPrefix === '' ? 'session' : withoutPrefix.slice(0, 8)
}

/**
 * The temporary root for one workspace and session.
 *
 * `dirname(workspace)` is the sibling location by construction: the returned
 * path is never a descendant of the workspace unless the workspace is itself a
 * filesystem root (where every path is a descendant and this is unavoidable).
 *
 * @param {object} input - the root inputs.
 * @param {string} input.workspace - absolute workspace directory.
 * @param {string} input.sessionId - session owning the root.
 * @param {string} [input.siblingDir] - sibling directory name, default `tmp`.
 * @returns {string} absolute temporary root.
 */
export function tempRootFor({ workspace, sessionId, siblingDir = 'tmp' }) {
  const parent = dirname(workspace)
  const workspaceName = safeName(basename(workspace) || 'workspace')
  return join(parent, siblingDir, `${workspaceName}-${shortSessionId(sessionId)}`)
}

/**
 * Resolve a model-supplied relative name inside the root, refusing escapes.
 *
 * @param {string} root - absolute temporary root.
 * @param {string} requested - relative path supplied by the model.
 * @returns {string} absolute path inside the root.
 * @throws when the name is absolute or leaves the root.
 */
export function resolveInside(root, requested) {
  const target = resolve(root, requested)
  const rel = relative(root, target)
  if (rel === '') return target
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `workspace_tmp: ${JSON.stringify(requested)} leaves the temporary directory; pass a relative path inside it`
    )
  }
  return target
}

/** Canonical error text, whether or not the thrown value is an Error. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a path exists at all. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the ownership marker, or `undefined` when the root is absent or was not
 * created by this plugin. Never throws.
 *
 * @param {string} root - the candidate temporary root.
 * @returns {Promise<object | undefined>} the marker record when owned.
 */
export async function readMarker(root) {
  try {
    const record = JSON.parse(await readFile(join(root, MARKER_NAME), 'utf8'))
    return record?.tool === MARKER_TOOL ? record : undefined
  } catch {
    return undefined
  }
}

/** Write the ownership marker; idempotent, so repeat calls keep the first record. */
async function writeMarker(root, sessionId, workspace) {
  const file = join(root, MARKER_NAME)
  if (await exists(file)) return
  const record = {
    tool: MARKER_TOOL,
    sessionId: String(sessionId ?? ''),
    workspace: String(workspace ?? ''),
    createdAt: new Date().toISOString()
  }
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

/**
 * Create the root (and the requested path inside it).
 *
 * @param {string} root - absolute temporary root.
 * @param {string} requested - optional relative path to reserve.
 * @param {{ sessionId?: string, workspace?: string }} meta - marker contents.
 * @returns {Promise<{ root: string, path: string }>} the root and the reserved path.
 */
export async function createRoot(root, requested, meta = {}) {
  await mkdir(root, { recursive: true })
  await writeMarker(root, meta.sessionId, meta.workspace)
  if (requested === undefined || requested === null || String(requested).trim() === '') {
    return { root, path: root }
  }
  const target = resolveInside(root, String(requested))
  await mkdir(dirname(target), { recursive: true })
  return { root, path: target }
}

/**
 * List the root's entries as relative paths, bounded by count and depth.
 *
 * @param {string} root - absolute temporary root.
 * @param {AbortSignal} [signal] - cancellation between entries.
 * @returns {Promise<Array<{ path: string, kind: string, bytes: number }>>} entries.
 */
export async function listRoot(root, signal) {
  const entries = []
  const walk = async (directory, depth) => {
    if (entries.length >= MAX_LISTED_ENTRIES || depth > MAX_LIST_DEPTH) return
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (entries.length >= MAX_LISTED_ENTRIES) return
      signal?.throwIfAborted()
      const full = join(directory, child.name)
      const rel = relative(root, full).split('\\').join('/')
      if (rel === MARKER_NAME) continue
      if (child.isDirectory()) {
        entries.push({ path: `${rel}/`, kind: 'directory', bytes: 0 })
        await walk(full, depth + 1)
        continue
      }
      let bytes = 0
      try {
        bytes = (await stat(full)).size
      } catch {
        bytes = 0
      }
      entries.push({ path: rel, kind: 'file', bytes })
    }
  }
  await walk(root, 0)
  return entries
}

/**
 * Delete the root, then prune the sibling directory when it became empty.
 *
 * Refuses a directory this plugin did not create: only the marker makes a
 * path deletable, so a workspace literally named `tmp` can never be wiped by a
 * mistaken path computation.
 *
 * @param {string} root - absolute temporary root.
 * @param {string} [siblingDir] - sibling directory name, for the empty prune.
 * @returns {Promise<{ removed: number, root: string }>} deletion outcome.
 */
export async function cleanRoot(root, siblingDir = 'tmp') {
  const marker = await readMarker(root)
  if (marker === undefined) {
    if (await exists(root)) {
      throw new Error(
        `workspace_tmp: refusing to delete ${root}: it exists but carries no ${MARKER_NAME} marker, so this plugin did not create it`
      )
    }
    return { removed: 0, root }
  }
  const entries = await listRoot(root)
  await rm(root, { recursive: true, force: true })
  const parent = dirname(root)
  if (basename(parent) === siblingDir) {
    // Best effort: a non-empty sibling directory (another session) stays.
    try {
      await rmdir(parent)
    } catch {
      /* not empty, already gone, or otherwise not removable — leave it */
    }
  }
  return { removed: entries.length, root }
}

/**
 * Validate configuration fail-loud. Unknown keys and illegal values throw at
 * load instead of degrading into a silently different layout.
 *
 * @param {unknown} config - raw row config from the profile.
 * @returns {{ siblingDir: string, autoClean: 'turn'|'session'|'off' }} settings.
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const known = ['siblingDir', 'autoClean']
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      throw new Error(`workspace-tmp: unknown config key ${JSON.stringify(key)}; expected one of ${known.join(', ')}`)
    }
  }

  const siblingDirRaw = raw.siblingDir ?? 'tmp'
  if (typeof siblingDirRaw !== 'string') {
    throw new Error(`workspace-tmp: \`siblingDir\` must be a string, got ${typeof siblingDirRaw}`)
  }
  const siblingDir = siblingDirRaw.trim()
  if (siblingDir === '' || siblingDir === '.' || siblingDir === '..' || /[\\/]/.test(siblingDir)) {
    throw new Error(
      `workspace-tmp: \`siblingDir\` must be one directory name without a separator, got ${JSON.stringify(siblingDirRaw)}`
    )
  }

  const autoCleanRaw = raw.autoClean ?? 'turn'
  const autoClean = autoCleanRaw === true ? 'turn' : autoCleanRaw === false ? 'off' : String(autoCleanRaw).trim().toLowerCase()
  if (!['turn', 'session', 'off'].includes(autoClean)) {
    throw new Error(
      `workspace-tmp: \`autoClean\` must be "turn", "session", or "off"; got ${JSON.stringify(autoCleanRaw)}`
    )
  }

  return { siblingDir, autoClean }
}

/**
 * The absolute workspace directory a session writes in.
 *
 * @param {object | undefined} agent - the owning agent, when there is one.
 * @returns {string | undefined} absolute directory, or undefined without one.
 */
export function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The policy section text. Deterministic for a session, so the system prompt
 * stays byte-identical across that session's steps and the KV-cache prefix is
 * not disturbed.
 *
 * @param {object} settings - resolved configuration.
 * @param {string} root - the session's temporary root.
 * @returns {string} the section text.
 */
export function renderPolicy(settings, root) {
  const cleanup =
    settings.autoClean === 'turn'
      ? 'It is deleted automatically when this turn ends, so nothing is left behind.'
      : settings.autoClean === 'session'
        ? 'It is deleted automatically when this session closes, so nothing is left behind.'
        : 'Nothing deletes it automatically in this deployment — call the tool with `action: "clean"` when you are done.'
  return [
    '## Scratch files stay out of the project tree',
    '',
    `This session's temporary directory is \`${root}\`. It is a sibling of the workspace, not a child, so it is never part of the project and never shows up in version control.`,
    '',
    'Use it for anything that only exists to try something out: test files you write to check behaviour, fixtures and sample inputs, generated data, captured logs, benchmark probes, throwaway scripts, build or conversion by-products.',
    '',
    '- Write those files under the temporary directory. Do not create `test.tmp.ts`, `scratch.py`, sample output, or one-off fixtures next to project sources.',
    '- `workspace_tmp` manages it: `action: "create"` makes the directory and can reserve a path, `action: "write"` writes a file inside it, `action: "list"` shows what is there, `action: "clean"` deletes it now.',
    '- The native write tools are fenced to the workspace by the file sandbox, so they may refuse a path outside it. `workspace_tmp` with `action: "write"` is the supported way to create a scratch file there; the native `read`/`bash` tools can still read and run it.',
    `- ${cleanup}`,
    '- If a scratch file must outlive the turn, say so to the user and ask where it belongs; do not move it into the project to keep it.',
    '- Real project changes still go through the normal read/write/edit tools on the real files. Never copy a project file into the temporary directory to "edit" it there.'
  ].join('\n')
}

/** Render a bounded, human-readable result for the model and the transcript. */
function renderResult(value) {
  if (value.action === 'list') {
    if (value.entries.length === 0) return `${value.root}\n(no files)`
    const lines = value.entries.map((entry) =>
      entry.kind === 'directory' ? `${entry.path}` : `${entry.path}  (${entry.bytes} bytes)`
    )
    const suffix = value.entries.length >= MAX_LISTED_ENTRIES ? `\n… truncated at ${MAX_LISTED_ENTRIES} entries` : ''
    return `${value.root}\n${lines.join('\n')}${suffix}`
  }
  return value.message
}

/**
 * Refuse arguments the published schema does not declare. A raw
 * `tools.register()` definition is not argument-checked by the registry, so
 * the tool validates its own surface.
 */
function assertArguments(args) {
  const allowed = ['action', 'name', 'content']
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('workspace_tmp: arguments must be an object')
  }
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `workspace_tmp: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this tool accepts ${allowed.join(', ')}`
    )
  }
  if (!ACTIONS.includes(args.action)) {
    throw new Error(`workspace_tmp: \`action\` must be one of ${ACTIONS.join(', ')}; got ${JSON.stringify(args.action)}`)
  }
  for (const key of ['name', 'content']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw new Error(`workspace_tmp: \`${key}\` must be a string, got ${typeof args[key]}`)
    }
  }
  if (args.action === 'write') {
    if (typeof args.content !== 'string') throw new Error('workspace_tmp: `write` requires string `content`')
    if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('workspace_tmp: `write` requires `name`')
  }
}

/**
 * Install the plugin.
 *
 * @param {import('cordis').Context} ctx - plugin context; every registration is
 *   scoped to it and disposed with its fiber.
 * @param {Record<string, unknown>} [config] - raw row config from the profile.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)

  /** Resolve the root for an agent, or undefined when it has no workspace. */
  const rootFor = (agent) => {
    const workspace = workspaceOf(agent)
    if (workspace === undefined) return undefined
    return tempRootFor({ workspace, sessionId: agent.id, siblingDir: settings.siblingDir })
  }

  /** Whether the session's file policy forbids writes altogether. */
  const readOnly = (agent) => {
    try {
      const policy = ctx.get('sandboxPolicy')?.resolve?.({ session: agent.session })
      return policy?.mode === 'read-only'
    } catch {
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: (context) => {
          const root = rootFor(context.agent)
          return root === undefined ? '' : renderPolicy(settings, root)
        }
      }),
    'workspace-tmp.section()'
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description:
          "Reserve and manage this session's temporary directory for scratch files — test files written to try behaviour, fixtures, generated data, logs, one-off scripts and probes — so they never land in the project tree. The directory is a sibling of the workspace (`<workspace parent>/<siblingDir>/<workspace name>-<session short id>`), outside any repository, and is deleted automatically at the end of the turn by default. Actions: `create` makes the directory and optionally reserves a path; `write` writes a file inside it (use this when the native write tool is fenced out by the file sandbox); `list` shows what is there; `clean` deletes it now.",
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ACTIONS,
              description:
                'create (make the directory, optionally reserving `name`), write (write `content` to `name`), list (enumerate the directory), clean (delete the directory now).'
            },
            name: {
              type: 'string',
              description:
                'Relative path inside the temporary directory, e.g. `tests/probe.test.ts`. Required for `write`; optional for `create`; ignored by `list` and `clean`.'
            },
            content: {
              type: 'string',
              description: 'Full UTF-8 file content. Required for `write`, ignored otherwise.'
            }
          },
          required: ['action']
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ACTIONS
              },
              root: {
                type: 'string'
              },
              path: {
                type: 'string'
              },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: {
                      type: 'string'
                    },
                    kind: {
                      type: 'string'
                    },
                    bytes: {
                      type: 'integer'
                    }
                  },
                  required: ['path', 'kind']
                }
              },
              removed: {
                type: 'integer'
              },
              message: {
                type: 'string'
              }
            },
            required: ['action', 'root', 'message']
          },
          render: (_args, value) => [{ type: 'text', text: renderResult(value) }]
        },
        isConcurrencySafe: () => false,
        presentCall: (args) => ({
          card: 'generic',
          title: `workspace_tmp · ${args.action}`,
          kind: 'other',
          rawInput: args.name === undefined ? undefined : args.name
        }),
        async execute(args, exec) {
          assertArguments(args)
          const agent = exec.agent
          const root = rootFor(agent)
          if (root === undefined) {
            throw new Error('workspace_tmp: this session has no workspace directory to place a temporary directory beside')
          }
          if (readOnly(agent)) {
            throw new Error('workspace_tmp: unavailable under the read-only file policy')
          }
          exec.signal?.throwIfAborted()

          if (args.action === 'create') {
            const created = await createRoot(root, args.name, {
              sessionId: agent.id,
              workspace: workspaceOf(agent)
            })
            return {
              action: 'create',
              root: created.root,
              path: created.path,
              message: `Temporary directory ready: ${created.path}`
            }
          }

          if (args.action === 'write') {
            const created = await createRoot(root, args.name, {
              sessionId: agent.id,
              workspace: workspaceOf(agent)
            })
            await writeFile(created.path, args.content, 'utf8')
            return {
              action: 'write',
              root: created.root,
              path: created.path,
              message: `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${created.path}`
            }
          }

          if (args.action === 'list') {
            if (!(await exists(root))) {
              return { action: 'list', root, entries: [], message: `No temporary directory at ${root}` }
            }
            const entries = await listRoot(root, exec.signal)
            return {
              action: 'list',
              root,
              entries,
              message: `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} under ${root}`
            }
          }

          const cleaned = await cleanRoot(root, settings.siblingDir)
          return {
            action: 'clean',
            root: cleaned.root,
            removed: cleaned.removed,
            message:
              cleaned.removed === 0
                ? `Nothing to clean at ${cleaned.root}`
                : `Removed ${cleaned.removed} ${cleaned.removed === 1 ? 'entry' : 'entries'} from ${cleaned.root}`
          }
        }
      }),
    'workspace-tmp.tool()'
  )

  /** Best-effort cleanup; a failure is reported, never thrown into the turn. */
  const cleanupFor = async (agent, reason) => {
    if (settings.autoClean === 'off') return
    const root = rootFor(agent)
    if (root === undefined) return
    try {
      await cleanRoot(root, settings.siblingDir)
    } catch (error) {
      ctx.logger?.warn?.(`workspace-tmp: cleanup after ${reason} failed: ${messageOf(error)}`)
    }
  }

  if (settings.autoClean === 'turn') {
    // Awaited: the turn does not close until the directory is gone.
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      await cleanupFor(agent, 'turn')
    })
    // Backstop for turns that end in an error or abort, where the serial
    // `agent/turn-stopping` dispatch above never runs.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const workspace = typeof session?.header?.cwd === 'string' && session.header.cwd !== ''
        ? session.header.cwd
        : undefined
      if (workspace === undefined) return
      const root = tempRootFor({ workspace, sessionId: session.id, siblingDir: settings.siblingDir })
      void cleanRoot(root, settings.siblingDir).catch((error) => {
        ctx.logger?.warn?.(`workspace-tmp: cleanup after turn/end failed: ${messageOf(error)}`)
      })
    })
  }

  if (settings.autoClean === 'session') {
    ctx.on('agent/disposed', ({ agent }) => {
      void cleanupFor(agent, 'session disposal')
    })
  }

  ctx.logger?.info?.(
    'workspace-tmp: policy section %s active (siblingDir: %s; autoClean: %s)',
    SECTION_NAME,
    settings.siblingDir,
    settings.autoClean
  )
}

export default { name, inject, apply }
