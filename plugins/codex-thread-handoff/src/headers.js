const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseJsonObject(raw, label) {
  if (!raw || !String(raw).trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be a JSON object: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed;
}

function assertHeaderName(name, label) {
  if (!HEADER_NAME.test(name)) {
    throw new Error(`${label} contains invalid header name: ${name}`);
  }
}

function assertHeaderValue(value, label, name) {
  if (value === null || value === undefined) {
    throw new Error(`${label}.${name} must not be null`);
  }
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error(`${label}.${name} must not contain CR/LF`);
  }
  return text;
}

function parseStaticHeaders(env = {}) {
  const parsed = parseJsonObject(
    env.THREAD_HANDOFF_SUMMARIZER_EXTRA_HEADERS_JSON,
    "THREAD_HANDOFF_SUMMARIZER_EXTRA_HEADERS_JSON"
  );
  const headers = {};
  for (const [name, value] of Object.entries(parsed)) {
    assertHeaderName(name, "THREAD_HANDOFF_SUMMARIZER_EXTRA_HEADERS_JSON");
    headers[name] = assertHeaderValue(value, "THREAD_HANDOFF_SUMMARIZER_EXTRA_HEADERS_JSON", name);
  }
  return headers;
}

function parseEnvHeaderRefs(env = {}) {
  const parsed = parseJsonObject(
    env.THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON,
    "THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON"
  );
  const refs = {};
  for (const [name, envName] of Object.entries(parsed)) {
    assertHeaderName(name, "THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON");
    const value = assertHeaderValue(envName, "THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON", name);
    if (!ENV_NAME.test(value)) {
      throw new Error(`THREAD_HANDOFF_SUMMARIZER_EXTRA_ENV_HEADERS_JSON.${name} must be an environment variable name`);
    }
    refs[name] = value;
  }
  return refs;
}

export function resolveSummarizerExtraHeaders(env = {}) {
  const headers = parseStaticHeaders(env);
  const refs = parseEnvHeaderRefs(env);

  for (const [name, envName] of Object.entries(refs)) {
    if (!Object.prototype.hasOwnProperty.call(env, envName)) {
      throw new Error(`Missing environment variable for summarizer header ${name}: ${envName}`);
    }
    headers[name] = assertHeaderValue(env[envName], envName, name);
  }

  return headers;
}

export function summarizeSummarizerExtraHeaders(env = {}) {
  try {
    return {
      names: Object.keys(resolveSummarizerExtraHeaders(env)).sort(),
      error: null
    };
  } catch (error) {
    return {
      names: [],
      error: error.message
    };
  }
}
