import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { resolveConfig } from "./config.js";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(name, env) {
  const paths = (env.PATH || "").split(delimiter).filter(Boolean);
  for (const path of paths) {
    if (await exists(join(path, name))) return true;
  }
  return false;
}

export async function runDoctor(input = {}, env = {}) {
  const config = resolveConfig(env);
  const storageRoot = config.projectLocal
    ? join(input.cwd || env.PWD || process.cwd(), ".codex", "thread-memory")
    : join(env.PLUGIN_DATA || join(process.cwd(), ".thread-handoff-data"), "codex-thread-handoff");

  return {
    ok: true,
    config,
    storage: {
      root: storageRoot,
      projectLocal: config.projectLocal
    },
    hooks: {
      note: "Use /hooks in Codex to review and trust non-managed hook definitions."
    },
    ctx: {
      enabled: config.useCtx,
      available: await commandExists("ctx", env)
    },
    redaction: {
      enabled: config.redactSecrets
    }
  };
}
