# dsh-workspace-tmp

**工作区临时目录 — 让测试文件不再污染项目** · DeepSeek Harness 插件

[English](README_EN.md) | **简体中文**

## 概述

写测试时最容易被忽略的污染，不是改错了一行源码，而是**在项目里留下一堆一次性文件**：`test.tmp.ts`、`scratch.py`、跑一次就忘的 fixture、抓下来的日志、生成到一半的数据。它们进了 `git status`，进了 code review，最后又没人敢删。

这个插件给 Agent 一个**工作区之外**的临时目录，并配一条常驻准则和一套真正可用的工具：

| 注入面 | 实现位置 | 作用 |
|---|---|---|
| `workspace-tmp:policy` 系统提示段落 | `ctx.systemPrompt.section()` | 告诉模型临时目录在哪、什么该放进去、什么时候被删 |
| `workspace_tmp` 工具 | `ctx.tools.register()` | 创建、写入、列举、清理该目录 |
| 自动清理 | `agent/turn-stopping` + `session/event` | 默认每轮结束就删干净 |

## 目录在哪

临时目录是工作区的**并列兄弟**，不是子目录：

```
C:\Users\me\Desktop\插件\            ← 工作区（项目）
C:\Users\me\Desktop\tmp\插件-3f2a1c1\  ← 临时区
└── probe.test.ts
└── fixtures\…
└── .dsh-workspace-tmp.json           ← 归属标记
```

规则是 `<工作区父目录>/<siblingDir>/<工作区名>-<会话短id>/`。这样：

- **永远不在项目里**。工作区本身不是 Git 仓库时也不会；是仓库时更不会进 `git status`。
- **不需要 `.gitignore`**。它根本不在仓库目录树内，插件不碰你的任何项目文件。
- **多会话不打架**。会话短 id 让两个并行会话各用各的目录；同名工作区在不同父目录下也互不覆盖。
- **删得掉、也删得安全**。只有带`.dsh-workspace-tmp.json` 归属标记的目录才会被删；就算工作区本身叫 `tmp`，也不会误删。

## 什么时候清理

默认在**每轮结束时删除**，删完顺手把空掉的 `tmp/` 父目录也收掉。

| `autoClean` | 行为 |
|---|---|
| `"turn"`（默认） | 每轮结束即删。`agent/turn-stopping` 负责正常收尾，`session/event` 的 `turn/end` 兜底出错与中断的轮次 |
| `"session"` | 会话结束（`agent/disposed`）时删；同一轮的多个步骤之间还能复用同一个文件 |
| `"off"` | 不自动删；模型可用 `action: "clean"` 手动清，或由你决定何时处理 |

清理失败只 warn，不会把错误抛进轮次；删除是幂等的，目录本来就不存在时什么也不做。

## 安装

插件本体装在 profile 的 `node_modules` 里，工作区里的源码只用于维护。

### 从 GitHub 安装

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-workspace-tmp
```

### 从本地源码安装

```bash
dsh plugin --profile desktop add "C:\path\to\dsh-workspace-tmp"
```

或在 **设置 → 插件 → 添加** 中选择该目录。

安装完成后按提示重启 Harness（提示 `restart-required` 时必须重启）。`workspace-tmp` 行由 [`cordis.patch.yml`](./cordis.patch.yml) 自动插入，不需要手工改 profile。

### 维护工作区里的源码

工作区里的 `dsh-workspace-tmp/` 是**维护副本**，与已安装的副本相互独立：改源码不会影响正在运行的插件，必须重新安装才生效。

```bash
dsh plugin --profile desktop remove dsh-workspace-tmp
dsh plugin --profile desktop add "C:\path\to\dsh-workspace-tmp"
```

## 配置

每个键都可省略。非法值会在加载时**直接报错**，而不是悄悄降级成另一种行为。

```yaml
- id: workspace-tmp
  name: 'dsh-workspace-tmp'
  config:
    # 与工作区并列的目录名，默认 tmp
    siblingDir: tmp
    # turn（默认）| session | off
    autoClean: turn
```

| 键 | 默认 | 含义 |
|---|---|---|
| `siblingDir` | `"tmp"` | 并列目录名；只接受单个目录名，含分隔符或为空会报错 |
| `autoClean` | `"turn"` | 清理时机；也接受 `true`（=turn）、`false`（=off） |

## 模型实际看到什么

系统提示段落（每轮稳定，不破坏 KV 缓存）：

```markdown
## Scratch files stay out of the project tree

This session's temporary directory is `C:\Users\me\Desktop\tmp\插件-3f2a1c1`. It is a sibling of
the workspace, not a child, so it is never part of the project and never shows up in version control.

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

工具调用：

```jsonc
{ "action": "create", "name": "cases" }                              // 建目录并预留路径
{ "action": "write", "name": "cases/a.test.ts", "content": "…" }     // 写文件（自动建父目录）
{ "action": "list" }                                                // 相对路径 + 字节数，最多 200 条
{ "action": "clean" }                                               // 立刻删除
```

## 验证

仓库自带零依赖脚本，不需要测试框架：

```bash
node --test "test/*.test.mjs"   # 14 项单元测试：路径推导、配置校验、工具行为、三种清理时机
node verify-wiring.mjs          # 21 项集成检查：真实 cordis + dsh-system-prompt + dsh-tools
node verify-installed.mjs       # 16 项安装副本检查：通过 desktop profile 解析已安装的包
```

`npm test` / `npm run check` 亦可。全部脚本只在系统临时目录里读写，**不会碰本仓库**。

`verify-installed.mjs` 走 profile 的真实解析路径（`createRequire(profileDir/package.json)`），挂载**已安装的那份**，断言段落进入组装后的提示词、工具经真实注册表执行成功、轮次结束确实删除了目录。

## 设计说明

- **并列而非子目录。** 放在工作区里必须靠 `.gitignore` 兜底，而改 `.gitignore` 本身就是改项目文件；并列目录让"不留痕迹"成为结构保证，而不是约定。
- **归属标记决定删除权。** 删除前必须读到 `.dsh-workspace-tmp.json`。这让清理逻辑在路径计算出错时也不会破坏无关目录。
- **不绕过沙箱之外的东西。** 插件用自己的 Node `fs` 写入，因此不受文件沙箱 fence 限制（`workspace-write` 下也能用）；`read-only` 模式下工具会主动拒绝。代价是它确实越过了 DSH 文件沙箱这一层——这是刻意的选择，因为临时区按定义就在工作区外。
- **两个清理入口。** `agent/turn-stopping` 是正常收尾的串行钩子，`turn/end` 兜底出错、中断、崩溃的轮次。只留前者会漏掉失败的轮次。
- **提示词按会话确定。** 段落文字只依赖工作区与会话 id，跨步骤逐字节一致；没有工作区的会话拿到空段落，而不是一段指向不存在路径的说明。
- **零依赖、无构建。** 只用 `node:fs/promises` 与 `node:path`；`package.json` 不声明 `peerDependencies`，避免被内核版本锁死。

## 已知限制

- **它是准则加工具，不是策略引擎。** 模型仍可能把文件写在项目里；插件不拦截 `write`/`edit`。硬拦截需要 `tools/pre-execute` 加路径判定，误伤正常源码的风险很高，不在本插件范围内。
- **临时区在工作区外。** 这正是目的，但也意味着 `workspace-write` 沙箱下的原生命令行工具看不到它；用 `workspace_tmp` 的 `list`/`write`，或用 `danger-full-access`。
- **不读项目结构。** 不判断"哪些是测试文件"，只提供位置和清理。
- **不做跨会话共享。** 每个会话一个目录；需要长期保留的产物应由你指定位置。

## 许可证

[MIT](./LICENSE)
