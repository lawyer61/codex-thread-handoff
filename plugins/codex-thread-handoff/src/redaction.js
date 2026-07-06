const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const AUTHORIZATION_HEADER = /(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const COOKIE_HEADER = /(Cookie:\s*)([^\n\r]+)/gi;
const GENERIC_SECRET = /\b(secret|token|api[_-]?key)=([^\s]+)/gi;

export function redactSecrets(text) {
  let output = String(text ?? "");
  const rules = [];

  output = output.replace(OPENAI_KEY, () => {
    if (!rules.includes("openai_key")) rules.push("openai_key");
    return "[REDACTED:openai_key]";
  });

  output = output.replace(AUTHORIZATION_HEADER, (match, prefix, value) => {
    if (value.startsWith("[REDACTED:")) return match;
    if (!rules.includes("authorization_header")) rules.push("authorization_header");
    return `${prefix}[REDACTED:authorization_header]`;
  });

  output = output.replace(COOKIE_HEADER, (match, prefix, value) => {
    if (value.startsWith("[REDACTED:")) return match;
    if (!rules.includes("cookie")) rules.push("cookie");
    return `${prefix}[REDACTED:cookie]`;
  });

  output = output.replace(GENERIC_SECRET, (_match, key) => {
    if (!rules.includes("generic_secret")) rules.push("generic_secret");
    return `${key}=[REDACTED:generic_secret]`;
  });

  return {
    text: output,
    redacted: rules.length > 0,
    rules
  };
}
