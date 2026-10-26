/*
 * Istari Companion
 *
 * 1. Sidenotes. Footnotes, inline ^[...] or labelled [^x], become margin
 *    notes in Reading view and in Live Preview. In Live Preview the source
 *    returns whenever the cursor enters it, as link and bold syntax do.
 *    Notes sit in a right-hand margin when the pane is wide enough (this
 *    plugin measures it); otherwise the reference number opens the note in
 *    place. A note that begins with "? " is a query. The footnote list at the
 *    foot is hidden on screen but kept for PDF export.
 *
 * 2. Callout shorthand. Typing THEOREM (or DEFINITION, LEMMA, PROOF, ...) at
 *    the start of a line, then a space, colon or Enter, turns the line into
 *    "> [!theorem] ". One undo restores the plain word.
 *
 * 3. Untitled callouts. Obsidian fills an untitled callout's title with its
 *    type name, which CSS cannot tell apart from a typed title. Callouts whose
 *    title equals their type are marked data-istari-untitled.
 *
 * 4. Glossary. Bold text followed by a colon defines a term. Each note shows
 *    its own terms at the top of the margin; a note named Glossary collects
 *    every term in the vault, alphabetized; bold text that names a term shows
 *    its definition on hover. See glossary.ts and glossary-view.ts.
 */
import {
  Component,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Plugin,
  TFile,
  editorInfoField,
  editorLivePreviewField,
} from "obsidian";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorState, Extension, Prec, Range, Text } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { Glossary } from "./glossary-view";

const WIDE_PX = 980;

/* ---------- Footnote scanning ---------- */

interface Token {
  from: number;
  to: number;
  inline?: string;
  label?: string;
  number: number;
}

// Footnote references in a stretch of Markdown, in order, with positions,
// skipping code and math. Definitions ("[^x]: ...") are not references.
function scanFootnotes(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let j = i;
      while (src[j] === "`") j++;
      const k = src.indexOf(src.slice(i, j), j);
      i = k < 0 ? j : k + (j - i);
      continue;
    }
    if (c === "$") {
      const d = src[i + 1] === "$" ? "$$" : "$";
      const k = src.indexOf(d, i + d.length);
      i = k < 0 ? i + d.length : k + d.length;
      continue;
    }
    if (c === "^" && src[i + 1] === "[") {
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === "[") depth++;
        else if (src[j] === "]" && --depth === 0) break;
      }
      if (j < n) {
        out.push({ from: i, to: j + 1, inline: src.slice(i + 2, j), number: 0 });
        i = j + 1;
        continue;
      }
    }
    if (c === "[" && src[i + 1] === "^") {
      const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i, i + 200));
      if (m) {
        const lineHead = src.slice(src.lastIndexOf("\n", i - 1) + 1, i);
        const lineStart = /^(\s*>)*\s*$/.test(lineHead);
        const isDefinition = lineStart && src[i + m[0].length] === ":";
        if (!isDefinition) out.push({ from: i, to: i + m[0].length, label: m[1], number: 0 });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Body of a labelled footnote definition, including indented continuation lines.
function findDefinition(text: string, label: string): string | null {
  const q = "(?:[ \\t]*>)*[ \\t]*";
  const re = new RegExp(
    "^" + q + "\\[\\^" + escapeRe(label) + "\\]:[ \\t]*(.*(?:\\n" + q + "(?:[ \\t]{2,}|\\t).*)*)",
    "m",
  );
  const m = re.exec(text);
  return m ? m[1].replace(/\n(?:[ \t]*>)*[ \t]+/g, "\n") : null;
}

// Number footnotes as Obsidian does: in order of first reference; a label
// used twice keeps its first number.
function numberFootnotes(tokens: Token[]): Token[] {
  const byLabel = new Map<string, number>();
  let next = 1;
  for (const t of tokens) {
    if (t.label !== undefined) {
      if (!byLabel.has(t.label)) byLabel.set(t.label, next++);
      t.number = byLabel.get(t.label) ?? 0;
    } else t.number = next++;
  }
  return tokens;
}

// Editor documents are immutable, so a scan can be reused until the text
// changes. Moving the cursor costs nothing.
interface Scan { text: string; tokens: Token[] }
const scanCache = new WeakMap<Text, Scan>();
function scanDoc(doc: Text): Scan {
  let scan = scanCache.get(doc);
  if (!scan) {
    const text = doc.toString();
    scan = { text, tokens: numberFootnotes(scanFootnotes(text)) };
    scanCache.set(doc, scan);
  }
  return scan;
}

/* ---------- Building a note (shared by both views) ---------- */

function noteShell(number: string | number): { note: HTMLSpanElement; body: HTMLSpanElement } {
  const note = createSpan({ cls: "istari-sidenote" });
  note.createSpan({ cls: "istari-sidenote-number", text: String(number) });
  const body = note.createSpan({ cls: "istari-sidenote-body" });
  return { note, body };
}

// Move the children of a single rendered paragraph (or of the whole block)
// into the note body, so a one-paragraph note stays inline.
function moveContent(from: HTMLElement, to: HTMLElement): void {
  const only = from.children.length === 1 ? from.firstElementChild : null;
  const src = only && only.tagName === "P" && only.instanceOf(HTMLElement) ? only : from;
  while (src.firstChild) to.appendChild(src.firstChild);
}

function buildNote(plugin: Plugin, md: string, number: string | number, sourcePath: string, component: Component): HTMLSpanElement {
  const { note, body } = noteShell(number);
  if (/^\?\s/.test(md)) {
    note.addClass("is-query");
    md = md.replace(/^\?\s+/, "");
  }
  const tmp = createDiv();
  void MarkdownRenderer.render(plugin.app, md, tmp, sourcePath, component).then(() => moveContent(tmp, body));
  return note;
}

// Build a note from a footnote list item Obsidian has already rendered.
function buildNoteFromItem(li: HTMLElement, number: string): HTMLSpanElement {
  const { note, body } = noteShell(number);
  const content = li.cloneNode(true) as HTMLElement;
  content.querySelectorAll(".footnote-backref").forEach((a) => a.remove());
  moveContent(content, body);
  const first = body.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE && /^\?\s/.test(first.textContent ?? "")) {
    note.addClass("is-query");
    first.textContent = (first.textContent ?? "").replace(/^\?\s+/, "");
  }
  return note;
}

function isWide(el: HTMLElement): boolean {
  return el.closest(".istari-sn-wide") !== null;
}

/* ---------- Live Preview widget ---------- */

// Each rendered widget owns a Component that holds its rendered Markdown.
// CodeMirror may call toDOM more than once for one widget, so the component
// is kept per DOM node and released in destroy().
const widgetComponents = new WeakMap<HTMLElement, Component>();

class SidenoteWidget extends WidgetType {
  constructor(
    private readonly plugin: Plugin,
    private readonly md: string,
    private readonly number: number,
    private readonly sourcePath: string,
  ) {
    super();
  }

  eq(other: SidenoteWidget): boolean {
    return other.md === this.md && other.number === this.number && other.sourcePath === this.sourcePath;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = createSpan({ cls: "istari-sn-anchor" });
    const sup = wrap.createEl("sup", { cls: "footnote-ref istari-sidenote-ref" });
    sup.createEl("a", { text: String(this.number) });

    const component = new Component();
    component.load();
    widgetComponents.set(wrap, component);
    const note = buildNote(this.plugin, this.md, this.number, this.sourcePath, component);
    wrap.appendChild(note);

    // Put the cursor inside the footnote, which reveals its source.
    const edit = () => {
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: Math.min(pos + 2, view.state.doc.length) } });
      view.focus();
    };

    sup.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (isWide(wrap)) edit();
      else note.toggleClass("is-open", !note.hasClass("is-open"));
    });
    note.addEventListener("mousedown", (e) => {
      const target = e.target;
      const link = target instanceof Element ? target.closest("a") : null;
      if (link) {
        e.preventDefault();
        if (link.hasClass("internal-link")) {
          const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
          void this.plugin.app.workspace.openLinkText(href, this.sourcePath, e.metaKey || e.ctrlKey);
        } else if (link.href) {
          window.open(link.href);
        }
        return;
      }
      e.preventDefault();
      edit();
    });
    return wrap;
  }

  destroy(dom: HTMLElement): void {
    widgetComponents.get(dom)?.unload();
    widgetComponents.delete(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// CodeMirror puts a zero-width buffer image on each side of an inline
// widget, and a line may break before an image, so a reference mark could
// wrap to the next line by itself. A one-character mark on the text just
// before the footnote lets styles.css hide that one buffer (a sibling
// selector, no :has), and a digit straight after a letter or a stop is not
// a break point. Returns where that mark starts, or -1 for no mark.
function glueStart(state: EditorState, from: number, floor: number): number {
  if (from - 1 < floor) return -1;
  let start = from - 1;
  const ch = state.doc.sliceString(start, from);
  if (/\s/.test(ch)) return -1;
  // Do not split a surrogate pair (an emoji, for example).
  if (/[\uDC00-\uDFFF]/.test(ch) && start - 1 >= floor) start--;
  return start;
}

function sidenoteEditorExtension(plugin: Plugin): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate): void {
        const lpChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
        if (u.docChanged || u.selectionSet || u.viewportChanged || lpChanged) this.decorations = this.build(u.view);
      }

      build(view: EditorView): DecorationSet {
        const state = view.state;
        if (!state.field(editorLivePreviewField, false)) return Decoration.none;
        const info = state.field(editorInfoField, false);
        const sourcePath = info?.file?.path ?? "";
        const { text, tokens } = scanDoc(state.doc);
        const sel = state.selection.ranges;
        const ranges: Range<Decoration>[] = [];
        let prevEnd = 0;

        for (const t of tokens) {
          const floor = prevEnd;
          prevEnd = t.to;
          // While the cursor or selection touches a footnote, show its source.
          if (sel.some((r) => r.from <= t.to && r.to >= t.from)) continue;
          const md = t.inline !== undefined ? t.inline : findDefinition(text, t.label ?? "");
          if (md === null) continue;
          ranges.push(
            Decoration.replace({ widget: new SidenoteWidget(plugin, md, t.number, sourcePath) }).range(t.from, t.to),
          );
          const start = glueStart(state, t.from, floor);
          if (start >= 0) ranges.push(Decoration.mark({ class: "istari-sn-glue" }).range(start, t.from));
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* ---------- Callout shorthand ---------- */

const CALLOUT_WORDS: Record<string, string> = {
  THEOREM: "theorem", THM: "theorem", DEFINITION: "definition", DEF: "definition",
  LEMMA: "lemma", PROPOSITION: "proposition", COROLLARY: "corollary", PROOF: "proof",
  EXAMPLE: "example", REMARK: "remark", AXIOM: "axiom", CONJECTURE: "conjecture",
  INTUITION: "intuition", EXERCISE: "exercise", WARNING: "warning",
};

interface Hit { lineFrom: number; type: string }

// If the line up to the cursor is exactly one of the words, return its type.
function shorthandAt(state: EditorState, pos: number): Hit | null {
  const line = state.doc.lineAt(pos);
  const type = CALLOUT_WORDS[state.doc.sliceString(line.from, pos)];
  if (!type || pos !== line.to) return null;
  const node = syntaxTree(state).resolveInner(line.from, 1);
  if (/codeblock|math|frontmatter|comment/i.test(node.type.name)) return null;
  return { lineFrom: line.from, type };
}

function calloutShorthand(): Extension {
  // The typed character goes in first, as its own history step, so that a
  // single undo turns "> [!theorem] " back into the word as typed.
  const expand = (view: EditorView, hit: Hit, tail: string) => {
    const insert = "> [!" + hit.type + "] " + tail;
    view.dispatch({
      changes: { from: hit.lineFrom, to: view.state.doc.lineAt(hit.lineFrom).to, insert },
      selection: { anchor: hit.lineFrom + insert.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.istari-callout",
    });
  };

  const onType = EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== " " && text !== ":") return false;
    if (from !== to || !view.state.selection.main.empty) return false;
    const hit = shorthandAt(view.state, from);
    if (!hit) return false;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    expand(view, hit, "");
    return true;
  });

  const onEnter = Prec.highest(
    keymap.of([
      {
        key: "Enter",
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const hit = shorthandAt(view.state, sel.head);
          if (!hit) return false;
          expand(view, hit, "\n> ");
          return true;
        },
      },
    ]),
  );

  return [onType, onEnter];
}

/* ---------- Untitled callouts ---------- */

const UNTITLED = "data-istari-untitled";

function markCallout(callout: Element): void {
  const type = (callout.getAttribute("data-callout") ?? "").trim().toLowerCase();
  const inner = callout.querySelector(":scope > .callout-title .callout-title-inner");
  if (!type || !inner) return;
  const title = (inner.textContent ?? "").trim().toLowerCase();
  const untitled = title === "" || title === type;
  if (callout.hasAttribute(UNTITLED) !== untitled) callout.toggleAttribute(UNTITLED, untitled);
}

function scanCallouts(root: Node | null): void {
  if (!root || !root.instanceOf(HTMLElement)) return;
  if (root.matches(".callout")) markCallout(root);
  root.querySelectorAll(".callout").forEach(markCallout);
  const host = root.closest(".callout");
  if (host) markCallout(host);
}

/* ---------- Plugin ---------- */

export default class IstariCompanion extends Plugin {
  private measured = new WeakSet<HTMLElement>();
  private observer: MutationObserver | null = null;
  private resizer: ResizeObserver | null = null;
  private glossary: Glossary = new Glossary(this, (file) => this.refreshAllLeaves(file));

  onload(): void {
    document.body.addClass("istari-companion");

    this.registerMarkdownPostProcessor((el, ctx) => {
      scanCallouts(el);
      this.renderSidenotes(el, ctx);
      this.glossary.markRendered(el);
      this.glossary.ensureSoon();
    });
    this.glossary.load();
    this.registerEditorExtension(sidenoteEditorExtension(this));
    this.registerEditorExtension(calloutShorthand());

    // Clicks on a reference mark in rendered text (Reading view, and callouts
    // rendered in Live Preview) open or light its note. Handled at the window
    // in the capture phase, ahead of Obsidian's own footnote and editing
    // handlers, which would otherwise scroll away or enter edit mode.
    const refFor = (e: MouseEvent): HTMLElement | null => {
      const target = e.target;
      const sup = target instanceof Element ? target.closest<HTMLElement>("sup.istari-sidenote-ref") : null;
      return sup && !sup.closest(".istari-sn-anchor") ? sup : null;
    };
    this.registerDomEvent(window, "mousedown", (e) => {
      if (refFor(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    this.registerDomEvent(window, "click", (e) => {
      const sup = refFor(e);
      if (!sup) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const note = sup.nextElementSibling;
      if (!note || !note.hasClass("istari-sidenote") || !note.instanceOf(HTMLElement)) return;
      note.toggleClass("is-open", !note.hasClass("is-open"));
      note.removeClass("is-flash");
      void note.offsetWidth;
      note.addClass("is-flash");
    }, true);

    // Live Preview rebuilds callout widgets in place, sometimes after the
    // post-processor has run, so watch the editor DOM for new callouts too.
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((node) => scanCallouts(node));
        if (r.type === "characterData") scanCallouts(r.target.parentElement);
      }
    });

    // Measure each pane: margin notes only where there is room for them.
    this.resizer = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target.instanceOf(HTMLElement)) e.target.toggleClass("istari-sn-wide", e.contentRect.width >= WIDE_PX);
      }
    });

    this.app.workspace.onLayoutReady(() => {
      scanCallouts(document.body);
      this.observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
      this.refreshAllLeaves();
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshAllLeaves()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshAllLeaves()));
    this.registerEvent(this.app.metadataCache.on("changed", (file, data) => {
      this.glossary.onChanged(file, data);
      this.refreshAllLeaves(file);
    }));
  }

  onunload(): void {
    document.body.removeClass("istari-companion");
    this.glossary.unload();
    this.observer?.disconnect();
    this.resizer?.disconnect();
    document.querySelectorAll(`[${UNTITLED}]`).forEach((c) => c.removeAttribute(UNTITLED));
    document.querySelectorAll(".istari-has-sidenotes, .istari-sn-wide").forEach((v) =>
      v.removeClasses(["istari-has-sidenotes", "istari-sn-wide"]));
  }

  // Mark each Markdown pane: does its note need the margin (footnotes, or
  // terms for its glossary block), decided from the file so the column does
  // not jump as sections render? And is the pane wide enough?
  private refreshAllLeaves(onlyFile?: TFile): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const file = view.file;
      const pane = view.containerEl;
      if (!this.measured.has(pane)) {
        this.measured.add(pane);
        this.resizer?.observe(pane);
      }
      this.glossary.updateBlocks(view);
      if (onlyFile && file.path !== onlyFile.path) return;
      void this.app.vault.cachedRead(file).then((text) => {
        const terms = this.glossary.entriesFor(file.path).length > 0;
        pane.toggleClass("istari-has-sidenotes", terms || scanFootnotes(text).length > 0);
      });
    });
  }

  // Rendered Markdown (Reading view, and callouts in Live Preview): insert a
  // note after each footnote reference. Notes are built from the source when
  // its references can be matched one to one; otherwise from the footnote list
  // Obsidian rendered alongside (as it does inside a Live Preview callout).
  private renderSidenotes(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const refs = Array.from(el.querySelectorAll<HTMLElement>("sup.footnote-ref")).filter(
      (s) => !s.hasClass("istari-sidenote-ref"),
    );
    if (!refs.length) return;

    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);

    const numberOf = (sup: HTMLElement, k: number): string => {
      const a = sup.querySelector("a");
      const m = ((a && a.getAttribute("href")) ?? "").match(/#fn-(\d+)/) ?? (sup.textContent ?? "").match(/\d+/);
      return m ? m[1] ?? m[0] : String(k + 1);
    };
    const attach = (sup: HTMLElement, note: HTMLElement, number: string) => {
      const a = sup.querySelector("a");
      if (a) a.textContent = number;
      sup.addClass("istari-sidenote-ref");
      sup.insertAdjacentElement("afterend", note);
    };

    // Path 1: from the source
    const info = ctx.getSectionInfo(el);
    if (info) {
      const lines = info.text.split("\n");
      const tokens = scanFootnotes(lines.slice(info.lineStart, info.lineEnd + 1).join("\n"));
      if (tokens.length === refs.length) {
        const mds = tokens.map((t) => (t.inline !== undefined ? t.inline : findDefinition(info.text, t.label ?? "")));
        if (mds.every((md) => md !== null)) {
          refs.forEach((sup, k) => {
            const number = numberOf(sup, k);
            attach(sup, buildNote(this, mds[k] ?? "", number, ctx.sourcePath, child), number);
          });
          return;
        }
      }
    }

    // Path 2: from the footnote list rendered in the same block
    const items = Array.from(
      el.querySelectorAll<HTMLElement>("section.footnotes li[data-footnote-id], .footnotes li[id^='fn-']"),
    );
    if (!items.length) return;
    let used = 0;
    refs.forEach((sup, k) => {
      const number = numberOf(sup, k);
      const li = items.find((item) =>
        new RegExp("^fn-" + number + "(-|$)").test(item.getAttribute("data-footnote-id") ?? item.id),
      );
      if (!li) return;
      attach(sup, buildNoteFromItem(li, number), number);
      used++;
    });
    if (used === items.length) el.querySelectorAll("section.footnotes").forEach((f) => f.addClass("istari-converted"));
  }
}
