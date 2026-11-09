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

/** Every ATX heading outside front matter and code blocks, in order. */
export function findHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  let offset = 0;
  let fence: string | null = null;
  let inFront = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length;
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
      if (f) {
        fence = f[1];
      } else {
        const m = HEADING.exec(clean);
        if (m) out.push({ level: m[1].length, text: m[2].trim(), from: offset, lineEnd: offset + clean.length });
      }
    }
    offset = lineEnd + 1;
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
