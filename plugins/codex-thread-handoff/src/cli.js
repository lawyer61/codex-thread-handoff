import { resolveConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  recordCompactBoundary,
  recordToolObservation,
  recordUserPrompt
} from "./events.js";
import {
  isHandoffStale,
  reconcileHandoffFreshness,
  readLatestHandoff,
  snapshotHandoff,
  validateHandoff
} from "./handoff.js";
import {
  additionalContextOutput,
  jsonHookOutput,
  parseHookInput
} from "./hook-io.js";
import {
  injectionOutput,
  readInjectBrief,
  renderInjectBrief,
  shouldInjectForPrompt
} from "./inject.js";
import { writeTextAtomic } from "./json-store.js";
import { resolveProjectPaths } from "./paths.js";
import {
  advanceContextEpoch,
  loadOrCreateThreadState,
  readThreadState,
  saveThreadState
} from "./thread-state.js";
import {
  runExternalSummarizer,
  scheduleBackgroundSummarizer
} from "./summarizer.js";

const USAGE = "Usage: thread-handoff <session-start|user-prompt-submit|post-tool-use|stop|pre-compact|post-compact|summarize --trigger <stop|precompact>|doctor --json>\n";
const NEW_TASK_PROMPT = /(new task|start over|from scratch|do not inherit|新任务|重新开始|从头|不要沿用|不要继承)/i;

function resolveRuntime(stdin, env, source = "resume") {
  const input = parseHookInput(stdin);
  const config = resolveConfig(env);
  const paths = resolveProjectPaths(input, config, env);
  return { input, config, paths, source };
}

async function handleSessionStart(stdin, env) {
  const input = parseHookInput(stdin);
  const source = input.source || input.hook_source || "startup";
  const config = resolveConfig(env);
  if (config.mode === "off") return jsonHookOutput({});

  const paths = resolveProjectPaths(input, config, env);
  let state = await loadOrCreateThreadState(paths, input, config.keepThreadOnClear && source === "clear" ? "resume" : source);

  if (config.mode !== "observe" && (source === "compact" || source === "resume")) {
    let brief;
    try {
      brief = await readInjectBrief(paths);
    } catch {
      try {
        const reconciled = await reconcileHandoffFreshness(paths, state, config);
        if (!reconciled.validation.ok || !reconciled.fresh) {
          throw new Error("No fresh valid handoff brief exists");
        }
        state = reconciled.state;
        await saveThreadState(paths, state);
        brief = renderInjectBrief(reconciled.latest, config);
        await writeTextAtomic(paths.injectPath, brief);
      } catch {
        brief = "<THREAD_HANDOFF_MEMORY>\nNo fresh handoff brief exists. Rebuild latest.md before relying on history.\n</THREAD_HANDOFF_MEMORY>\n";
      }
    }
    return jsonHookOutput(additionalContextOutput("SessionStart", brief));
  }

  return jsonHookOutput({});
}

async function handleUserPromptSubmit(stdin, env) {
  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off") return jsonHookOutput({});

  const prompt = input.prompt || input.user_prompt || "";
  const source = !config.keepThreadOnClear && NEW_TASK_PROMPT.test(prompt) ? "clear" : "resume";
  const state = await loadOrCreateThreadState(paths, input, source);
  await recordUserPrompt(paths, state, input, config);

  if (config.mode !== "observe" && shouldInjectForPrompt(prompt)) {
    try {
      return jsonHookOutput(injectionOutput("UserPromptSubmit", await readInjectBrief(paths)));
    } catch {
      return jsonHookOutput({});
    }
  }

  return jsonHookOutput({});
}

async function handlePostToolUse(stdin, env) {
  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off") return jsonHookOutput({});

  const state = await loadOrCreateThreadState(paths, input, "resume");
  await recordToolObservation(paths, state, input, config);
  return jsonHookOutput({});
}

async function handleStop(stdin, env) {
  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off" || config.mode === "observe") {
    return jsonHookOutput({});
  }

  let state = await loadOrCreateThreadState(paths, input, "resume");

  try {
    const reconciled = await reconcileHandoffFreshness(paths, state, config);
    state = reconciled.state;
    await saveThreadState(paths, state);
    if (reconciled.fresh) {
      await writeTextAtomic(paths.injectPath, renderInjectBrief(reconciled.latest, config));
    }
  } catch {
    // Missing handoff is handled by the stale check below.
  }

  if (isHandoffStale(state, config)) {
    await scheduleBackgroundSummarizer(paths, state, input, config, env, "stop");
  }

  return jsonHookOutput({});
}

async function handlePreCompact(stdin, env) {
  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off" || config.mode === "observe") {
    return jsonHookOutput({ continue: true });
  }

  let state = await loadOrCreateThreadState(paths, input, "resume");
  await runExternalSummarizer(paths, state, input, config, env, "precompact", {
    timeoutMs: config.precompactSummarizerTimeoutMs
  });
  state = await readThreadState(paths);

  let latest;
  try {
    latest = await readLatestHandoff(paths);
  } catch {
    return jsonHookOutput({ continue: true });
  }

  const validation = validateHandoff(latest);
  if (validation.ok) {
    const reconciled = await reconcileHandoffFreshness(paths, state, config);
    state = reconciled.state;
    latest = reconciled.latest;
    await saveThreadState(paths, state);
  }

  if (validation.ok) {
    await snapshotHandoff(paths);
    await writeTextAtomic(paths.injectPath, renderInjectBrief(latest, config));
  }
  return jsonHookOutput({ continue: true });
}

async function handlePostCompact(stdin, env) {
  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off") return jsonHookOutput({});

  const state = await loadOrCreateThreadState(paths, input, "resume");
  const next = advanceContextEpoch(state);
  await saveThreadState(paths, next);
  await recordCompactBoundary(paths, next, input);

  try {
    const latest = await readLatestHandoff(paths);
    await writeTextAtomic(paths.injectPath, renderInjectBrief(latest, config));
  } catch {
    // PostCompact cannot inject through stdout; missing handoff is handled on the next start/prompt.
  }

  return jsonHookOutput({});
}

async function handleSummarize(argv, stdin, env) {
  const triggerIndex = argv.indexOf("--trigger");
  const trigger = triggerIndex >= 0 ? argv[triggerIndex + 1] : "stop";
  if (!new Set(["stop", "precompact"]).has(trigger)) {
    return jsonHookOutput({});
  }

  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off" || config.mode === "observe") {
    return jsonHookOutput({});
  }

  const state = await loadOrCreateThreadState(paths, input, "resume");
  let job;
  try {
    job = env.THREAD_HANDOFF_SUMMARIZER_JOB_JSON
      ? JSON.parse(env.THREAD_HANDOFF_SUMMARIZER_JOB_JSON)
      : undefined;
  } catch {
    job = undefined;
  }
  await runExternalSummarizer(paths, state, input, config, env, trigger, { job });
  return jsonHookOutput({});
}

export async function runCli(argv, stdin, env) {
  const [command, flag] = argv;

  try {
    if (command === "doctor" && flag === "--json") {
      return {
        code: 0,
        stdout: `${JSON.stringify(await runDoctor(parseHookInput(stdin), env), null, 2)}\n`,
        stderr: ""
      };
    }

    if (command === "session-start") {
      return { code: 0, stdout: await handleSessionStart(stdin, env), stderr: "" };
    }

    if (command === "user-prompt-submit") {
      return { code: 0, stdout: await handleUserPromptSubmit(stdin, env), stderr: "" };
    }

    if (command === "post-tool-use") {
      return { code: 0, stdout: await handlePostToolUse(stdin, env), stderr: "" };
    }

    if (command === "stop") {
      return { code: 0, stdout: await handleStop(stdin, env), stderr: "" };
    }

    if (command === "pre-compact") {
      return { code: 0, stdout: await handlePreCompact(stdin, env), stderr: "" };
    }

    if (command === "post-compact") {
      return { code: 0, stdout: await handlePostCompact(stdin, env), stderr: "" };
    }

    if (command === "summarize") {
      return { code: 0, stdout: await handleSummarize(argv, stdin, env), stderr: "" };
    }

    return { code: 2, stdout: "", stderr: USAGE };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${error.stack || error.message || String(error)}\n`
    };
  }
}
