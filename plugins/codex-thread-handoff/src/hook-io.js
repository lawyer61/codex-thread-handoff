export function parseHookInput(stdin) {
  if (!stdin || !stdin.trim()) return {};
  return JSON.parse(stdin);
}

export function jsonHookOutput(value) {
  return `${JSON.stringify(value)}\n`;
}

export function additionalContextOutput(hookEventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext
    }
  };
}
