# Codex Thread Handoff

[English](README_en.md)

Codex Thread Handoff 是一个 Codex 插件，用来在长任务、上下文压缩和恢复之间维护一份可读、可审计、可注入的任务交接文档。

它解决的问题很直接：当 Codex 工作了很久以后，模型上下文可能被 compact。新的上下文阶段容易忘记用户早期约束、已经探索过的文件、失败过的方案、当前修改状态、测试结果和下一步计划。这个插件把这些工作状态整理成 `latest.md` 和 `latest.inject.md`，让下一段 Codex 继续工作时不必从头摸索。

## 核心原理

插件通过 Codex lifecycle hooks 工作：

- `SessionStart`：默认只在 compact 后注入已有的 handoff brief；可配置为 resume 后也注入。
- `UserPromptSubmit`：记录用户新要求；可配置为在“继续/接着刚才”等场景按需注入上下文，默认不注入。
- `PostToolUse`：记录工具调用和结果摘要。
- `Stop`：不阻塞当前 Codex 流程；默认不触发 summarizer，可配置为在 handoff 过期时后台触发 summarizer。
- `PreCompact`：compact 前最多等待 summarizer 一个有界时间，默认 8 秒；无论成功、失败或超时都允许 compact 继续。
- `PostCompact`：记录新的 context epoch，并重建注入 brief。

插件维护两类数据：

- `events.jsonl`：事件账本，记录用户提示、工具观察、compact 边界、summary job 状态等证据。
- `latest.md` / `latest.inject.md`：由 summarizer 生成的人类可读 canonical handoff 和用于注入的 bounded brief。

`latest.md` 不是权威事实。当前用户指令、当前文件、测试结果、AGENTS.md 和更高优先级指令永远覆盖 handoff。

## Summarizer

Handoff 由外部 summarizer 维护，而不是通过 Stop hook 阻塞当前 Codex 线程。默认只有 PreCompact 会主动调用 summarizer；如果希望每轮 turn 结束后也后台维护 handoff，可以显式开启 Stop summarizer。

支持两种 provider：

1. `openai-compatible`
   - 直接调用 OpenAI-compatible Chat Completions API。
   - 默认模型：`gpt-5.4`
   - 默认 API key 环境变量：`OPENAI_API_KEY`

2. `codex-cli`
   - 调用 `codex exec` 作为 summarizer。
   - 适合复用 Codex 已配置的 provider 和认证，例如本机 `new-api`。
   - 插件不直接读取 `auth.json`，认证由 Codex 自己处理。
   - 可配置 summarizer 推理强度，例如 `low`、`medium`、`high`，以及将来可能出现的 `ultra`。
   - 子进程会使用 `--skip-git-repo-check` 和 `--dangerously-bypass-hook-trust`，并设置 `THREAD_HANDOFF_MODE=off`，避免在 hook / plugin 目录或非 Git 目录中失败，也避免递归触发本插件 hooks。

Summarizer 输出必须是 JSON：

```json
{
  "latest_md": "完整 canonical handoff markdown",
  "confidence": "low|medium|high",
  "source_event_seq": 123,
  "warnings": []
}
```

插件会校验 JSON、校验 `latest_md` 必需章节、再次脱敏，然后原子写入 `latest.md`，并从它生成 `latest.inject.md`。

并发写入使用 summary job id、trigger 优先级和 event high-water mark 控制。启用 Stop summarizer 时，`precompact` 的优先级高于 `stop`，所以不会出现“最后完成的旧 job 覆盖新 handoff”的问题。

## 安装

从 GitHub marketplace 安装：

```bash
codex plugin marketplace add lawyer61/codex-thread-handoff --ref v0.3.7
codex plugin add codex-thread-handoff@thread-handoff
```

安装后重启 Codex，在 TUI 中打开 `/hooks`，review 并 trust 插件 hooks。

如果已经安装过旧版：

```bash
codex plugin marketplace remove thread-handoff
codex plugin marketplace add lawyer61/codex-thread-handoff --ref v0.3.7
codex plugin add codex-thread-handoff@thread-handoff
```

## 配置

默认配置适合 OpenAI-compatible API：

```bash
export THREAD_HANDOFF_SUMMARIZER_PROVIDER=openai-compatible
export THREAD_HANDOFF_SUMMARIZER_MODEL=gpt-5.4
export THREAD_HANDOFF_SUMMARIZER_BASE_URL=https://api.openai.com/v1
export THREAD_HANDOFF_SUMMARIZER_API_KEY_ENV=OPENAI_API_KEY
export OPENAI_API_KEY=...
```

如果要使用本机 Codex 配置的 provider/auth，例如 `new-api`，推荐：

```bash
export THREAD_HANDOFF_SUMMARIZER_PROVIDER=codex-cli
export THREAD_HANDOFF_SUMMARIZER_MODEL=gpt-5.4
export THREAD_HANDOFF_SUMMARIZER_CODEX_MODEL_PROVIDER=new-api
```

配置 summarizer 推理强度：

```bash
export THREAD_HANDOFF_SUMMARIZER_REASONING_EFFORT=low
```

`codex-cli` provider 默认使用上面的通用配置，也可以单独覆盖：

```bash
export THREAD_HANDOFF_SUMMARIZER_CODEX_REASONING_EFFORT=ultra
```

插件不会限制推理强度枚举值，这样未来出现 `ultra` 等新值时可以直接透传给 Codex CLI。

自定义 summarizer 请求头：

```bash
export THREAD_HANDOFF_SUMMARIZER_EXTRA_HEADERS_JSON='{"HTTP-Referer":"https://example.com","X-Title":"Codex Thread Handoff"}'

export THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON='{"X-Tenant":"MY_TENANT_HEADER"}'
export MY_TENANT_HEADER='tenant-secret'
```

`openai-compatible` provider 会把这些 header 直接加到 API 请求上。`codex-cli` provider 会通过 Codex provider 的 `env_http_headers` 转发 header，因此需要 `THREAD_HANDOFF_SUMMARIZER_CODEX_MODEL_PROVIDER` 指向自定义 provider，例如 `new-api`。

常用配置：

```bash
export THREAD_HANDOFF_MODE=strict
export THREAD_HANDOFF_INJECT_BUDGET_TOKENS=6000
export THREAD_HANDOFF_INJECT_ON_RESUME=false
export THREAD_HANDOFF_INJECT_ON_USER_PROMPT=false
export THREAD_HANDOFF_STOP_SUMMARIZER_ENABLED=false
export THREAD_HANDOFF_STALE_AFTER_MINUTES=30
export THREAD_HANDOFF_SUMMARIZER_TIMEOUT_MS=8000
export THREAD_HANDOFF_PRECOMPACT_SUMMARIZER_TIMEOUT_MS=8000
export THREAD_HANDOFF_SUMMARIZER_CONTEXT_TOKENS=200000
export THREAD_HANDOFF_SUMMARIZER_MAX_OUTPUT_TOKENS=12000
export THREAD_HANDOFF_SUMMARIZER_REASONING_EFFORT=low
export THREAD_HANDOFF_TRANSCRIPT_TAIL_BYTES=200000
export THREAD_HANDOFF_SUMMARIZER_RECENT_EVENTS=200
```

默认存储位置是 Codex 插件数据目录下的私有目录。若希望存到项目内：

```bash
export THREAD_HANDOFF_PROJECT_LOCAL=true
```

项目本地模式会写入 `.codex/thread-memory/`，插件会自动把该目录加入 `.gitignore`。

如果项目根目录已经存在 `.codex` 文件而不是目录，插件会自动改用 `.thread-handoff/`，并把 `.thread-handoff/` 加入 `.gitignore`。

## 使用方式

正常使用 Codex 即可。插件会在 hooks 中自动运行。

常见工作流：

1. 开始一个长任务。
2. Codex 在每轮用户提示和工具调用后记录事件。
3. turn 结束时，Stop hook 默认只做轻量检查，不调用 summarizer。
4. compact 前，PreCompact 在 8 秒默认预算内调用 summarizer，更新 `latest.md` 和 `latest.inject.md`。
5. compact 后，SessionStart 注入 bounded handoff。
6. `UserPromptSubmit` 继续记录用户提示；默认不注入 handoff。

默认情况下，`SessionStart(source=resume)` 不注入 handoff，避免每次恢复旧 Codex session 都自动带入历史状态。如果你希望 resume 后也自动注入：

```bash
export THREAD_HANDOFF_INJECT_ON_RESUME=true
```

默认情况下，`UserPromptSubmit` 也不注入 handoff，避免普通的“继续”提示把历史状态重新塞入当前上下文。如果你希望用户说“继续”“接着刚才”等提示时也按需注入：

```bash
export THREAD_HANDOFF_INJECT_ON_USER_PROMPT=true
```

默认情况下，Stop hook 不会调用 summarizer，避免每轮 turn 都消耗额外 token。如果你希望 handoff 过期时在 turn 结束后也后台刷新：

```bash
export THREAD_HANDOFF_STOP_SUMMARIZER_ENABLED=true
```

运行诊断：

```bash
node plugins/codex-thread-handoff/bin/thread-handoff.js doctor --json </dev/null
```

`doctor --json` 会报告当前 storage root、summarizer 配置和 hook 诊断日志路径。自定义 header 只显示 header name，不显示 value。hook 内部错误会被写入 `hook-errors.jsonl`；生命周期 hook 会尽量 fail-safe 返回，避免 Codex 只能显示一个不可审计的 `hook exit with status code 1`。

本地开发测试：

```bash
cd plugins/codex-thread-handoff
npm test
python3 /root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py /workspace/plugins/codex-thread-handoff
```

## 模式

- `off`：不记录、不注入。
- `observe`：只记录事件，不影响 Codex 流程。
- `permissive`：记录、注入并尝试维护 handoff；失败不阻塞。
- `strict`：执行更严格的校验和诊断，但 Stop 和 PreCompact 仍不阻塞原始 Codex 流程；Stop summarizer 仍默认关闭。

## 安全边界

- Stop 永远不使用 `decision:"block"`。
- Stop summarizer 默认关闭；开启后也是 fire-and-forget，不等待结果。
- PreCompact 永远返回 `continue:true`。
- 默认对 secret-shaped 内容脱敏。
- `codex-cli` provider 不读取 `auth.json`，只调用 Codex。
- `codex-cli` provider 调用 `codex exec --skip-git-repo-check`，用于绕过 summarizer 子进程在非 Git / 未信任工作目录中的启动检查。
- 自定义 summarizer header 的值不会出现在 `doctor --json` 中；`codex-cli` provider 会通过环境变量传递 header 值，避免写进命令行参数。
- Summarizer 输入是有界的：`state.json`、已有 `latest.md`、近期事件、git status/stat/diff、transcript tail；不会默认扫描整个仓库。
- Handoff 是 working memory，不是 source of truth。

## 故障排查

### `Not inside a trusted directory and --skip-git-repo-check was not specified`

这是旧版 `codex-cli` summarizer 在 hook 后台调用 `codex exec` 时可能出现的错误。`v0.3.2` 起已经在 summarizer 子进程中加入 `--skip-git-repo-check`。

处理方式：

```bash
codex plugin marketplace remove thread-handoff
codex plugin marketplace add lawyer61/codex-thread-handoff --ref v0.3.7
codex plugin add codex-thread-handoff@thread-handoff
```

更新后重启 Codex，并在 `/hooks` 中确认当前插件 hooks 已被 trust。旧版 Stop hook 已经启动的后台 summarizer 可能还会短暂写出旧错误，新的 hook 触发会使用新版逻辑。

### `.codex` 是文件导致 hook 失败

`v0.3.1` 起，项目本地模式发现 `.codex` 不是目录时会自动使用 `.thread-handoff/`，不再尝试把 `.codex` 当目录写入。

### 长时间运行后出现大量 `PostToolUse hook exited with code 1`

旧版在多个客户端或密集工具调用同时写 `state.json` / `events.jsonl` 时，文件锁会直接报 `EEXIST`，并且 `state.json` 会因为重复记录同一个 Codex session 而逐渐膨胀，进一步放大锁竞争。`v0.3.4` 起，锁会等待短时间后重试，临时文件名也改为全局唯一，并且同一个 Codex session 不会反复写入 `codex_sessions`。

处理方式：

```bash
codex plugin marketplace remove thread-handoff
codex plugin marketplace add lawyer61/codex-thread-handoff --ref v0.3.7
codex plugin add codex-thread-handoff@thread-handoff
```

### 只看到 `hook exit with status code 1`

`v0.3.1` 起，hook 失败会尽量写入 `hook-errors.jsonl` 并返回安全 JSON。可以运行 `doctor --json` 查看诊断日志候选路径。

## 当前限制

- 暂不实现向量数据库、云同步、跨项目长期记忆或自动 `/compact`。
- `ctx` 只作为 retrieval handle 方向，不自动查询。
- `codex-cli` provider 依赖本机 `codex exec` 可用。
- `codex-cli` provider 的自定义 header 需要使用自定义 Codex model provider，不能直接覆盖内置 `openai`、`ollama` 或 `lmstudio` provider。
- 后台 Stop summarizer 默认关闭；开启后是 fire-and-forget，失败会写事件，但不影响当前 Codex turn。
