import { stringify } from "smol-toml";

export type TomlValue = string | number | boolean | Array<string | number | boolean>;

function serializeTomlValue(value: TomlValue): string {
  return stringify({ value }).trim().replace(/^value = /, "");
}

function findTable(source: string, table: string): { contentStart: number; contentEnd: number } | undefined {
  const header = new RegExp(`^[\\t ]*\\[${table.replaceAll(".", "\\.")}\\][\\t ]*(?:#.*)?$`, "m").exec(source);
  if (!header || header.index === undefined) return undefined;

  const contentStart = header.index + header[0].length;
  const nextHeader = /^[\t ]*\[[^\]\r\n]+\][\t ]*(?:#.*)?$/gm;
  nextHeader.lastIndex = contentStart;
  const next = nextHeader.exec(source);
  return { contentStart, contentEnd: next?.index ?? source.length };
}

/** Returns the end of a TOML value, without swallowing trailing whitespace or comments. */
function findValueEnd(source: string, start: number): number {
  let i = start;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let multiline = false;
  let lastValueCharacter = start;

  while (i < source.length) {
    const char = source[i];
    if (quote) {
      if (multiline && source.startsWith(quote.repeat(3), i)) {
        i += 3;
        quote = undefined;
        multiline = false;
        lastValueCharacter = i;
        continue;
      }
      if (!multiline && char === quote) {
        let backslashes = 0;
        for (let j = i - 1; j >= start && source[j] === "\\"; j -= 1) backslashes += 1;
        if (quote === "'" || backslashes % 2 === 0) {
          i += 1;
          quote = undefined;
          lastValueCharacter = i;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      multiline = source.startsWith(char.repeat(3), i);
      i += multiline ? 3 : 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (depth === 0 && (char === "#" || char === "\n" || char === "\r")) break;
    if (!/\s/.test(char)) lastValueCharacter = i + 1;
    i += 1;
  }

  return lastValueCharacter;
}

export function patchTomlValue(source: string, table: string, key: string, value: TomlValue): string {
  const location = findTable(source, table);
  const serialized = serializeTomlValue(value);

  if (!location) {
    const suffix = source.endsWith("\n") ? "" : "\n";
    return `${source}${suffix}\n[${table}]\n${key} = ${serialized}\n`;
  }

  const assignment = new RegExp(`^[\\t ]*${key}[\\t ]*=[\\t ]*`, "gm");
  assignment.lastIndex = location.contentStart;
  const match = assignment.exec(source);
  if (match && match.index < location.contentEnd) {
    const valueStart = match.index + match[0].length;
    const valueEnd = findValueEnd(source, valueStart);
    return `${source.slice(0, valueStart)}${serialized}${source.slice(valueEnd)}`;
  }

  const prefix = source.slice(0, location.contentEnd);
  const separator = prefix.endsWith("\n") ? "" : "\n";
  return `${prefix}${separator}${key} = ${serialized}\n${source.slice(location.contentEnd)}`;
}

export function removeTomlValue(source: string, table: string, key: string): string {
  const location = findTable(source, table);
  if (!location) return source;

  const assignment = new RegExp(`^[\\t ]*${key}[\\t ]*=.*(?:\\r?\\n|$)`, "gm");
  assignment.lastIndex = location.contentStart;
  const match = assignment.exec(source);
  if (!match || match.index >= location.contentEnd) return source;
  return `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`;
}
