import { Editor, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type { App, MarkdownFileInfo, MarkdownView, SettingDefinitionItem, TFile } from 'obsidian';

import { buildChanges, buildMerge, findLinkLines, levelCounts, noteContent, noteNames, sectionAt, sectionsAtLevel } from './src/logic.ts';
import type { Leave, LinkLine, Section } from './src/logic.ts';

interface SplitSettings {
  /** Folder for the new notes; empty means the folder of the note being split. */
  folder: string;
  /** What the source keeps where a section was. */
  leave: Leave;
}

const DEFAULT_SETTINGS: SplitSettings = { folder: '', leave: 'link' };

/** Pick the heading level to split at. */
class LevelPicker extends FuzzySuggestModal<number> {
  constructor(
    app: App,
    private counts: Map<number, number>,
    private choose: (level: number) => void,
  ) {
    super(app);
    this.setPlaceholder('Split at which heading level?');
  }
  getItems(): number[] {
    return [...this.counts.keys()];
  }
  getItemText(level: number): string {
    const n = this.counts.get(level) ?? 0;
    return `Heading ${level} (${n} ${n === 1 ? 'note' : 'notes'})`;
  }
  onChooseItem(level: number): void {
    this.choose(level);
  }
}

export default class SplitByHeadingPlugin extends Plugin {
  settings: SplitSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<SplitSettings> | null) };
    this.addSettingTab(new SplitSettingTab(this.app, this));

    this.addCommand({
      id: 'split-by-level',
      name: 'Split note by headings (pick level)',
      icon: 'split',
      editorCallback: (editor, ctx) => this.pickLevel(editor, ctx),
    });
    this.addCommand({
      id: 'split-here',
      name: 'Split note here (heading above)',
      icon: 'scissors',
      editorCallback: (editor, ctx) => {
        const text = editor.getValue();
        const section = sectionAt(text, editor.posToOffset(editor.getCursor()));
        if (!section) {
          new Notice('Click under a heading first.');
          return;
        }
        void this.split(editor, ctx, [section]);
      },
    });
    this.addCommand({
      id: 'merge-here',
      name: 'Merge linked note back (link on this line)',
      icon: 'merge',
      editorCallback: (editor, ctx) => {
        const text = editor.getValue();
        const at = editor.posToOffset(editor.getCursor());
        const link = findLinkLines(text).find((l) => l.from <= at && at <= l.to);
        if (!link) {
          new Notice('Put the cursor on a line that holds only a link to a note.');
          return;
        }
        void this.merge(editor, ctx, [link]);
      },
    });
    this.addCommand({
      id: 'merge-all',
      name: 'Merge all linked notes back (links on their own line)',
      icon: 'combine',
      editorCallback: (editor, ctx) => {
        const links = findLinkLines(editor.getValue());
        if (links.length === 0) {
          new Notice('No line holds only a link to a note.');
          return;
        }
        void this.merge(editor, ctx, links);
      },
    });
  }

  private pickLevel(editor: Editor, ctx: MarkdownView | MarkdownFileInfo) {
    const counts = levelCounts(editor.getValue());
    if (counts.size === 0) {
      new Notice('This note has no headings.');
      return;
    }
    const run = (level: number) => void this.split(editor, ctx, sectionsAtLevel(editor.getValue(), level));
    if (counts.size === 1) run([...counts.keys()][0]);
    else new LevelPicker(this.app, counts, run).open();
  }

  /** Creates one note per section, then replaces the sections in the source in one editor transaction. */
  private async split(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, sections: Section[]) {
    const source = ctx.file;
    if (!source || sections.length === 0) return;
    const original = editor.getValue();
    const vault = this.app.vault;

    const folder = this.settings.folder.trim() ? normalizePath(this.settings.folder.trim()) : (source.parent?.path ?? '/');
    const inRoot = folder === '/' || folder === '';
    const pathOf = (name: string) => normalizePath(inRoot ? `${name}.md` : `${folder}/${name}.md`);
    const taken = new Set(vault.getAllLoadedFiles().map((f) => f.path.toLowerCase()));
    const names = noteNames(
      sections.map((s) => s.title),
      // Case-insensitive: on Windows and macOS "intro.md" collides with an existing "Intro.md".
      (name) => taken.has(pathOf(name).toLowerCase()),
    );

    const created: TFile[] = [];
    try {
      if (!inRoot && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      for (let i = 0; i < sections.length; i++) created.push(await vault.create(pathOf(names[i]), noteContent(sections[i])));
    } catch (e) {
      await this.discard(created);
      new Notice(`Could not create the notes: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // The note may have been edited while the files were being created: do not apply stale offsets.
    if (editor.getValue() !== original) {
      await this.discard(created);
      new Notice('The note changed while splitting. Nothing was changed; try again.');
      return;
    }

    const links = created.map((f) => this.app.fileManager.generateMarkdownLink(f, source.path));
    const changes = buildChanges(original, sections, links, this.settings.leave);
    editor.transaction({
      changes: changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })),
    });
    new Notice(`Split into ${created.length} ${created.length === 1 ? 'note' : 'notes'}. Undo restores the source note only.`);
  }

  /**
   * The reverse of a split: each link line becomes a heading with the linked note's text, then those notes go to the trash.
   * The source changes in one editor transaction; the notes are trashed only after it is applied.
   */
  private async merge(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, links: LinkLine[]) {
    const source = ctx.file;
    if (!source) return;
    const original = editor.getValue();
    const used: LinkLine[] = [];
    const files: TFile[] = [];
    for (const l of links) {
      const f = this.app.metadataCache.getFirstLinkpathDest(l.target, source.path);
      if (f && f.extension === 'md' && f.path !== source.path) {
        used.push(l);
        files.push(f);
      }
    }
    if (used.length === 0) {
      new Notice('Those links do not point to other notes.');
      return;
    }
    const contents = await Promise.all(files.map((f) => this.app.vault.read(f)));
    if (editor.getValue() !== original) {
      new Notice('The note changed while merging. Nothing was changed; try again.');
      return;
    }
    const changes = buildMerge(original, used, files.map((f) => f.basename), contents);
    editor.transaction({
      changes: changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })),
    });
    await this.discard([...new Set(files)]);
    new Notice(`Merged ${used.length} ${used.length === 1 ? 'note' : 'notes'} and moved ${used.length === 1 ? 'it' : 'them'} to the trash. Undo restores the source note only.`);
  }

  private async discard(files: TFile[]) {
    for (const f of files) {
      try {
        await this.app.fileManager.trashFile(f);
      } catch {
        // Nothing more to do: the file stays and the user sees it.
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

const TEXT = {
  folder: {
    name: 'Folder for the new notes',
    desc: 'Leave empty to create them next to the note being split. The folder is created if it does not exist.',
  },
  leave: {
    name: 'What the source note keeps',
    desc: 'Where a section was, the source gets a link to the new note, an embed of it, or nothing.',
  },
};
const LEAVE_OPTIONS = { link: 'A link', embed: 'An embed', nothing: 'Nothing' };

class SplitSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: SplitByHeadingPlugin,
  ) {
    super(app, plugin);
  }

  /** Obsidian 1.13+ draws and searches the tab from these; older versions call `display()`. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { ...TEXT.folder, control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder, placeholder: 'Same folder as the note' } },
      { ...TEXT.leave, control: { type: 'dropdown', key: 'leave', defaultValue: DEFAULT_SETTINGS.leave, options: LEAVE_OPTIONS } },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: value });
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName(TEXT.folder.name)
      .setDesc(TEXT.folder.desc)
      .addText((t) =>
        t
          .setPlaceholder('Same folder as the note')
          .setValue(this.plugin.settings.folder)
          .onChange((v) => this.setControlValue('folder', v)),
      );
    new Setting(containerEl)
      .setName(TEXT.leave.name)
      .setDesc(TEXT.leave.desc)
      .addDropdown((d) =>
        d
          .addOptions(LEAVE_OPTIONS)
          .setValue(this.plugin.settings.leave)
          .onChange((v) => this.setControlValue('leave', v)),
      );
  }
}
