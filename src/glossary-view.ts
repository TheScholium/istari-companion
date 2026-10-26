/*
 * Glossary, in Obsidian.
 *
 * - An index of every term in the vault, kept current as notes change.
 * - A Glossary note, alphabetized, rebuilt from the index. Links such as
 *   [[Glossary#Geodesic]] reach a term's heading.
 * - In each note, a glossary block of that note's own terms, at the top of
 *   the margin (or, in a narrow pane, a folded block above the text).
 * - Bold text that names a term shows the term's definition on hover.
 */
import {
  Component,
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  PaneType,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  debounce,
  editorInfoField,
  editorLivePreviewField,
  normalizePath,
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { EditorState, Extension, RangeSetBuilder, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import {
  GLOSSARY_MARK,
  GlossaryEntry,
  GlossaryIndex,
  Term,
  displayText,
  extractGlossary,
  findBold,
  headingFor,
  isOwnGlossary,
  renderGlossary,
  termKey,
} from "./glossary";

const TERM_ATTR = "data-istari-term";
const SHOW_DELAY = 300;
const HIDE_DELAY = 250;

interface Block {
  el: HTMLElement;
  component: Component;
  sig: string;
}

function moveContent(from: HTMLElement, to: HTMLElement): void {
  const only = from.children.length === 1 ? from.firstElementChild : null;
  const src = only && only.tagName === "P" && only.instanceOf(HTMLElement) ? only : from;
  while (src.firstChild) to.appendChild(src.firstChild);
}

function isSystemFolder(f: TAbstractFile): boolean {
  return f instanceof TFolder && /^[\W\d_]*system$/i.test(f.name);
}

export class Glossary {
  readonly index = new GlossaryIndex();
  private ready = false;
  private warned = false;
  private blocks = new Map<HTMLElement, Block>();
  private card: HTMLElement | null = null;
  private cardComponent: Component | null = null;
  private cardTarget: HTMLElement | null = null;
  private pending: HTMLElement | null = null;
  private showTimer = 0;
  private hideTimer = 0;
  private frame = 0;
  private markedVersion = 0;

  constructor(
    private readonly plugin: Plugin,
    /** Re-measure open panes (footnotes, margin) for one file, or all. */
    private readonly refresh: (file?: TFile) => void,
  ) {}

  private get app() {
    return this.plugin.app;
  }

  load(): void {
    const plugin = this.plugin;
    plugin.registerEditorExtension([termMarks(this.index), glossaryBlockField(this)]);

    plugin.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.index.removeFile(file.path)) this.afterChange();
    }));
    plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.index.renameFile(oldPath, file.path)) this.afterChange();
      else if (file instanceof TFile && file.basename.toLowerCase() === "glossary") this.scheduleWrite();
    }));

    // Hover cards
    plugin.registerDomEvent(document, "mouseover", (e) => this.onOver(e));
    plugin.registerDomEvent(document, "mouseout", (e) => this.onOut(e));
    plugin.registerDomEvent(document, "mousedown", (e) => {
      const t = e.target;
      if (this.card && !(t instanceof Node && this.card.contains(t))) this.hideCard();
    }, true);
    plugin.registerDomEvent(document, "keydown", (e) => { if (e.key === "Escape") this.hideCard(); }, true);
    plugin.registerDomEvent(document, "scroll", () => this.hideCard(), true);

    this.app.workspace.onLayoutReady(() => void this.scanVault());
  }

  unload(): void {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.hideCard();
    this.blocks.forEach((b) => { b.el.remove(); b.component.unload(); });
    this.blocks.clear();
    document.querySelectorAll(`[${TERM_ATTR}]`).forEach((el) => {
      el.removeAttribute(TERM_ATTR);
      el.removeClass("istari-gloss-term");
    });
  }

  /* ---------- Index ---------- */

  private async scanVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      const text = await this.app.vault.cachedRead(files[i]);
      this.ingest(files[i].path, text);
      if (i % 64 === 63) await new Promise((r) => window.setTimeout(r, 0));
    }
    this.ready = true;
    this.afterChange();
  }

  private ingest(path: string, text: string): boolean {
    if (text.startsWith(GLOSSARY_MARK)) return this.index.removeFile(path);
    const entries = /\*\*|__/.test(text) ? extractGlossary(text) : [];
    return this.index.setFile(path, entries);
  }

  /** Call with each note's new text (from metadataCache "changed"). */
  onChanged(file: TFile, text: string): void {
    if (this.ingest(file.path, text)) this.afterChange(file);
  }

  private afterChange(file?: TFile): void {
    if (!this.ready) return;
    this.scheduleWrite();
    this.refresh(file);
    this.scheduleEditors();
  }

  /** The note's own terms (for deciding whether its pane needs a margin). */
  entriesFor(path: string): GlossaryEntry[] {
    return this.index.entriesFor(path);
  }

  /* ---------- The Glossary note ---------- */

  /** The note named Glossary, preferring one in a System folder. */
  glossaryFile(): TFile | null {
    const all = this.app.vault.getMarkdownFiles().filter((f) => f.basename.toLowerCase() === "glossary");
    if (!all.length) return null;
    const rank = (f: TFile) => (f.parent && isSystemFolder(f.parent) ? 0 : 1);
    all.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return all[0];
  }

  private newGlossaryPath(): string {
    const system = this.app.vault.getRoot().children.find(isSystemFolder);
    return normalizePath(system ? `${system.path}/Glossary.md` : "Glossary.md");
  }

  private scheduleWrite = debounce(() => void this.writeGlossary(), 1500, true);

  private async writeGlossary(): Promise<void> {
    if (!this.ready) return;
    const file = this.glossaryFile();
    const at = file ? file.path : this.newGlossaryPath();
    const linkFor = (path: string): string => {
      const f = this.app.vault.getAbstractFileByPath(path);
      return f instanceof TFile ? this.app.metadataCache.fileToLinktext(f, at, true) : path.replace(/\.md$/, "");
    };
    const text = renderGlossary(this.index.sorted(), linkFor);
    try {
      if (file) {
        const current = await this.app.vault.read(file);
        if (current === text) return;
        if (!isOwnGlossary(current)) {
          if (!this.warned) {
            this.warned = true;
            new Notice(`Istari Companion did not change "${file.path}" because it was not made by the plugin. Rename that note, or empty it, to let the plugin keep the glossary there.`, 12000);
          }
          return;
        }
        await this.app.vault.process(file, (data) => (isOwnGlossary(data) ? text : data));
      } else if (this.index.size) {
        await this.app.vault.create(at, text);
      }
    } catch (err) {
      console.error("Istari Companion: could not write the glossary", err);
    }
  }

  private openTerm(term: Term, newLeaf: PaneType | boolean): void {
    const file = this.glossaryFile();
    if (!file) return;
    const link = this.app.metadataCache.fileToLinktext(file, "", true) + "#" + headingFor(term.term);
    void this.app.workspace.openLinkText(link, "", newLeaf);
  }

  private openSource(path: string, line: number, newLeaf: PaneType | boolean): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    void this.app.workspace.getLeaf(newLeaf).openFile(file, { eState: { line } });
  }

  /* ---------- The note's own glossary block ---------- */

  /** Re-attach blocks after Obsidian re-renders a view, on the next frame. */
  ensureSoon(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
        if (leaf.view instanceof MarkdownView) this.updateBlocks(leaf.view);
      });
    });
  }

  /**
   * Put the note's glossary at the top of its Reading view, after the title
   * and properties. (Live Preview gets its block from glossaryBlockField,
   * because the editor's wrappers are flex boxes, where a float cannot reach
   * the margin; only inside the editor content does it stack with sidenotes.)
   */
  updateBlocks(view: MarkdownView): void {
    const file = view.file;
    const entries = file ? this.index.entriesFor(file.path) : [];
    const header = view.containerEl.querySelector<HTMLElement>(".markdown-preview-view .markdown-preview-sizer > .mod-header");
    if (header) this.placeBlock(header, null, entries, view);

    // Forget blocks whose host has left the document.
    this.blocks.forEach((b, host) => {
      if (!host.isConnected) { b.el.remove(); b.component.unload(); this.blocks.delete(host); }
    });
  }

  private placeBlock(host: HTMLElement, before: HTMLElement | null, entries: GlossaryEntry[], view: MarkdownView): void {
    const path = view.file?.path ?? "";
    const sig = path + "\n" + JSON.stringify(entries);
    let block = this.blocks.get(host);

    if (!entries.length) {
      if (block) { block.el.remove(); block.component.unload(); this.blocks.delete(host); }
      return;
    }
    if (block && block.sig !== sig) {
      block.el.remove();
      block.component.unload();
      block = undefined;
    }
    if (!block) {
      block = this.buildBlock(entries, path, sig, (line) => view.setEphemeralState({ line }));
      this.blocks.set(host, block);
    }
    const el = block.el;
    const placed = el.parentElement === host && (before ? el.nextElementSibling === before : el === host.lastElementChild);
    if (!placed) {
      if (before) host.insertBefore(el, before);
      else host.appendChild(el);
    }
  }

  buildBlock(entries: GlossaryEntry[], path: string, sig: string, goTo: (line: number) => void): Block {
    const component = new Component();
    component.load();
    const el = createDiv({ cls: "istari-glossary", attr: { contenteditable: "false" } });

    const head = el.createDiv({ cls: "istari-glossary-head", attr: { role: "button", tabindex: "0" } });
    head.createSpan({ cls: "istari-glossary-title", text: "Glossary" });
    head.createSpan({ cls: "istari-glossary-count", text: String(entries.length) });
    const list = el.createDiv({ cls: "istari-glossary-list" });

    const isWide = () => el.closest(".istari-sn-wide") !== null;
    const openGlossary = (newLeaf: PaneType | boolean) => {
      const file = this.glossaryFile();
      if (file) void this.app.workspace.getLeaf(newLeaf).openFile(file);
    };
    head.addEventListener("click", (e) => {
      if (isWide() || Keymap.isModEvent(e)) openGlossary(Keymap.isModEvent(e));
      else el.toggleClass("is-open", !el.hasClass("is-open"));
    });
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); }
    });
    // Keep the editor from treating a click here as a click in the text.
    el.addEventListener("mousedown", (e) => e.stopPropagation());

    for (const entry of entries) {
      const row = list.createDiv({ cls: "istari-glossary-entry" });
      const term = row.createSpan({ cls: "istari-glossary-term", text: entry.term });
      term.addEventListener("click", () => goTo(entry.line));
      const def = row.createSpan({ cls: "istari-glossary-def" });
      const tmp = createDiv();
      void MarkdownRenderer.render(this.app, entry.definition, tmp, path, component).then(() => moveContent(tmp, def));
    }
    return { el, component, sig };
  }

  /* ---------- Marking bold terms ---------- */

  // Reconfigure editors so Live Preview rebuilds its glossary blocks and
  // term marks, and re-mark rendered Markdown already on screen.
  private scheduleEditors = debounce(() => {
    this.app.workspace.updateOptions();
    if (this.markedVersion !== this.index.keyVersion) {
      this.markedVersion = this.index.keyVersion;
      this.markRendered(document.body);
    }
  }, 300, true);

  /** Mark <strong> elements whose text names a term (rendered Markdown). */
  markRendered(root: HTMLElement): void {
    if (!this.index.size && !root.querySelector(`[${TERM_ATTR}]`)) return;
    root.querySelectorAll<HTMLElement>("strong").forEach((s) => {
      if (s.closest(".istari-glossary-card, .istari-glossary")) return;
      const key = termKey(s.textContent ?? "");
      if (key && this.index.has(key)) {
        if (s.getAttribute(TERM_ATTR) !== key) s.setAttribute(TERM_ATTR, key);
        s.addClass("istari-gloss-term");
      } else if (s.hasAttribute(TERM_ATTR)) {
        s.removeAttribute(TERM_ATTR);
        s.removeClass("istari-gloss-term");
      }
    });
  }

  /* ---------- Hover cards ---------- */

  private termAt(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>(`[${TERM_ATTR}]`);
  }

  private onOver(e: MouseEvent): void {
    const t = e.target;
    if (this.card && t instanceof Node && this.card.contains(t)) {
      window.clearTimeout(this.hideTimer);
      return;
    }
    const el = this.termAt(t);
    if (!el || el.closest(".istari-glossary-card")) return;
    if (this.cardTarget && el.getAttribute(TERM_ATTR) === this.cardTarget.getAttribute(TERM_ATTR) && this.card) {
      window.clearTimeout(this.hideTimer);
      return;
    }
    window.clearTimeout(this.showTimer);
    this.pending = el;
    this.showTimer = window.setTimeout(() => {
      if (this.pending === el && el.isConnected) this.showCard(el);
    }, SHOW_DELAY);
  }

  private onOut(e: MouseEvent): void {
    const from = this.termAt(e.target);
    const to = e.relatedTarget;
    const inCard = this.card && to instanceof Node && this.card.contains(to);
    const toTerm = this.termAt(to);
    const sameTerm = from && toTerm && from.getAttribute(TERM_ATTR) === toTerm.getAttribute(TERM_ATTR);
    if (inCard || sameTerm) return;
    const leavingCard = this.card && e.target instanceof Node && this.card.contains(e.target);
    if (!from && !leavingCard) return;
    window.clearTimeout(this.showTimer);
    this.pending = null;
    if (this.card) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.hideCard(), HIDE_DELAY);
    }
  }

  private showCard(target: HTMLElement): void {
    const key = target.getAttribute(TERM_ATTR) ?? "";
    const term = this.index.lookup(key);
    if (!term) return;
    this.hideCard();

    const component = new Component();
    component.load();
    const card = document.body.createDiv({ cls: "istari-glossary-card" });
    const title = card.createDiv({ cls: "istari-glossary-card-term", text: term.term });
    title.setAttr("aria-label", "Open in the Glossary");
    title.addEventListener("click", (e) => { this.hideCard(); this.openTerm(term, Keymap.isModEvent(e)); });

    const here = this.app.workspace.getActiveFile()?.path ?? "";
    for (const d of term.definitions) {
      const box = card.createDiv({ cls: "istari-glossary-card-def" });
      const body = box.createDiv({ cls: "istari-glossary-card-body" });
      const tmp = createDiv();
      void MarkdownRenderer.render(this.app, d.definition, tmp, d.path, component).then(() => {
        moveContent(tmp, body);
        this.position(card, target);
      });
      const file = this.app.vault.getAbstractFileByPath(d.path);
      const name = file instanceof TFile ? file.basename : d.path;
      const src = box.createDiv({ cls: "istari-glossary-card-source", text: d.path === here ? "This note" : name });
      src.addEventListener("click", (e) => { this.hideCard(); this.openSource(d.path, d.line, Keymap.isModEvent(e)); });
    }

    this.card = card;
    this.cardComponent = component;
    this.cardTarget = target;
    this.position(card, target);
  }

  private position(card: HTMLElement, target: HTMLElement): void {
    if (!card.isConnected) return;
    const r = target.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const pad = 8;
    const left = Math.max(pad, Math.min(r.left, window.innerWidth - w - pad));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - pad && r.top - h - 6 > pad) top = r.top - h - 6;
    card.setCssStyles({ left: `${left}px`, top: `${top}px` });
  }

  private hideCard(): void {
    window.clearTimeout(this.hideTimer);
    if (!this.card) return;
    this.card.remove();
    this.cardComponent?.unload();
    this.card = null;
    this.cardComponent = null;
    this.cardTarget = null;
  }
}

/** Live Preview: mark bold spans whose text names a term. */
function termMarks(index: GlossaryIndex): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      version: number;

      constructor(view: EditorView) {
        this.version = index.keyVersion;
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate): void {
        const lpChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
        const stale = this.version !== index.keyVersion;
        if (u.docChanged || u.viewportChanged || lpChanged || stale) {
          this.version = index.keyVersion;
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const state = view.state;
        if (!state.field(editorLivePreviewField, false) || !index.size) return Decoration.none;
        const b = new RangeSetBuilder<Decoration>();
        const tree = syntaxTree(state);
        let last = -1;
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = state.doc.lineAt(pos);
            pos = line.to + 1;
            if (line.from <= last) continue;
            last = line.from;
            for (const s of findBold(line.text)) {
              const key = termKey(displayText(s.inner));
              if (!index.has(key)) continue;
              const start = line.from + s.from;
              const node = tree.resolveInner(start + 2, 1);
              if (/code|math|frontmatter|comment/i.test(node.type.name)) continue;
              b.add(start, line.from + s.to, Decoration.mark({
                class: "istari-gloss-term",
                attributes: { [TERM_ATTR]: key },
              }));
            }
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* ---------- Live Preview glossary block ---------- */

const widgetBlocks = new WeakMap<HTMLElement, Component>();

class GlossaryBlockWidget extends WidgetType {
  constructor(
    private readonly glossary: Glossary,
    private readonly entries: GlossaryEntry[],
    private readonly path: string,
    private readonly sig: string,
  ) {
    super();
  }

  eq(other: GlossaryBlockWidget): boolean {
    return other.sig === this.sig;
  }

  toDOM(view: EditorView): HTMLElement {
    const goTo = (line: number) => {
      const doc = view.state.doc;
      const pos = doc.line(Math.min(line + 1, doc.lines)).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    };
    const block = this.glossary.buildBlock(this.entries, this.path, this.sig, goTo);
    // Obsidian sets margin: 0 !important on every child of the editor
    // content, so the block floats inside a plain wrapper that takes it.
    const host = createDiv({ cls: "istari-glossary-host" });
    host.appendChild(block.el);
    widgetBlocks.set(host, block.component);
    return host;
  }

  destroy(dom: HTMLElement): void {
    widgetBlocks.get(dom)?.unload();
    widgetBlocks.delete(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// Where the note's text begins: after the frontmatter, if there is any.
function bodyStart(doc: Text): number {
  if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text)) return 0;
  for (let n = 2; n <= doc.lines; n++) {
    if (/^(---|\.\.\.)\s*$/.test(doc.line(n).text)) return n < doc.lines ? doc.line(n + 1).from : doc.line(n).to;
  }
  return 0;
}

function blockDecorations(state: EditorState, glossary: Glossary): DecorationSet {
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;
  const path = state.field(editorInfoField, false)?.file?.path;
  if (!path) return Decoration.none;
  const entries = glossary.entriesFor(path);
  if (!entries.length) return Decoration.none;
  const sig = path + "\n" + JSON.stringify(entries);
  const widget = new GlossaryBlockWidget(glossary, entries, path, sig);
  return Decoration.set([Decoration.widget({ widget, block: true, side: -1 }).range(bodyStart(state.doc))]);
}

/** Live Preview: the note's glossary as a block at the top of its text. */
function glossaryBlockField(glossary: Glossary): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, glossary),
    update(value, tr) {
      const lpChanged = tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false);
      if (tr.docChanged || tr.reconfigured || lpChanged) return blockDecorations(tr.state, glossary);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
