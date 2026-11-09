import test from 'node:test';
import assert from 'node:assert/strict';

import { applyChanges, bodyOf, buildChanges, buildMerge, findHeadings, findLinkLines, mergeLevel, levelCounts, noteContent, noteNames, safeFileName, sectionAt, sectionsAtLevel } from '../src/logic.ts';

const DOC = ['Intro line', '', '## One', 'a', '', '### Deep', 'b', '', '## Two', 'c', '', '# Top', 'd', ''].join('\n');

test('findHeadings skips front matter and code blocks', () => {
  const text = ['---', '# not a heading', '---', '# Real', '```', '# in code', '```', '~~~md', '## also code', '~~~', '## After #'].join('\n');
  assert.deepEqual(
    findHeadings(text).map((h) => [h.level, h.text]),
    [
      [1, 'Real'],
      [2, 'After'],
    ],
  );
});

test('levelCounts counts per level', () => {
  assert.deepEqual([...levelCounts(DOC)], [
    [1, 1],
    [2, 2],
    [3, 1],
  ]);
});

test('a section ends at the next heading of the same or a higher level', () => {
  const s = sectionsAtLevel(DOC, 2);
  assert.equal(s.length, 2);
  assert.equal(s[0].title, 'One');
  assert.equal(s[0].body, 'a\n\n### Deep\nb');
  assert.equal(s[1].body, 'c');
});

test('sectionAt takes the nearest heading above the cursor', () => {
  assert.equal(sectionAt(DOC, 0), null);
  assert.equal(sectionAt(DOC, DOC.indexOf('b'))?.title, 'Deep');
  assert.equal(sectionAt(DOC, DOC.indexOf('c'))?.title, 'Two');
});

test('replacing with links keeps the text around the sections', () => {
  const s = sectionsAtLevel(DOC, 2);
  const out = applyChanges(DOC, buildChanges(DOC, s, ['[[One]]', '[[Two]]'], 'link'));
  assert.equal(out, ['Intro line', '', '[[One]]', '', '[[Two]]', '', '# Top', 'd', ''].join('\n'));
  const emb = applyChanges(DOC, buildChanges(DOC, s, ['[[One]]', '[[Two]]'], 'embed'));
  assert.ok(emb.includes('![[One]]') && emb.includes('![[Two]]'));
});

test('leaving nothing removes the section and its newline', () => {
  const s = sectionsAtLevel('# A\nx\n# B\ny', 1);
  assert.equal(applyChanges('# A\nx\n# B\ny', buildChanges('# A\nx\n# B\ny', s, ['', ''], 'nothing')), '');
});

test('the last section of a note with CRLF and no trailing newline', () => {
  const text = '# A\r\nx\r\n# B\r\ny';
  const s = sectionsAtLevel(text, 1);
  assert.equal(s[0].body, 'x');
  assert.equal(s[1].body, 'y');
});

test('noteContent has no heading and ends with one newline', () => {
  assert.equal(noteContent(sectionsAtLevel('# A\n\n\nx\n\n', 1)[0]), 'x\n');
  assert.equal(noteContent(sectionsAtLevel('# A\n', 1)[0]), '');
});

test('safeFileName drops forbidden characters and formatting', () => {
  assert.equal(safeFileName('**Bold** [[Link|alias]] a/b: c?'), 'Bold alias a b c');
  assert.equal(safeFileName('#^[]'), 'Untitled');
  assert.equal(safeFileName('.hidden.'), 'hidden');
  assert.equal(safeFileName('x'.repeat(300)).length, 100);
  assert.equal(safeFileName('CON'), 'CON_');
  assert.equal(safeFileName('com1'), 'com1_');
  assert.equal(safeFileName('Console'), 'Console');
});

test('noteNames avoids vault names and repeated headings, ignoring case', () => {
  assert.deepEqual(
    noteNames(['Notes', 'notes', 'Other', 'Notes'], (n) => n === 'Other'),
    ['Notes', 'notes 2', 'Other 2', 'Notes 3'],
  );
});

test('findLinkLines finds lines that hold only a link to a whole note', () => {
  const text = ['---', '[[Front]]', '---', '# Top', '[[One]]', '', '![[Two|alias]]', 'text [[Inline]]', '[[Note#Head]]', '[[Note^id]]', '[Three](Sub%20Dir/Three.md)', '```', '[[Code]]', '```', '  [[Four]]  '].join('\n');
  assert.deepEqual(
    findLinkLines(text).map((l) => [text.slice(l.from, l.to).trim(), l.target, l.embed]),
    [
      ['[[One]]', 'One', false],
      ['![[Two|alias]]', 'Two', true],
      ['[Three](Sub%20Dir/Three.md)', 'Sub Dir/Three.md', false],
      ['[[Four]]', 'Four', false],
    ],
  );
});

test('mergeLevel is one deeper than the heading above, capped at 6, 1 with none', () => {
  const text = ['[[A]]', '# T', '[[B]]', '## U', '[[C]]', '###### V', '[[D]]'].join('\n');
  const at = (s: string) => text.indexOf(s);
  assert.deepEqual([at('[[A]]'), at('[[B]]'), at('[[C]]'), at('[[D]]')].map((o) => mergeLevel(text, o)), [1, 2, 3, 6]);
});

test('bodyOf drops front matter and trims', () => {
  assert.equal(bodyOf('---\ntags: a\n---\n\nText\n\n'), 'Text');
  assert.equal(bodyOf('\n No front\n'), 'No front');
  assert.equal(bodyOf('---\nonly: yes\n---\n'), '');
});

test('merge puts each split note back under a heading', () => {
  const sections = sectionsAtLevel(DOC, 2);
  const names = noteNames(sections.map((s) => s.title), () => false);
  const split = applyChanges(DOC, buildChanges(DOC, sections, names.map((n) => `[[${n}]]`), 'link'));
  const lines = findLinkLines(split);
  assert.equal(lines.length, 2);
  const merged = applyChanges(split, buildMerge(split, lines, names, sections.map(noteContent)));
  // No heading above the links, so they come back as level 1.
  assert.equal(merged, ['Intro line', '', '# One', '', 'a', '', '### Deep', 'b', '', '# Two', '', 'c', '', '# Top', 'd', ''].join('\n'));
});

test('an empty note merges as a bare heading', () => {
  const text = '## Up\n[[Empty]]\n';
  const [l] = findLinkLines(text);
  assert.equal(applyChanges(text, buildMerge(text, [l], ['Empty'], [''])), '## Up\n### Empty\n');
});
