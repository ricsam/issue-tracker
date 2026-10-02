export const ISSUE_BODY_MAX_LENGTH = 101000;

function plain(text: string): string {
  const escaped: string[] = [];
  return text
    .replace(
      /\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g,
      (_, char: string) => {
        escaped.push(char);
        return `\u0000${escaped.length - 1}\u0000`;
      },
    )
    .replace(/!\[[^\]]*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(`+)(.+?)\1/g, (_, _ticks: string, content: string) => {
      escaped.push(content);
      return `\u0000${escaped.length - 1}\u0000`;
    })
    .replace(/(\*{1,3}|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(
      /(^|[^\p{L}\p{N}])(_{1,3})(\S(?:.*?\S)?)\2(?=$|[^\p{L}\p{N}])/gu,
      "$1$3",
    )
    .replace(
      /\u0000(\d+)\u0000/g,
      (_, index: string) => escaped[Number(index)]!,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function leadingHeading(body: string): { text: string; end: number } | null {
  const atx = /^(?:[ \t]*\r?\n)* {0,3}#{1,6}[ \t]+([^\r\n]*)(?:\r?\n|$)/.exec(
    body,
  );
  if (atx)
    return {
      text: plain(atx[1]!.replace(/[ \t]+#+[ \t]*$/, "")),
      end: atx[0].length,
    };
  const setext =
    /^(?:[ \t]*\r?\n)* {0,3}(\S[^\r\n]*)\r?\n {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)/.exec(
      body,
    );
  return setext ? { text: plain(setext[1]!), end: setext[0].length } : null;
}

export function deriveIssueTitle(body: string): string {
  const lines = body.split(/\r?\n/);
  let fence: { char: string; length: number } | null = null;
  let first = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    if (/^(?: {4}|\t)/.test(line) || /^\s*\[[^\]]+\]:/.test(line)) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(line);
    const setext =
      line.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1] ?? "");
    if (heading || setext) {
      const title = plain(
        heading ? heading[1]!.replace(/[ \t]+#+[ \t]*$/, "") : line,
      );
      if (title) return title.slice(0, 300);
    }
    if (!first && !/^\s*(?:[-*_]\s*){3,}$/.test(line))
      first = plain(
        line
          .replace(/^\s*(?:>\s*|[-+*]\s+|\d+[.)]\s+)/, "")
          .replace(/^\[[ xX]\]\s+/, ""),
      );
  }
  return first.slice(0, 300) || "Untitled issue";
}

export function titleHeading(title: string): string {
  return (
    "# " +
    title
      .trim()
      .replace(/[\r\n]+/g, " ")
      .replace(/([\\`*_{}\[\]()#+.!<>~|\-])/g, "\\$1")
  );
}

// Migration preserves every original byte unless the title already is a heading.
export function prependLegacyTitle(title: string, body: string): string {
  const heading = leadingHeading(body);
  if (heading && heading.text === title.trim().replace(/\s+/g, " "))
    return body;
  return `${titleHeading(title)}\n\n${body}`;
}

export function replaceLeadingTitle(title: string, body: string): string {
  const heading = leadingHeading(body);
  return `${titleHeading(title)}\n\n${heading ? body.slice(heading.end).replace(/^(?:[ \t]*\r?\n)+/, "") : body}`;
}
