function termsFrom(text) {
  return String(text || "")
    .split(/[^A-Za-z0-9_/-]+/)
    .filter((term) => term.length >= 4)
    .slice(0, 2);
}

export function buildCtxHandles(events) {
  const handles = [];

  for (const event of events) {
    const terms = termsFrom(event.tool_response_summary || event.prompt_summary || "");
    for (const file of event.files_touched || []) {
      if (terms.length > 0) {
        handles.push(`ctx search --file ${file} ${terms.map((term) => `--term "${term}"`).join(" ")}`);
      }
    }
  }

  return [...new Set(handles)].slice(0, 10);
}
