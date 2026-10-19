# dsh-workspace-tmp

**Workspace Tmp — scratch files that never land in the project tree** · DeepSeek Harness plugin

**简体中文** | [English](README_EN.md)

## Overview

The most quietly corrosive pollution during testing is not a wrong line of source. It is **the pile of one-off files left inside the project**: `test.tmp.ts`, `scratch.py`, a fixture used once, a captured log, half a generated dataset. They show up in `git status`, they show up in review, and then nobody dares delete them.

This plugin gives the agent a temporary directory **outside the workspace**, plus a standing rule and a tool that actually manages it:

| Surface | Registered through | Role |
|---|---|---|
| `workspace-tmp:policy` system-prompt section | `ctx.systemPrompt.section()` | Names the directory, states what belongs there and when it is deleted |
| `workspace_tmp` tool | `ctx.tools.register()` | Creates, writes, lists and cleans that directory |
| Automatic cleanup | `agent/turn-stopping` + `session/event` | Deleted at the end of every turn by default |

## Where the directory lives

The temporary directory is a **sibling** of the workspace, never a child:

```
C:\Users\me\Desktop\plugins-ws\            ← workspace (the project)
C:\Users\me\Desktop\tmp\plugins-ws-3f2a1c1\  ← temporary area
└── probe.test.ts
└── fixtures\…
└── .dsh-workspace-tmp.json                ← ownership marker
```

The rule is `<workspace parent>/<siblingDir>/<workspace name>-<session short id>/`. Therefore:

- **Never inside the project.** Not when the workspace is a Git repository, and not when it is not.
- **No `.gitignore` needed.** The path is not in the repository tree at all; the plugin never touches your project files.
- **Sessions do not collide.** The short session id gives each parallel session its own directory, and identically named workspaces under different parents stay separate.
- **Deletion is safe.** Only a directory carrying the `.dsh-workspace-tmp.json` marker is ever removed — even a workspace literally named `tmp` cannot be wiped by a mistaken path.

## When it is cleaned

By default the directory is **deleted at the end of every turn**, and the now-empty `tmp/` parent is pruned too.

| `autoClean` | Behaviour |
|---|---|
| `"turn"` (default) | Deleted each turn. `agent/turn-stopping` covers a normal ending; the `turn/end` session event covers error and abort endings |
| `"session"` | Deleted when the session is disposed (`agent/disposed`), so files survive across the steps of one turn |
| `"off"` | Nothing is deleted automatically; the model may call `action: "clean"`, or you decide when |

A cleanup failure is warned, never thrown into the turn. Deletion is idempotent: an absent directory is not an error.

## Install

The plugin lives in the profile's `node_modules`; the copy in your workspace is the maintenance source only.

### From GitHub

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-workspace-tmp
```

### From a local checkout

```bash
dsh plugin --profile desktop add "C:\path\to\dsh-workspace-tmp"
```

Or use **Settings → Plugins → Add** and pick the directory.

Restart Harness once the manager reports `restart-required`. The `workspace-tmp` row is inserted by [`cordis.patch.yml`](./cordis.patch.yml); you never edit the profile by hand.

### Maintaining the workspace source

The `dsh-workspace-tmp/` in your workspace is a **maintenance copy**, independent of the installed one: editing it does not affect the running plugin until you reinstall.

```bash
dsh plugin --profile desktop remove dsh-workspace-tmp
dsh plugin --profile desktop add "C:\path\to\dsh-workspace-tmp"
```

## Configuration

Every key is optional. An illegal value **fails at load** instead of silently degrading into a different layout.

```yaml
- id: workspace-tmp
  name: 'dsh-workspace-tmp'
  config:
    # Directory name beside the workspace, default tmp
    siblingDir: tmp
    # turn (default) | session | off
    autoClean: turn
```

| Key | Default | Meaning |
|---|---|---|
| `siblingDir` | `"tmp"` | Sibling directory name; a single path segment, so an empty value or one containing a separator is rejected |
| `autoClean` | `"turn"` | Cleanup timing; `true` (= turn) and `false` (= off) are accepted too |

## What the model sees

The system-prompt section (stable per session, so the KV-cache prefix is untouched):

```markdown
## Scratch files stay out of the project tree

This session's temporary directory is `C:\Users\me\Desktop\tmp\plugins-ws-3f2a1c1`. It is a sibling
of the workspace, not a child, so it is never part of the project and never shows up in version control.

Use it for anything that only exists to try something out: test files you write to check behaviour,
fixtures and sample inputs, generated data, captured logs, benchmark probes, throwaway scripts,
build or conversion by-products.

- Write those files under the temporary directory. Do not create `test.tmp.ts`, `scratch.py`,
  sample output, or one-off fixtures next to project sources.
- `workspace_tmp` manages it: `action: "create"` … `action: "write"` … `action: "list"` … `action: "clean"`.
- The native write tools are fenced to the workspace by the file sandbox, so they may refuse a
  path outside it. `workspace_tmp` with `action: "write"` is the supported way to create a scratch
  file there; the native `read`/`bash` tools can still read and run it.
- It is deleted automatically when this turn ends, so nothing is left behind.
- If a scratch file must outlive the turn, say so to the user and ask where it belongs; do not
  move it into the project to keep it.
- Real project changes still go through the normal read/write/edit tools on the real files.
  Never copy a project file into the temporary directory to "edit" it there.
```

Tool calls:

```jsonc
{ "action": "create", "name": "cases" }                              // make the dir, reserve a path
{ "action": "write", "name": "cases/a.test.ts", "content": "…" }     // write a file (parents created)
{ "action": "list" }                                                // relative paths + bytes, max 200
{ "action": "clean" }                                               // delete now
```

## Verification

The repository ships zero-dependency scripts; no test framework needed:

```bash
node --test "test/*.test.mjs"   # 14 unit tests: path derivation, config, tool behaviour, cleanup modes
node verify-wiring.mjs          # 21 integration checks: real cordis + dsh-system-prompt + dsh-tools
node verify-installed.mjs       # 16 checks against the installed copy, resolved through the profile
```

`npm test` / `npm run check` work too. Every script reads and writes only under the OS temp directory — **it never touches this repository**.

`verify-installed.mjs` follows the profile's real resolution path (`createRequire(profileDir/package.json)`), mounts the **installed** copy, and asserts that the section reaches the assembled prompt, that the tool executes through the real registry, and that the turn end actually removes the directory.

## Design notes

- **Sibling, not child.** A directory inside the workspace depends on `.gitignore` as a backstop, and editing `.gitignore` is itself editing the project. A sibling makes "leaves no trace" a structural property rather than a convention.
- **The ownership marker decides deletion.** Cleanup must read `.dsh-workspace-tmp.json` first, so a mistaken path computation cannot destroy an unrelated directory.
- **Deliberately outside the file sandbox.** The plugin writes with its own Node `fs`, so it works under `workspace-write`, where the native tools are fenced to the workspace; under `read-only` the tool refuses on purpose. This is a conscious trade: the temporary area is by definition outside the workspace.
- **Two cleanup entry points.** `agent/turn-stopping` is the serial hook for a normal ending; `turn/end` covers error, abort and crash paths. Keeping only the former would leak failed turns.
- **Deterministic prompt text.** The section depends only on the workspace and session id, so it is byte-identical across steps. A session without a workspace gets an empty section rather than a pointer to a path that does not exist.
- **Zero dependencies, no build step.** Only `node:fs/promises` and `node:path`; no `peerDependencies`, so a kernel version bump cannot refuse to load it.

## Known limitations

- **A rule plus a tool, not a policy engine.** The model can still write into the project; the plugin does not intercept `write`/`edit`. Hard interception would need `tools/pre-execute` plus path heuristics, with a high risk of blocking legitimate source edits — out of scope here.
- **The temporary area is outside the workspace.** That is the point, but it means a raw shell tool under `workspace-write` cannot see it. Use `workspace_tmp`'s `list`/`write`, or `danger-full-access`.
- **No project introspection.** It does not decide "which files are tests"; it provides a location and a cleanup.
- **No cross-session sharing.** One directory per session; anything that must outlive the session should be placed where you decide.

## License

[MIT](./LICENSE)
