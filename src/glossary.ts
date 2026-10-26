/*
 * Glossary extraction.
 *
 * One rule: bold text followed by a colon defines a term.
 *
 *     **Geodesic**: a curve whose tangent is parallel along itself.
 *
 * The term is the bold text; the definition is the rest of that line. Code,
 * math, frontmatter and %% comments %% are skipped. Everything here is pure
 * text processing, so it can be tested outside Obsidian.
 */

export interface GlossaryEntry {
  /** The term as written, with emphasis and link syntax removed. */
  term: string;
  /** Lower-case, space-collapsed form used for matching. */
  key: string;
  /** Markdown after the colon. */
  definition: string;
  /** Zero-based line of the definition in its note. */
  line: number;
}

export interface BoldSpan {
  /** Offset of the opening delimiter. */
  from: number;
  /** Offset just past the closing delimiter. */
  to: number;
  /** The text between the delimiters, as written. */
  inner: string;
}

const ESCAPED = /\\./g;

// Blank out inline code, inline math and escaped characters, keeping every
// offset, so that a scan of the result cannot match inside them.
function maskInline(line: string): string {
  let out = line.replace(ESCAPED, "  ");
  out = out.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
  out = out.replace(/\$\$[\s\S]*?\$\$|\$(?=\S)(?:[^$]*?\S)?\$/g, (m) => " ".repeat(m.length));
  return out;
}

/** Bold spans (**x** or __x__) in one line, outside code and math. */
export function findBold(line: string): BoldSpan[] {
  const masked = maskInline(line);
  const out: BoldSpan[] = [];
  // No lookbehind: Obsidian on iOS before 16.4 cannot run one.
  const re = /(\*\*|__)([^\s*_](?:(?:(?!\1).)*?\S)?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    // A third delimiter character makes this bold-italic; keep the outer pair.
    out.push({ from, to, inner: line.slice(from + 2, to - 2) });
  }
  return out;
}

/** The plain text a reader sees for a span of inline Markdown. */
export function displayText(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t: string) => t.replace(/#\^?/g, " "))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*+/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/==/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The matching key for a term: what it reads as, ignoring case. */
export function termKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every term defined in a note, in order. */
export function extractGlossary(src: string): GlossaryEntry[] {
  const lines = src.split("\n");
  const out: GlossaryEntry[] = [];
  let fence: string | null = null;
  let inMath = false;
  let inComment = false;
  let i = 0;

  // Frontmatter
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    for (i = 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i])) { i++; break; }
    }
  }

  for (; i < lines.length; i++) {
    const raw = lines[i];
    // Quote and callout markers do not change what a line means here.
    const body = raw.replace(/^(\s*>)+\s?/, "");

    if (fence) {
      if (body.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const f = /^\s*(`{3,}|~{3,})/.exec(body);
    if (f) { fence = f[1]; continue; }

    // Block math and comments may open and close on one line.
    const mathMarks = (maskInlineCode(body).match(/\$\$/g) ?? []).length;
    if (inMath) {
      if (mathMarks % 2 === 1) inMath = false;
      continue;
    }
    const commentMarks = (body.match(/%%/g) ?? []).length;
    if (inComment) {
      if (commentMarks % 2 === 1) inComment = false;
      continue;
    }

    let line = raw;
    // Drop a comment that opens on this line, and anything after it.
    const c = line.indexOf("%%");
    if (c >= 0) {
      const close = line.indexOf("%%", c + 2);
      if (close < 0) { inComment = true; line = line.slice(0, c); }
      else line = line.slice(0, c) + " ".repeat(close + 2 - c) + line.slice(close + 2);
    }
    if (mathMarks % 2 === 1) inMath = true;

    for (const b of findBold(line)) {
      // Step over the extra marker of ***bold italic***.
      let end = b.to;
      while (line[end] === "*" || line[end] === "_") end++;
      if (line[end] !== ":") continue;
      const term = displayText(b.inner);
      if (!term) continue;
      const definition = line
        .slice(end + 1)
        .replace(/\s\^[\w-]+\s*$/, "")
        .trim();
      if (!definition) continue;
      out.push({ term, key: termKey(term), definition, line: i });
    }
  }
  return out;
}

function maskInlineCode(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
}

/* ---------- The vault-wide glossary ---------- */

export interface Definition {
  definition: string;
  path: string;
  line: number;
}

export interface Term {
  term: string;
  key: string;
  definitions: Definition[];
}

export const GLOSSARY_MARK =
  "%% Istari Companion keeps this note. It collects every **term**: definition in the vault and rebuilds this list when a note changes, so edits here are replaced. %%";

export class GlossaryIndex {
  private byFile = new Map<string, GlossaryEntry[]>();
  private terms: Map<string, Term> | null = null;
  /** Increases whenever the set of keys changes. */
  keyVersion = 0;
  private keySig = "";

  /** Replace one note's entries. Returns true if anything changed. */
  setFile(path: string, entries: GlossaryEntry[]): boolean {
    const old = this.byFile.get(path);
    if (!entries.length) {
      if (!old) return false;
      this.byFile.delete(path);
    } else {
      if (old && JSON.stringify(old) === JSON.stringify(entries)) return false;
      this.byFile.set(path, entries);
    }
    this.invalidate();
    return true;
  }

  removeFile(path: string): boolean {
    if (!this.byFile.delete(path)) return false;
    this.invalidate();
    return true;
  }

  renameFile(oldPath: string, newPath: string): boolean {
    const e = this.byFile.get(oldPath);
    if (!e) return false;
    this.byFile.delete(oldPath);
    this.byFile.set(newPath, e);
    this.invalidate();
    return true;
  }

  entriesFor(path: string): GlossaryEntry[] {
    return this.byFile.get(path) ?? [];
  }

  lookup(key: string): Term | undefined {
    return this.all().get(key);
  }

  has(key: string): boolean {
    return this.all().has(key);
  }

  get size(): number {
    return this.all().size;
  }

  /** All terms, alphabetized. */
  sorted(): Term[] {
    return Array.from(this.all().values()).sort((a, b) =>
      a.term.localeCompare(b.term, undefined, { sensitivity: "base", numeric: true }) ||
      a.term.localeCompare(b.term),
    );
  }

  private invalidate(): void {
    this.terms = null;
    const sig = Array.from(this.all().keys()).sort().join("\n");
    if (sig !== this.keySig) {
      this.keySig = sig;
      this.keyVersion++;
    }
  }

  private all(): Map<string, Term> {
    if (this.terms) return this.terms;
    const terms = new Map<string, Term>();
    const paths = Array.from(this.byFile.keys()).sort();
    for (const path of paths) {
      for (const e of this.byFile.get(path) ?? []) {
        let t = terms.get(e.key);
        if (!t) {
          t = { term: e.term, key: e.key, definitions: [] };
          terms.set(e.key, t);
        }
        t.definitions.push({ definition: e.definition, path, line: e.line });
      }
    }
    this.terms = terms;
    return terms;
  }
}

/** A term as a heading that [[Glossary#...]] links can reach. */
export function headingFor(term: string): string {
  return term.replace(/[#|^[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The text of the Glossary note. `linkFor(path)` returns the link text for a
 * source note, as Obsidian would write it from the Glossary note.
 */
export function renderGlossary(terms: Term[], linkFor: (path: string) => string): string {
  const parts: string[] = [GLOSSARY_MARK, ""];
  if (!terms.length) {
    parts.push("No terms yet. Write `**Term**: definition` in any note and it appears here.", "");
  }
  for (const t of terms) {
    parts.push("## " + headingFor(t.term), "");
    for (const d of t.definitions) {
      parts.push(d.definition + " — [[" + linkFor(d.path) + "]]", "");
    }
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

/** Whether a note's text says this plugin made it (or it is empty). */
export function isOwnGlossary(text: string): boolean {
  const t = text.trim();
  return t === "" || t.startsWith(GLOSSARY_MARK);
}
