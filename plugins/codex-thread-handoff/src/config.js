const VALID_MODES = new Set(["off", "observe", "permissive", "strict"]);

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

export function resolveConfig(env = {}) {
  const mode = VALID_MODES.has(env.THREAD_HANDOFF_MODE)
    ? env.THREAD_HANDOFF_MODE
    : "strict";

  return {
    mode,
    injectBudgetTokens: numberFromEnv(env.THREAD_HANDOFF_INJECT_BUDGET_TOKENS, 6000),
    handoffStaleAfterTurns: numberFromEnv(env.THREAD_HANDOFF_STALE_AFTER_TURNS, 6),
    handoffStaleAfterMinutes: numberFromEnv(env.THREAD_HANDOFF_STALE_AFTER_MINUTES, 30),
    projectLocal: booleanFromEnv(env.THREAD_HANDOFF_PROJECT_LOCAL, false),
    useCtx: booleanFromEnv(env.THREAD_HANDOFF_USE_CTX, true),
    redactSecrets: booleanFromEnv(env.THREAD_HANDOFF_REDACT_SECRETS, true),
    keepThreadOnClear: booleanFromEnv(env.THREAD_HANDOFF_KEEP_THREAD_ON_CLEAR, false),
    stopHookContinuation: booleanFromEnv(env.THREAD_HANDOFF_STOP_HOOK_CONTINUATION, true),
    externalSummarizer: env.THREAD_HANDOFF_EXTERNAL_SUMMARIZER || "off"
  };
}
