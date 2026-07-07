import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { resolveConfig } from "./config.js";
import { resolveProjectPaths } from "./paths.js";

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
  const paths = resolveProjectPaths(input, config, env);
  const projectHookErrorPath = join(input.cwd || env.PWD || process.cwd(), ".thread-handoff", "hook-errors.jsonl");
  const hookErrorPaths = [
    join(paths.storageRoot, "hook-errors.jsonl"),
    projectHookErrorPath
  ];

  return {
    ok: true,
    config,
    storage: {
      root: paths.storageRoot,
      projectLocal: config.projectLocal
    },
    hooks: {
      note: "Use /hooks in Codex to review and trust non-managed hook definitions."
    },
    summarizer: {
      provider: config.summarizerProvider,
      model: config.summarizerModel,
      baseUrl: config.summarizerBaseUrl,
      apiKeyEnv: config.summarizerApiKeyEnv,
      apiKeyConfigured: Boolean(env[config.summarizerApiKeyEnv])
    },
    ctx: {
      enabled: config.useCtx,
      available: await commandExists("ctx", env)
    },
    redaction: {
      enabled: config.redactSecrets
    },
    diagnostics: {
      hookErrorPaths: [...new Set(hookErrorPaths)]
    }
  };
}
