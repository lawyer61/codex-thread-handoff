# Codex Thread Handoff

Codex Thread Handoff 是一个 Codex 插件，用来在长任务、上下文压缩和恢复之间维护一份可读、可审计、可注入的任务交接文档。

它解决的问题很直接：当 Codex 工作了很久以后，模型上下文可能被 compact。新的上下文阶段容易忘记用户早期约束、已经探索过的文件、失败过的方案、当前修改状态、测试结果和下一步计划。这个插件把这些工作状态整理成 `latest.md` 和 `latest.inject.md`，让下一段 Codex 继续工作时不必从头摸索。

## 核心原理

插件通过 Codex lifecycle hooks 工作：

- `SessionStart`：在 compact/resume 后注入已有的 handoff brief。
- `UserPromptSubmit`：记录用户新要求，并在“继续/接着刚才”等场景按需注入上下文。
- `PostToolUse`：记录工具调用和结果摘要。
- `Stop`：不阻塞当前 Codex 流程，只在后台触发 summarizer 维护 handoff。
- `PreCompact`：compact 前最多等待 summarizer 一个有界时间，默认 8 秒；无论成功、失败或超时都允许 compact 继续。
- `PostCompact`：记录新的 context epoch，并重建注入 brief。

插件维护两类数据：

- `events.jsonl`：事件账本，记录用户提示、工具观察、compact 边界、summary job 状态等证据。
- `latest.md` / `latest.inject.md`：由 summarizer 生成的人类可读 canonical handoff 和用于注入的 bounded brief。

`latest.md` 不是权威事实。当前用户指令、当前文件、测试结果、AGENTS.md 和更高优先级指令永远覆盖 handoff。

## Summarizer

Handoff 由外部 summarizer 维护，而不是通过 Stop hook 阻塞当前 Codex 线程。

支持两种 provider：

1. `openai-compatible`
   - 直接调用 OpenAI-compatible Chat Completions API。
   - 默认模型：`gpt-5.4`
   - 默认 API key 环境变量：`OPENAI_API_KEY`

2. `codex-cli`
   - 调用 `codex exec` 作为 summarizer。
   - 适合复用 Codex 已配置的 provider 和认证，例如本机 `new-api`。
   - 插件不直接读取 `auth.json`，认证由 Codex 自己处理。

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

并发写入使用 summary job id、trigger 优先级和 event high-water mark 控制。`precompact` 的优先级高于 `stop`，所以不会出现“最后完成的旧 job 覆盖新 handoff”的问题。

## 安装

从 GitHub marketplace 安装：

```bash
codex plugin marketplace add lawyer61/codex-thread-handoff --ref v0.3.0
codex plugin add codex-thread-handoff@thread-handoff
```

安装后重启 Codex，在 TUI 中打开 `/hooks`，review 并 trust 插件 hooks。

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

常用配置：

```bash
export THREAD_HANDOFF_MODE=strict
export THREAD_HANDOFF_INJECT_BUDGET_TOKENS=6000
export THREAD_HANDOFF_STALE_AFTER_MINUTES=30
export THREAD_HANDOFF_SUMMARIZER_TIMEOUT_MS=8000
export THREAD_HANDOFF_PRECOMPACT_SUMMARIZER_TIMEOUT_MS=8000
export THREAD_HANDOFF_SUMMARIZER_CONTEXT_TOKENS=200000
export THREAD_HANDOFF_SUMMARIZER_MAX_OUTPUT_TOKENS=12000
export THREAD_HANDOFF_TRANSCRIPT_TAIL_BYTES=200000
export THREAD_HANDOFF_SUMMARIZER_RECENT_EVENTS=200
```

默认存储位置是 Codex 插件数据目录下的私有目录。若希望存到项目内：

```bash
export THREAD_HANDOFF_PROJECT_LOCAL=true
```

项目本地模式会写入 `.codex/thread-memory/`，插件会自动把该目录加入 `.gitignore`。

## 使用方式

正常使用 Codex 即可。插件会在 hooks 中自动运行。

常见工作流：

1. 开始一个长任务。
2. Codex 在每轮用户提示和工具调用后记录事件。
3. turn 结束时，Stop hook 后台触发 summarizer。
4. summarizer 更新 `latest.md` 和 `latest.inject.md`。
5. compact/resume 后，SessionStart 注入 bounded handoff。
6. 如果用户说“继续”“接着刚才”，UserPromptSubmit 也会按需注入 handoff。

运行诊断：

```bash
node plugins/codex-thread-handoff/bin/thread-handoff.js doctor --json </dev/null
```

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
- `strict`：执行更严格的校验和诊断，但 Stop 和 PreCompact 仍不阻塞原始 Codex 流程。

## 安全边界

- Stop 永远不使用 `decision:"block"`。
- PreCompact 永远返回 `continue:true`。
- 默认对 secret-shaped 内容脱敏。
- `codex-cli` provider 不读取 `auth.json`，只调用 Codex。
- Summarizer 输入是有界的：`state.json`、已有 `latest.md`、近期事件、git status/stat/diff、transcript tail；不会默认扫描整个仓库。
- Handoff 是 working memory，不是 source of truth。

## 当前限制

- 暂不实现向量数据库、云同步、跨项目长期记忆或自动 `/compact`。
- `ctx` 只作为 retrieval handle 方向，不自动查询。
- `codex-cli` provider 依赖本机 `codex exec` 可用。
- 后台 Stop summarizer 是 fire-and-forget；失败会写事件，但不影响当前 Codex turn。

