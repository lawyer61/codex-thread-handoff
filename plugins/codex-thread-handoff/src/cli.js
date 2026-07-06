import { readFile } from "node:fs/promises";
import { resolveConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  readEvents,
  recordCompactBoundary,
  recordToolObservation,
  recordUserPrompt
} from "./events.js";
import {
  isHandoffStale,
  readLatestHandoff,
  renderInitialHandoff,
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
  saveThreadState
} from "./thread-state.js";

const USAGE = "Usage: thread-handoff <session-start|user-prompt-submit|post-tool-use|stop|pre-compact|post-compact|doctor --json>\n";
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
  await loadOrCreateThreadState(paths, input, config.keepThreadOnClear && source === "clear" ? "resume" : source);

  if (config.mode !== "observe" && (source === "compact" || source === "resume")) {
    let brief;
    try {
      brief = await readInjectBrief(paths);
    } catch {
      brief = "<THREAD_HANDOFF_MEMORY>\nNo fresh handoff brief exists. Rebuild latest.md before relying on history.\n</THREAD_HANDOFF_MEMORY>\n";
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
  if (env.THREAD_HANDOFF_STOP_HOOK_ACTIVE === "1") {
    return jsonHookOutput({});
  }

  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off" || config.mode === "observe") {
    return jsonHookOutput({});
  }

  const state = await loadOrCreateThreadState(paths, input, "resume");

  if (!config.stopHookContinuation || !isHandoffStale(state, config)) {
    return jsonHookOutput({});
  }

  return jsonHookOutput({
    decision: "block",
    reason: `Before continuing the original task, update the thread handoff file at: ${paths.latestPath}

Do not solve new task work. Write a compact but complete handoff for the next context epoch. Include mission, user constraints, current state, explored files, changed files, commands/results, decisions, validation status, open loops, risks, exact next actions, and ctx search handles for details.`
  });
}

async function handlePreCompact(stdin, env) {
  const { input, config, paths } = resolveRuntime(stdin, env, "resume");
  if (config.mode === "off" || config.mode === "observe") {
    return jsonHookOutput({ continue: true });
  }

  const state = await loadOrCreateThreadState(paths, input, "resume");

  let latest;
  try {
    latest = await readLatestHandoff(paths);
  } catch {
    if (config.mode === "strict") {
      return jsonHookOutput({
        continue: false,
        stopReason: "No fresh thread handoff exists. Update latest.md before compacting."
      });
    }

    const emergency = renderInitialHandoff(state, {
      project: paths.projectHash,
      repo_root: paths.repoRoot
    });
    await writeTextAtomic(paths.latestPath, emergency);
    await writeTextAtomic(paths.injectPath, renderInjectBrief(emergency, config));
    return jsonHookOutput({ continue: true });
  }

  const validation = validateHandoff(latest);
  if (!validation.ok && config.mode === "strict") {
    return jsonHookOutput({
      continue: false,
      stopReason: `Thread handoff is missing required sections: ${validation.missingSections.join(", ")}`
    });
  }

  if (config.mode === "strict" && isHandoffStale(state, config)) {
    return jsonHookOutput({
      continue: false,
      stopReason: "Thread handoff is stale. Update latest.md before compacting."
    });
  }

  await snapshotHandoff(paths);
  await writeTextAtomic(paths.injectPath, renderInjectBrief(latest, config));
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

    return { code: 2, stdout: "", stderr: USAGE };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${error.stack || error.message || String(error)}\n`
    };
  }
}
