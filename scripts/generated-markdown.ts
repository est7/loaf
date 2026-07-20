const marker = (name: string, side: "BEGIN" | "END"): string =>
  `<!-- generated:${name} ${side} -->`;

/** Replace only bytes between one exact generated Markdown marker pair. */
export function replaceGeneratedBlock(source: string, name: string, body: string): string {
  const beginMarker = marker(name, "BEGIN");
  const endMarker = marker(name, "END");
  const begin = source.indexOf(beginMarker);
  if (begin === -1) throw new Error(`missing BEGIN marker for generated block ${name}`);
  if (source.indexOf(beginMarker, begin + beginMarker.length) !== -1) {
    throw new Error(`multiple BEGIN markers for generated block ${name}`);
  }

  const end = source.indexOf(endMarker);
  if (end === -1) throw new Error(`missing END marker for generated block ${name}`);
  if (source.indexOf(endMarker, end + endMarker.length) !== -1) {
    throw new Error(`multiple END markers for generated block ${name}`);
  }
  if (end < begin) throw new Error(`END marker precedes BEGIN marker for generated block ${name}`);

  const contentStart = begin + beginMarker.length;
  return `${source.slice(0, contentStart)}\n${body.trimEnd()}\n${source.slice(end)}`;
}

/** Render arbitrary canonical text safely inside a Markdown table cell. */
export function markdownCodeCell(value: string): string {
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>");
  return `<code>${escaped}</code>`;
}
