// Pure logic: no `obsidian` import, so tests/ can run it under plain Node.

export interface Heading {
  level: number;
  /** Heading text as written, without the leading # and any closing #s. */
  text: string;
  /** Offset of the start of the heading line. */
  from: number;
  /** Offset of the end of the heading line (before its newline). */
  lineEnd: number;
}

export interface Section {
  title: string;
  level: number;
  /** Start of the heading line. */
  from: number;
  /** End of the last non-blank line of the section. */
  to: number;
  /** Text under the heading, without leading blank lines or trailing whitespace. */
  body: string;
}

export type Leave = 'link' | 'embed' | 'nothing';

export interface Change {
  from: number;
  to: number;
  insert: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Lines outside front matter and code blocks, with the offset of each line start (a trailing \r is dropped). */
function* bodyLines(text: string): Generator<{ clean: string; offset: number }> {
  let offset = 0;
  let fence: string | null = null;
  let inFront = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clean = line.replace(/\r$/, '');
    if (i === 0 && clean === '---') {
      inFront = true;
    } else if (inFront) {
      if (clean === '---' || clean === '...') inFront = false;
    } else if (fence) {
      const m = FENCE.exec(clean);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && clean.trim() === m[1]) fence = null;
    } else {
      const f = FENCE.exec(clean);
      if (f) fence = f[1];
      else yield { clean, offset };
    }
    offset += line.length + 1;
  }
}

/** Every ATX heading outside front matter and code blocks, in order. */
export function findHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  for (const { clean, offset } of bodyLines(text)) {
    const m = HEADING.exec(clean);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), from: offset, lineEnd: offset + clean.length });
  }
  return out;
}

/** How many headings each level has: level to count. */
export function levelCounts(text: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const h of findHeadings(text)) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => a[0] - b[0]));
}

function build(text: string, headings: Heading[], index: number): Section {
  const h = headings[index];
  let end = text.length;
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= h.level) {
      end = headings[j].from;
      break;
    }
  }
  const raw = text.slice(h.from, end).replace(/\s+$/, '');
  const body = text
    .slice(Math.min(h.lineEnd + 1, h.from + raw.length), h.from + raw.length)
    .replace(/^(?:[ \t\r]*\n)+/, '')
    .replace(/\s+$/, '');
  return { title: h.text, level: h.level, from: h.from, to: h.from + raw.length, body };
}

/** One section per heading of `level`; deeper headings stay inside their section. */
export function sectionsAtLevel(text: string, level: number): Section[] {
  const headings = findHeadings(text);
  const out: Section[] = [];
  headings.forEach((h, i) => {
    if (h.level === level) out.push(build(text, headings, i));
  });
  return out;
}

/** The section of the nearest heading at or above `offset`, or null before the first heading. */
export function sectionAt(text: string, offset: number): Section | null {
  const headings = findHeadings(text);
  let found = -1;
  headings.forEach((h, i) => {
    if (h.from <= offset) found = i;
  });
  return found < 0 ? null : build(text, headings, found);
}

/** A heading as plain text: no links, emphasis, highlights or code marks. */
export function plainTitle(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|==|~~|\*|`)/g, '')
    .trim();
}

/** A file name Obsidian accepts on every platform; "Untitled" when nothing is left. */
export function safeFileName(title: string): string {
  const name = plainTitle(title)
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 100)
    .trim();
  if (!name) return 'Untitled';
  // Windows refuses these names with any extension, so a vault synced to Windows could not hold them.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name}_` : name;
}

/** One free name per title: the heading's name, then "Name 2", "Name 3" when taken (by the vault or by an earlier section). */
export function noteNames(titles: string[], exists: (name: string) => boolean): string[] {
  const used = new Set<string>();
  const taken = (n: string) => used.has(n.toLowerCase()) || exists(n);
  return titles.map((title) => {
    const base = safeFileName(title);
    let name = base;
    for (let n = 2; taken(name); n++) name = `${base} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Content of the new note: the section without its heading (the heading is the file name). */
export function noteContent(section: Section): string {
  return section.body ? section.body + '\n' : '';
}

/** What the source gets: each section is replaced by its link, its embed, or removed. */
export function buildChanges(text: string, sections: Section[], links: string[], leave: Leave): Change[] {
  return sections.map((s, i) => {
    if (leave === 'nothing') {
      const to = text[s.to] === '\n' ? s.to + 1 : text.startsWith('\r\n', s.to) ? s.to + 2 : s.to;
      return { from: s.from, to, insert: '' };
    }
    return { from: s.from, to: s.to, insert: (leave === 'embed' ? '!' : '') + links[i] };
  });
}

/** Applies changes to a string (used by tests; the plugin applies them in one editor transaction). */
export function applyChanges(text: string, changes: Change[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

export interface LinkLine {
  /** Start and end of the line that holds only the link. */
  from: number;
  to: number;
  /** Path of the linked note as written (URL-decoded for Markdown links). */
  target: string;
  embed: boolean;
}

// A line that is only a link to a whole note: [[Note]], ![[Note]], [[Note|alias]], [x](Note.md). Links to a heading or block are not whole notes.
const WIKI_LINE = /^[ \t]*(!?)\[\[([^\]|#^]+)(?:\|[^\]]*)?\]\][ \t]*$/;
const MD_LINE = /^[ \t]*(!?)\[[^\]]*\]\(<?([^)<>#]+\.md)>?\)[ \t]*$/i;

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Lines that hold only a link or embed to a note, outside front matter and code blocks: what a split leaves behind. */
export function findLinkLines(text: string): LinkLine[] {
  const out: LinkLine[] = [];
  for (const { clean, offset } of bodyLines(text)) {
    const w = WIKI_LINE.exec(clean);
    const m = w ? null : MD_LINE.exec(clean);
    if (w) out.push({ from: offset, to: offset + clean.length, target: w[2].trim(), embed: w[1] === '!' });
    else if (m) out.push({ from: offset, to: offset + clean.length, target: decode(m[2].trim()), embed: m[1] === '!' });
  }
  return out;
}

/** Level for a merged section: one deeper than the nearest heading above `offset` (at most 6), or 1 with none. */
export function mergeLevel(text: string, offset: number): number {
  let level = 0;
  for (const h of findHeadings(text)) if (h.from < offset) level = h.level;
  return Math.min(level + 1, 6);
}

/** A note's text without its front matter, trimmed. */
export function bodyOf(content: string): string {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  return (m ? content.slice(m[0].length) : content).trim();
}

/** The reverse of a split: each link line becomes a heading named after its note, followed by that note's text. */
export function buildMerge(text: string, links: LinkLine[], titles: string[], contents: string[]): Change[] {
  return links.map((l, i) => {
    const body = bodyOf(contents[i]);
    const heading = `${'#'.repeat(mergeLevel(text, l.from))} ${titles[i]}`;
    return { from: l.from, to: l.to, insert: body ? `${heading}

${body}` : heading };
  });
}
