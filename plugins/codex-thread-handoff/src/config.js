import { summarizeSummarizerExtraHeaders } from "./headers.js";

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
  const summarizerTimeoutMs = numberFromEnv(env.THREAD_HANDOFF_SUMMARIZER_TIMEOUT_MS, 8000);
  const summarizerReasoningEffort = env.THREAD_HANDOFF_SUMMARIZER_REASONING_EFFORT || "low";
  const extraHeaders = summarizeSummarizerExtraHeaders(env);

  return {
    mode,
    injectBudgetTokens: numberFromEnv(env.THREAD_HANDOFF_INJECT_BUDGET_TOKENS, 6000),
    handoffStaleAfterTurns: numberFromEnv(env.THREAD_HANDOFF_STALE_AFTER_TURNS, 6),
    handoffStaleAfterMinutes: numberFromEnv(env.THREAD_HANDOFF_STALE_AFTER_MINUTES, 30),
    projectLocal: booleanFromEnv(env.THREAD_HANDOFF_PROJECT_LOCAL, false),
    useCtx: booleanFromEnv(env.THREAD_HANDOFF_USE_CTX, true),
    redactSecrets: booleanFromEnv(env.THREAD_HANDOFF_REDACT_SECRETS, true),
    injectOnResume: booleanFromEnv(env.THREAD_HANDOFF_INJECT_ON_RESUME, false),
    injectOnUserPrompt: booleanFromEnv(env.THREAD_HANDOFF_INJECT_ON_USER_PROMPT, false),
    injectOnSubagentStart: booleanFromEnv(env.THREAD_HANDOFF_INJECT_ON_SUBAGENT_START, true),
    stopSummarizerEnabled: booleanFromEnv(env.THREAD_HANDOFF_STOP_SUMMARIZER_ENABLED, false),
    keepThreadOnClear: booleanFromEnv(env.THREAD_HANDOFF_KEEP_THREAD_ON_CLEAR, false),
    stopHookContinuation: false,
    summarizerProvider: env.THREAD_HANDOFF_SUMMARIZER_PROVIDER || "openai-compatible",
    summarizerModel: env.THREAD_HANDOFF_SUMMARIZER_MODEL || "gpt-5.4",
    summarizerBaseUrl: env.THREAD_HANDOFF_SUMMARIZER_BASE_URL || "https://api.openai.com/v1",
    summarizerApiKeyEnv: env.THREAD_HANDOFF_SUMMARIZER_API_KEY_ENV || "OPENAI_API_KEY",
    summarizerContextTokens: numberFromEnv(env.THREAD_HANDOFF_SUMMARIZER_CONTEXT_TOKENS, 200000),
    summarizerMaxOutputTokens: numberFromEnv(env.THREAD_HANDOFF_SUMMARIZER_MAX_OUTPUT_TOKENS, 12000),
    summarizerReasoningEffort,
    summarizerExtraHeaderNames: extraHeaders.names,
    summarizerExtraHeadersError: extraHeaders.error,
    summarizerTimeoutMs,
    precompactSummarizerTimeoutMs: numberFromEnv(
      env.THREAD_HANDOFF_PRECOMPACT_SUMMARIZER_TIMEOUT_MS,
      summarizerTimeoutMs
    ),
    summarizerCodexBin: env.THREAD_HANDOFF_SUMMARIZER_CODEX_BIN || "codex",
    summarizerCodexModelProvider: env.THREAD_HANDOFF_SUMMARIZER_CODEX_MODEL_PROVIDER || "",
    summarizerCodexReasoningEffort: env.THREAD_HANDOFF_SUMMARIZER_CODEX_REASONING_EFFORT || summarizerReasoningEffort,
    transcriptTailBytes: numberFromEnv(env.THREAD_HANDOFF_TRANSCRIPT_TAIL_BYTES, 200000),
    summarizerRecentEvents: numberFromEnv(env.THREAD_HANDOFF_SUMMARIZER_RECENT_EVENTS, 200),
    summarizerBackgroundSpawn: booleanFromEnv(env.THREAD_HANDOFF_SUMMARIZER_BACKGROUND_SPAWN, true)
  };
}
