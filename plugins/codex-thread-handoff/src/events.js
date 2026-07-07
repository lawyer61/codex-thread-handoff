import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "./json-store.js";
import { redactSecrets } from "./redaction.js";

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;
}

function summarize(value, max = 1000) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)} [truncated]` : text;
}

async function nextSeq(eventsPath) {
  try {
    const lines = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length === 0) return 1;
    const last = JSON.parse(lines.at(-1));
    return Number(last.seq || 0) + 1;
  } catch {
    return 1;
  }
}

async function appendEvent(paths, event) {
  const eventsPath = paths.eventsPath || join(paths.threadDir, "events.jsonl");
  const withSeq = {
    seq: await nextSeq(eventsPath),
    ...event
  };
  await appendJsonl(eventsPath, withSeq);
  return withSeq;
}

function redactedSummary(value, config) {
  const summary = summarize(value);
  return config.redactSecrets
    ? redactSecrets(summary)
    : { text: summary, redacted: false, rules: [] };
}

export async function recordUserPrompt(paths, state, input, config) {
  const prompt = input.prompt || input.user_prompt || "";
  const redacted = redactedSummary(prompt, config);

  return appendEvent(paths, {
    type: "user_prompt",
    timestamp: new Date().toISOString(),
    logical_thread_id: state.logical_thread_id,
    context_epoch: state.context_epoch,
    prompt_summary: redacted.text,
    privacy: {
      redacted: redacted.redacted,
      redaction_rules: redacted.rules
    }
  });
}

export async function recordToolObservation(paths, state, input, config) {
  const response = input.tool_response || input.response || "";
  const redacted = redactedSummary(response, config);

  return appendEvent(paths, {
    type: "tool_observation",
    timestamp: new Date().toISOString(),
    logical_thread_id: state.logical_thread_id,
    context_epoch: state.context_epoch,
    tool: input.tool_name || input.tool || "unknown",
    tool_input_digest: digest(input.tool_input),
    tool_input_summary: summarize(input.tool_input),
    tool_response_digest: digest(response),
    tool_response_summary: redacted.text,
    files_touched: input.files_touched || [],
    privacy: {
      redacted: redacted.redacted,
      redaction_rules: redacted.rules
    }
  });
}

export async function recordCompactBoundary(paths, state, input) {
  return appendEvent(paths, {
    type: "compact_boundary",
    timestamp: new Date().toISOString(),
    logical_thread_id: state.logical_thread_id,
    context_epoch: state.context_epoch,
    trigger: input.trigger || input.compaction_trigger || "unknown"
  });
}

export async function recordSummaryEvent(paths, state, event) {
  return appendEvent(paths, {
    timestamp: new Date().toISOString(),
    logical_thread_id: state.logical_thread_id,
    context_epoch: state.context_epoch,
    ...event
  });
}

export async function readEvents(paths) {
  const eventsPath = paths.eventsPath || join(paths.threadDir, "events.jsonl");
  try {
    return (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function getLatestEventSeq(paths) {
  const events = await readEvents(paths);
  return events.reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0);
}
