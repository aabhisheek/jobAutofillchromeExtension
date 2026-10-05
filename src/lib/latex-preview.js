// Renders resume.tex as an A4 page so the Tailor page can show old vs. new
// resume side by side instead of raw LaTeX source. Two engines, same output
// contract (see renderBlocks below):
//
//   "fast"    — built-in typesetter for the subset this resume actually uses
//               (geometry/titlesec/enumitem are read from the preamble and
//               applied as CSS, so margins/rules/spacing match pdflatex).
//               Instant, no dependencies.
//
//   "latexjs" — the real TeX engine (vendored latex.js, MIT). Truer semantics
//               but it does not implement geometry/enumitem/titlesec, so the
//               preamble is sanitized for it and the same look is patched in
//               through src/lib/vendor/latex.css.
//
// Nothing here touches the network; the resume never leaves the machine.

const LATEXJS_VENDOR_URL = chrome.runtime.getURL("src/lib/vendor/latex.js");
const LATEXJS_VENDOR_CSS_URL = chrome.runtime.getURL("src/lib/vendor/latex.css");

// latex.js bundles these packages (see dist/latex.js). Anything else in a
// \usepackage line is dropped for the TeX engine instead of being a hard parse
// failure — geometry/enumitem/titlesec/tabularx are exactly the ones this
// resume uses and none of them ship with the engine.
const LATEXJS_BUNDLED_PACKAGES = new Set([
  "color", "xcolor", "echo", "gensymb", "graphics", "graphicx", "hyperref",
  "latexsym", "multicol", "stix", "textcomp", "textgreek"
]);

// Commands the TeX engine does not know. Stripped before parsing; their effect
// is re-applied from the parsed layout (margins, section rule, list spacing).
const LATEXJS_UNSUPPORTED_COMMANDS = [
  "titleformat", "titlespacing", "setlist", "pagenumbering", "setlength", "geometry"
];

const PAPER_SIZES = {
  a4: { width: "210mm", height: "297mm" },
  a5: { width: "148mm", height: "210mm" },
  letter: { width: "8.5in", height: "11in" },
  legal: { width: "8.5in", height: "14in" }
};

const DOC_FONT_PT = { "8pt": 8, "9pt": 9, "10pt": 10, "11pt": 11, "12pt": 12, "14pt": 14, "17pt": 17, "20pt": 20 };

const SECTION_SIZE_EM = {
  tiny: 0.5, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1,
  large: 1.2, Large: 1.44, LARGE: 1.728, huge: 2.074, Huge: 2.488
};

// ---- Lengths -------------------------------------------------------------
// Everything is normalised to PostScript points (72.27 per inch), which is
// what LaTeX itself works in.
const PT_PER_UNIT = { pt: 1, bp: 72.27 / 72, in: 72.27, cm: 72.27 / 2.54, mm: 72.27 / 25.4, pc: 12, sp: 1 / 65536 };

function parseLengthPt(raw, fontSizePt) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(-?[\d.]+)\s*([a-z]*)$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = (m[2] || "pt").toLowerCase();
  if (unit === "em") return value * fontSizePt;
  if (unit === "ex") return value * fontSizePt * 0.45;
  if (unit === "%") return null;
  if (unit === "") return value;
  const factor = PT_PER_UNIT[unit];
  return factor ? value * factor : null;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Reading the preamble -------------------------------------------------
// Balanced-brace group reader shared by the layout parser and the sanitizer.
function readGroup(src, start) {
  if (src[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

function stripComments(src) {
  return src.replace(/(^|[^\\])%[^\n]*/gm, (match, lead) => lead);
}

function splitOptions(text) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of String(text)) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseKeyValueList(content) {
  const options = {};
  splitOptions(content).forEach((entry) => {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      options[entry.trim()] = true;
      return;
    }
    options[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  });
  return options;
}

function getDocumentBody(src) {
  const begin = src.indexOf("\\begin{document}");
  if (begin === -1) return { body: src, preamble: "" };
  const preamble = src.slice(0, begin);
  const end = src.lastIndexOf("\\end{document}");
  const body = src.slice(begin + "\\begin{document}".length, end === -1 ? src.length : end);
  return { preamble, body };
}

// \titleformat{\section}{\normalsize\bfseries}{}{0em}{}[\titlerule]
function readTitleFormat(preamble) {
  const format = { sizeEm: 1, bold: false, italic: false, rule: false };
  const m = preamble.match(/\\titleformat\*?\s*\{[^}]*\}/);
  if (!m) return format;
  const rest = preamble.slice(preamble.indexOf(m[0]) + m[0].length);
  // Arguments 2..5 follow, possibly across lines; read the first four groups
  // plus an optional [...] after the last one.
  let i = 0;
  const groups = [];
  for (let n = 0; n < 4; n++) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] !== "{") break;
    const group = readGroup(rest, i);
    if (!group) break;
    groups.push(group.content);
    i = group.end;
  }
  while (i < rest.length && /\s/.test(rest[i])) i++;

  const styleText = groups[0] || "";
  if (/\\bfseries|\\textbf|\\bf\b/.test(styleText)) format.bold = true;
  if (/\\itshape|\\textit|\\slshape/.test(styleText)) format.italic = true;
  const sizeMatch = styleText.match(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)/);
  if (sizeMatch) format.sizeEm = SECTION_SIZE_EM[sizeMatch[1]] || 1;
  if (rest.slice(i, i + 60).includes("\\titlerule")) format.rule = true;
  return format;
}

function readTitleSpacing(preamble) {
  const spacing = { beforePt: null, afterPt: null };
  const m = preamble.match(/\\titlespacing\*?\s*\{[^}]*\}/);
  if (!m) return spacing;
  const rest = preamble.slice(preamble.indexOf(m[0]) + m[0].length);
  const groups = [];
  let i = 0;
  for (let n = 0; n < 3; n++) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] !== "{") break;
    const group = readGroup(rest, i);
    if (!group) break;
    groups.push(group.content);
    i = group.end;
  }
  const before = parseLengthPt(groups[1], 10);
  const after = parseLengthPt(groups[2], 10);
  if (before !== null) spacing.beforePt = before;
  if (after !== null) spacing.afterPt = after;
  return spacing;
}

function readSetlist(preamble, env) {
  const defaults = { leftmarginEm: null, topSepPt: null, parsepPt: null, partopsepPt: null, noitemsep: false };
  const re = new RegExp(String.raw`\\setlist\s*(?:\[\s*${env}\s*\])?\s*\{`, "i");
  const m = preamble.match(re);
  if (!m) return defaults;
  const start = preamble.indexOf(m[0]) + m[0].length - 1;
  const group = readGroup(preamble, start);
  if (!group) return defaults;
  const options = parseKeyValueList(group.content);

  const out = { ...defaults };
  if (options.leftmargin !== undefined) {
    const pt = parseLengthPt(options.leftmargin, 10);
    if (pt !== null) out.leftmarginEm = pt / 10;
  }
  if (options.topsep !== undefined) {
    const pt = parseLengthPt(options.topsep, 10);
    if (pt !== null) out.topSepPt = pt;
  }
  if (options.parsep !== undefined) {
    const pt = parseLengthPt(options.parsep, 10);
    if (pt !== null) out.parsepPt = pt;
  }
  if (options.partopsep !== undefined) {
    const pt = parseLengthPt(options.partopsep, 10);
    if (pt !== null) out.partopsepPt = pt;
  }
  if (options.itemsep === "0pt" || options.noitemsep) out.noitemsep = true;
  return out;
}

function readSetlength(preamble, name) {
  const m = preamble.match(new RegExp(String.raw`\\setlength\s*\{\\${name}\}\s*\{([^}]*)\}`));
  if (!m) return null;
  return parseLengthPt(m[1], 10);
}

// Article defaults (geometry/enumitem/titlesec overrides win when present).
function defaultLayout() {
  return {
    paper: "a4",
    fontSizePt: 10,
    marginsPt: { top: 72.27, right: 62.4, bottom: 72.27, left: 62.4 },
    parIndentPt: 15,
    parSkipPt: 0,
    section: { sizeEm: 1.44, bold: true, italic: false, rule: false, beforePt: 15.07, afterPt: 9.9 },
    itemize: readSetlistFallback()
  };
}

function readSetlistFallback() {
  return { leftmarginEm: 2.5, topSepPt: 9, parsepPt: 4.5, partopsepPt: 2, noitemsep: false };
}

function parseLatexLayout(rawTex) {
  const tex = stripComments(String(rawTex || ""));
  const { preamble } = getDocumentBody(tex);
  const layout = defaultLayout();

  const docClass = preamble.match(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/);
  if (docClass) {
    splitOptions(docClass[1] || "").forEach((option) => {
      const size = DOC_FONT_PT[option];
      if (size) layout.fontSizePt = size;
      if (option === "a4paper") layout.paper = "a4";
      else if (option === "letterpaper") layout.paper = "letter";
      else if (option === "a5paper") layout.paper = "a5";
      else if (option === "legalpaper") layout.paper = "legal";
    });
  }

  const geometryWithOptions = preamble.match(/\\usepackage\s*\[([^\]]*)\]\s*\{\s*geometry\s*\}/);
  const geometryBare = !geometryWithOptions && /\\usepackage\s*\{\s*geometry\s*\}/.test(preamble);
  if (geometryWithOptions || geometryBare) {
    const opts = parseKeyValueList(geometryWithOptions ? geometryWithOptions[1] : "");
    ["top", "right", "bottom", "left"].forEach((side) => {
      if (opts[side] === undefined) return;
      const pt = parseLengthPt(opts[side], layout.fontSizePt);
      if (pt !== null) layout.marginsPt[side] = pt;
    });
    if (opts.paperwidth && opts.paperheight) {
      const w = parseLengthPt(opts.paperwidth, layout.fontSizePt);
      const h = parseLengthPt(opts.paperheight, layout.fontSizePt);
      if (w && h) {
        layout.paper = {
          width: `${(w / 72.27).toFixed(4)}in`,
          height: `${(h / 72.27).toFixed(4)}in`
        };
      }
    }
  }

  const parIndent = readSetlength(preamble, "parindent");
  if (parIndent !== null) layout.parIndentPt = parIndent;
  const parSkip = readSetlength(preamble, "parskip");
  if (parSkip !== null) layout.parSkipPt = parSkip;

  const format = readTitleFormat(preamble);
  if (format.sizeEm) layout.section.sizeEm = format.sizeEm;
  layout.section.bold = format.bold;
  layout.section.italic = format.italic;
  layout.section.rule = format.rule;

  const spacing = readTitleSpacing(preamble);
  if (spacing.beforePt !== null) layout.section.beforePt = spacing.beforePt;
  if (spacing.afterPt !== null) layout.section.afterPt = spacing.afterPt;

  layout.itemize = readSetlist(preamble, "itemize");
  if (layout.itemize.leftmarginEm === null) layout.itemize.leftmarginEm = 2.5;
  if (layout.itemize.topSepPt === null) layout.itemize.topSepPt = 9;
  if (layout.itemize.parsepPt === null) layout.itemize.parsepPt = 4.5;

  return layout;
}

function paperDimensions(layout) {
  return typeof layout.paper === "string"
    ? PAPER_SIZES[layout.paper] || PAPER_SIZES.a4
    : layout.paper;
}

function ptToCss(pt) {
  return `${round(pt / 72.27, 4)}in`;
}

function ptToPx(pt) {
  return (pt / 72.27) * 96;
}

function round(value, digits) {
  const factor = Math.pow(10, digits || 2);
  return Math.round(value * factor) / factor;
}

// ---- Inline (within-paragraph) parsing ------------------------------------
const FILL_MARKER = "\u0001";

const SIZE_MACROS = Object.assign({ displaystyle: 1 }, SECTION_SIZE_EM);

const TEXT_MACROS = {
  quad: "\u2003", qquad: "\u2003\u2003", ",": "\u2009", ":": "\u2009", ";": "\u2005",
  "!": "", " ": " ", "newline": "\u0002", "cr": "\u0002", "par": ""
};

const IGNORED_MACROS = new Set([
  "noindent", "centering", "raggedright", "smallskip", "medskip", "bigskip",
  "clearpage", "newpage", "pagestyle", "sloppy", "protect", "relax",
  "topsep", "partopsep", "parsep", "itemsep", "labelsep", "leftmargin"
]);

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ");
}

// TeX's text ligatures: -- and --- are how LaTeX spells en/em dashes, and a
// resume written for pdflatex uses them (\hfill 2021 -- 2025).
function texLigatures(text) {
  return text
    .replace(/---/g, "\u2014")
    .replace(/--/g, "\u2013")
    .replace(/``/g, "\u201c")
    .replace(/''/g, "\u201d");
}

function inlineToHtml(src, ctx, warnings) {
  let out = "";
  let buf = "";
  let i = 0;
  // sized: an ancestor span already carries the font size, so text must not be
  // wrapped again (nested em spans compound: 1.44em inside 1.44em is 2.07em).
  const localCtx = { fontSizePt: ctx.fontSizePt, sizeEm: ctx.sizeEm || 1, sized: !!ctx.sized };

  const flush = () => {
    if (!buf) return;
    const text = escapeHtml(texLigatures(collapseWhitespace(buf)));
    const needsSpan = !localCtx.sized && localCtx.sizeEm !== 1;
    out += needsSpan ? `<span style="font-size:${round(localCtx.sizeEm, 3)}em">${text}</span>` : text;
    buf = "";
  };

  const readArgument = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "{") return "";
    const group = readGroup(src, i);
    if (!group) return "";
    i = group.end;
    return group.content;
  };

  const wrap = (tag, content) => {
    flush();
    const inner = inlineToHtml(content, localCtx, warnings);
    out += `<${tag}>${inner}</${tag}>`;
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === "{") {
      const group = readGroup(src, i);
      if (group) {
        flush();
        // {\Large ...}: the size macro applies to the whole group.
        const sizeMatch = group.content.match(/^\s*\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/);
        const inner = sizeMatch
          ? inlineToHtml(group.content.slice(sizeMatch[0].length), { fontSizePt: localCtx.fontSizePt, sizeEm: SIZE_MACROS[sizeMatch[1]], sized: true }, warnings)
          : inlineToHtml(group.content, localCtx, warnings);
        out += sizeMatch ? `<span style="font-size:${round(SIZE_MACROS[sizeMatch[1]], 3)}em">${inner}</span>` : inner;
        i = group.end;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === "}") {
      i++;
      continue;
    }

    if (ch === "\\") {
      const match = /^\\([a-zA-Z@]+|.)/.exec(src.slice(i));
      if (!match) {
        buf += ch;
        i++;
        continue;
      }
      const name = match[1];
      i += match[0].length;

      if (name === "\\") {
        let breakOffset = null;
        if (src[i] === "[") {
          const end = src.indexOf("]", i);
          if (end !== -1) {
            breakOffset = parseLengthPt(src.slice(i + 1, end), ctx.fontSizePt);
            i = end + 1;
          }
        }
        flush();
        if (breakOffset === null) {
          out += '<br class="brk">';
        } else {
          out += `<span class="brkspace" style="margin-bottom:${round(breakOffset, 2)}pt"></span><br class="brk">`;
        }
        continue;
      }

      // No comment branch here on purpose: real comments were already removed
      // by stripComments, so a "%" reaching this point is the literal percent
      // from an escaped "\%" and falls through to the single-char case below.
      if (name === "textbf" || name === "bf" || name === "mathbf" || name === "textbf ") {
        wrap("strong", readArgument());
        continue;
      }
      if (name === "textit" || name === "it" || name === "emph" || name === "textsl") {
        wrap("em", readArgument());
        continue;
      }
      if (name === "texttt" || name === "tt") {
        wrap("code", readArgument());
        continue;
      }
      if (name === "underline") {
        wrap("u", readArgument());
        continue;
      }
      if (name === "textsc") {
        wrap("span sc", readArgument());
        continue;
      }
      if (name === "textsuperscript") {
        wrap("sup", readArgument());
        continue;
      }
      if (name === "textsubscript") {
        wrap("sub", readArgument());
        continue;
      }
      if (name === "href") {
        const url = readArgument();
        const label = readArgument();
        flush();
        out += `<a href="${escapeHtml(url)}">${inlineToHtml(label, localCtx, warnings)}</a>`;
        continue;
      }
      if (name === "url") {
        const url = readArgument();
        flush();
        out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
        continue;
      }
      if (name === "colorbox" || name === "fcolorbox") {
        // Color argument is layout-only for our purposes.
        if (src[i] === "{") {
          readArgument();
          wrap("span boxed", readArgument());
          continue;
        }
      }
      if (name === "hfill") {
        flush();
        out += FILL_MARKER;
        continue;
      }
      if (name === "hrulefill") {
        flush();
        out += `${FILL_MARKER}<span class="rule-fill"></span>`;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SIZE_MACROS, name)) {
        let j = i;
        while (j < src.length && /[ \t]/.test(src[j])) j++;
        if (src[j] === "{") {
          const group = readGroup(src, j);
          if (group) {
            flush();
            i = group.end;
            out += `<span style="font-size:${round(SIZE_MACROS[name], 3)}em">${inlineToHtml(group.content, localCtx, warnings)}</span>`;
            continue;
          }
        }
        // Bare \large …: applies to the rest of the current group.
        localCtx.sizeEm = SIZE_MACROS[name];
        localCtx.sized = false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(TEXT_MACROS, name)) {
        flush();
        const literal = TEXT_MACROS[name];
        if (literal === "\u0002") out += "<br>";
        else if (literal) out += `<span class="sp">${escapeHtml(literal)}</span>`;
        continue;
      }
      if (name === "text" || name === "textrm" || name === "mbox" || name === "hbox") {
        wrap("span", readArgument());
        continue;
      }
      if (IGNORED_MACROS.has(name)) continue;
      if (/^[^a-zA-Z@]$/.test(name)) {
        buf += name;
        continue;
      }

      warnings.push(name);
      // Unknown command with a braced argument: keep the argument's text.
      if (src[i] === "{") {
        const argument = readArgument();
        buf += argument;
      }
      continue;
    }

    if (ch === "~") {
      buf += "\u00a0";
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

// Spans opened by \large / {\Large ...} get closed by tracking them here.
function closeOpenSpans(html) {
  const opens = (html.match(/<span style="font-size:/g) || []).length;
  const closes = (html.match(/<\/span>/g) || []).length;
  return opens > closes ? html + "</span>".repeat(opens - closes) : html;
}

// A LaTeX paragraph is a sequence of lines ended by \\ ; \hfill splits a line
// into left/right justified cells, so each line is assembled on its own and the
// paragraph is just the stack of them.
function assembleLine(lineHtml) {
  const trimmed = lineHtml.trim();
  if (!trimmed) return "";
  if (!trimmed.includes(FILL_MARKER)) return `<span class="line">${trimmed}</span>`;
  const cells = trimmed
    .split(FILL_MARKER)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<span class="fill">${part}</span>`);
  return cells.length ? `<span class="line row">${cells.join("")}</span>` : "";
}

function assembleParagraph(html) {
  const lines = html.split(/<br class="brk">/).map(assembleLine).filter(Boolean);
  if (!lines.length) return "";
  return `<div class="para">${lines.join("")}</div>`;
}

// ---- Block (paragraph / list / section) scanning ---------------------------
function renderFastBlocks(tex, layout, warnings) {
  const { body } = getDocumentBody(stripComments(tex));
  const lines = body.split("\n");
  const ctx = { fontSizePt: layout.fontSizePt };
  const blocks = [];

  let paragraph = [];
  let center = null;
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (!text) return;
    blocks.push(assembleParagraph(inlineToHtml(text, ctx, warnings)));
  };

  const closeList = () => {
    flushParagraph();
    if (!list) return;
    const tag = list.env === "enumerate" ? "ol" : "ul";
    // Item text needs inlineToHtml like every other block: bullets are full of
    // \textbf runs and stray "%" signs, which would otherwise leak as raw source.
    const items = list.items
      .map((item) => `<li>${assembleParagraph(inlineToHtml(item, ctx, warnings))}</li>`)
      .join("");
    blocks.push(`<${tag} class="list">${items}</${tag}>`);
    list = null;
  };

  const closeCenter = () => {
    flushParagraph();
    if (!center) return;
    const inner = center.lines.join(" ").trim();
    blocks.push(`<div class="ctr">${assembleParagraph(inlineToHtml(inner, ctx, warnings))}</div>`);
    center = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    const envMatch = line.match(/^\\(begin|end)\{([^}]+)\}/);
    if (envMatch) {
      const [, kind, env] = envMatch;
      if (kind === "begin") {
        flushParagraph();
        if (env === "center") closeCenter();
        if (env === "itemize" || env === "enumerate") closeList();
        if (env === "itemize" || env === "enumerate") list = { env, items: [], current: null };
        if (env === "center") center = { lines: [] };
        continue;
      }
      if (env === "center") {
        closeCenter();
        continue;
      }
      if (env === "itemize" || env === "enumerate") {
        if (list && list.current !== null) list.items.push(list.current);
        closeList();
        continue;
      }
      continue;
    }

    const sectionMatch = line.match(/^\\(section|subsection|subsubsection)\*?\s*\{(.*)\}\s*$/);
    if (sectionMatch) {
      flushParagraph();
      const level = { section: 2, subsection: 3, subsubsection: 4 }[sectionMatch[1]];
      blocks.push(`<h${level} class="sec">${inlineToHtml(sectionMatch[2], ctx, warnings)}</h${level}>`);
      continue;
    }

    const vspaceMatch = line.match(/^\\vspace\*?\s*\{([^}]*)\}/);
    if (vspaceMatch) {
      flushParagraph();
      const pt = parseLengthPt(vspaceMatch[1], ctx.fontSizePt) || 0;
      const spacing = pt < 0
        ? `height:0;margin-top:${round(pt, 2)}pt`
        : `height:${round(pt, 2)}pt`;
      blocks.push(`<div class="vspace" style="${spacing}"></div>`);
      continue;
    }

    if (line.match(/^\\(hrule|bigskip|medskip|smallskip)\b/)) {
      flushParagraph();
      blocks.push('<div class="vspace" style="height:6pt"></div>');
      continue;
    }

    const itemMatch = line.match(/^\\item\s*(.*)$/);
    if (itemMatch && list) {
      if (list.current !== null) list.items.push(list.current);
      list.current = itemMatch[1];
      continue;
    }

    if (center) {
      center.lines.push(line);
      continue;
    }

    if (list && list.current !== null) {
      list.current += ` ${line}`;
      continue;
    }

    paragraph.push(line);
  }

  if (list && list.current !== null) list.items.push(list.current);
  closeList();
  closeCenter();
  flushParagraph();

  return blocks;
}

// ---- Real TeX engine (vendored latex.js) ----------------------------------
let latexJsPromise = null;

function loadLatexJs() {
  if (latexJsPromise) return latexJsPromise;
  latexJsPromise = new Promise((resolve, reject) => {
    if (typeof latexjs !== "undefined") {
      resolve(window.latexjs);
      return;
    }
    const script = document.createElement("script");
    script.src = LATEXJS_VENDOR_URL;
    script.onload = () => resolve(window.latexjs);
    script.onerror = () => reject(new Error("Could not load the bundled LaTeX engine (src/lib/vendor/latex.js)."));
    document.head.appendChild(script);
  });
  return latexJsPromise;
}

let latexCssPromise = null;

function loadLatexCss() {
  if (latexCssPromise) return latexCssPromise;
  latexCssPromise = fetch(LATEXJS_VENDOR_CSS_URL)
    .then((res) => (res.ok ? res.text() : ""))
    .catch(() => "");
  return latexCssPromise;
}

// latex.js has no \hfill (it is a TeX primitive it does not implement), so
// stripping it would jam the two halves of every "Company ......... Date" row
// together. \hspace is implemented and preserves the visual gap; the width is a
// fixed guess instead of "push to the margin", which is why the built-in engine
// is the default.
const LATEXJS_MACRO_REWRITES = { hfill: "\\hspace{2em}" };

// Drops \usepackage lines for packages the engine does not ship, plus the
// layout commands it cannot parse. Returns the cleaned source.
function sanitizeForLatexJs(tex, unsupported) {
  let src = tex;

  src = src.replace(/^[ \t]*\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}[^\n]*$/gm, (match, names) => {
    const all = names.split(",").map((name) => name.trim());
    return all.every((name) => LATEXJS_BUNDLED_PACKAGES.has(name)) ? match : "";
  });

  Object.keys(LATEXJS_MACRO_REWRITES).forEach((name) => {
    src = src.replace(new RegExp(String.raw`\\${name}\b`, "g"), LATEXJS_MACRO_REWRITES[name]);
  });

  unsupported.forEach((name) => {
    src = stripCommand(src, name);
  });

  return src;
}

// Removes \name plus every braced/optional argument that follows it, including
// arguments that spill onto the next line (how titlesec/enumitem are written).
function stripCommand(src, name) {
  const pattern = new RegExp(String.raw`\\${name}\b`);
  let out = "";
  let i = 0;
  let changed = false;

  while (i < src.length) {
    if (src[i] === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src[i] === "\\") {
      const match = /^\\([a-zA-Z@]+)/.exec(src.slice(i));
      if (match && match[1] === name) {
        changed = true;
        let j = i + match[0].length;
        if (src[j] === "*") j++;

        const consume = (open, close) => {
          let depth = 0;
          for (let k = j; k < src.length; k++) {
            if (src[k] === "\\") { k++; continue; }
            if (src[k] === open) depth++;
            else if (src[k] === close) {
              depth--;
              if (depth === 0) {
                j = k + 1;
                return true;
              }
            }
          }
          j = src.length;
          return false;
        };

        while (src[j] === "{") consume("{", "}");
        while (src[j] === "[") consume("[", "]");

        for (;;) {
          let k = j;
          let newlines = 0;
          while (k < src.length && /\s/.test(src[k])) {
            if (src[k] === "\n") newlines++;
            k++;
          }
          if (newlines > 1 || (src[k] !== "{" && src[k] !== "[")) break;
          j = k;
          consume(src[k], src[k] === "{" ? "}" : "]");
        }

        out += "\n";
        i = j;
        continue;
      }
    }
    out += src[i];
    i++;
  }

  return changed ? out : src;
}

async function renderLatexJsBlocks(tex, layout, warnings) {
  const latexjs = await loadLatexJs();
  const unsupported = LATEXJS_UNSUPPORTED_COMMANDS.slice();

  let source = sanitizeForLatexJs(tex, unsupported);
  let generator = null;
  let parsed = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      generator = new latexjs.HtmlGenerator({ hyphenate: false });
      parsed = latexjs.parse(source, { generator });
      break;
    } catch (err) {
      const unknown = /unknown macro: \\([a-zA-Z@]+)/.exec(err.message || "");
      if (!unknown) {
        throw new Error(`LaTeX engine could not parse this file: ${err.message}`);
      }
      // Retry with the offending command removed rather than failing the pane.
      warnings.push(unknown[1]);
      unsupported.push(unknown[1]);
      source = stripCommand(source, unknown[1]);
      parsed = null;
    }
  }

  if (!parsed) throw new Error("LaTeX engine gave up on this file.");

  const fragment = parsed.domFragment();
  const body = fragment.querySelector(".body") || fragment;
  return Array.from(body.children).map((child) => child.outerHTML);
}

// ---- Paper document assembly ---------------------------------------------
// Highlighting works on the rendered *line*, not the block: the keyword line is
// appended to the last paragraph of Technical Skills, so marking that whole
// paragraph would paint five untouched lines green. Each engine emits a known
// line boundary — the fast renderer adjacent .line spans, latex.js a <br> — so
// the line containing the text can be isolated exactly.
const LINE_BOUNDARY = {
  fast: /(?<=<\/span>)(?=<span class="line")/,
  latexjs: /(?<=<br>)/
};

// True when the fragment opens and closes the same tags, so wrapping it in
// <mark> cannot produce broken markup (a boundary inside a tag would).
function isBalancedFragment(html) {
  const stack = [];
  const tag = /<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>/g;
  let match;
  while ((match = tag.exec(html))) {
    if (match[3] === "/") continue;
    if (match[1]) {
      if (stack.pop() !== match[2]) return false;
    } else {
      stack.push(match[2]);
    }
  }
  return stack.length === 0;
}

function highlightBlock(block, needle, engine) {
  const boundary = LINE_BOUNDARY[engine];
  if (!boundary || !block.includes(needle)) return null;

  const isFast = engine !== "latexjs";
  const marked = [];
  let matched = false;

  block.split(boundary).forEach((line) => {
    const hit = line.includes(needle);
    if (!hit) {
      marked.push(line);
      return;
    }
    matched = true;
    if (isFast) {
      marked.push(line.replace(/^<span class="line"/, '<span class="line added"'));
      return;
    }
    // A latex.js line is a bare fragment between two <br>s. The last one still
    // carries the block's closing tags, so they are set aside before wrapping.
    const trailing = line.match(/(?:<\/[a-zA-Z0-9]+>)+$/);
    const head = trailing ? line.slice(0, line.length - trailing[0].length) : line;
    const tail = trailing ? trailing[0] : "";

    // Only wrap when no tag is left open across the boundary.
    if (isBalancedFragment(head)) {
      marked.push(`<mark class="added">${head}</mark>${tail}`);
      return;
    }
    marked.push(line);
  });

  return matched ? marked.join("") : null;
}

function highlightBlocks(blocks, markerText, engine) {
  if (!markerText) return blocks;
  const needle = markerText.trim();
  return blocks.map((block) => {
    if (!block.includes(needle)) return block;

    const lineLevel = highlightBlock(block, needle, engine);
    if (lineLevel) return lineLevel;

    const open = block.match(/^<([a-zA-Z0-9]+)([^>]*)>/);
    if (!open) return block;
    const classes = open[2].includes("class=")
      ? open[2].replace(/class="([^"]*)"/, 'class="$1 added"')
      : ` class="added"${open[2]}`;
    return `<${open[1]}${classes}>${block.slice(open[0].length)}`;
  });
}

function fastEngineCss(layout) {
  const { marginsPt, section, itemize, fontSizePt } = layout;
  const paper = paperDimensions(layout);

  return `
:root { --page-width: ${paper.width}; --page-height: ${paper.height}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
.page {
  width: var(--page-width);
  min-height: var(--page-height);
  padding: ${ptToCss(marginsPt.top)} ${ptToCss(marginsPt.right)} ${ptToCss(marginsPt.bottom)} ${ptToCss(marginsPt.left)};
  margin: 0 auto;
  background: #fff;
  color: #000;
  font-family: "Latin Modern Roman", "CMU Serif", "Computer Modern Serif", Georgia, "Times New Roman", serif;
  font-size: ${round(fontSizePt, 2)}pt;
  line-height: 1.2;
  text-align: justify;
  hyphens: auto;
  -webkit-hyphens: auto;
}
.page + .page { margin-top: 8mm; }
/* One sheet per printed page: the sheets are already full-height, so the only
   thing print needs is a hard break between them. */
@media print {
  .page { break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .page + .page { margin-top: 0; }
}
.para { margin: 0 0 ${round(itemize.parsepPt, 2)}pt 0; text-indent: ${round(layout.parIndentPt, 2)}pt; }
.para .line { display: block; text-indent: 0; }
.para .line:first-child { text-indent: inherit; }
.para .line.row { display: flex; justify-content: space-between; gap: 0.6em; text-indent: 0; }
.para .line.row .fill { white-space: nowrap; }
.brkspace { display: inline-block; width: 0; height: 0; }
.ctr { text-align: center; margin: 0 0 2pt; }
.ctr .para, .ctr .line { text-indent: 0; }
h2.sec, h3.sec, h4.sec {
  font-size: ${round(fontSizePt * section.sizeEm, 2)}pt;
  font-weight: ${section.bold ? "bold" : "normal"};
  font-style: ${section.italic ? "italic" : "normal"};
  margin: ${round(section.beforePt, 2)}pt 0 ${round(section.afterPt, 2)}pt 0;
}
h2.sec { border-bottom: 0.4pt solid #000; padding-bottom: 1pt; }
ul.list, ol.list {
  margin: ${round(itemize.topSepPt, 2)}pt 0;
  padding-left: ${round(itemize.leftmarginEm, 3)}em;
}
ul.list li, ol.list li { margin: ${itemize.noitemsep ? 0 : round(itemize.parsepPt, 2)}pt 0; }
ul.list { list-style: disc; }
ol.list { list-style: decimal; }
code { font-family: "Latin Modern Mono", "Courier New", monospace; font-size: 0.92em; }
span.sc { font-variant: small-caps; }
span.sp { white-space: pre; }
.vspace { display: block; }
mark.added, .added { background: #dcfce7; box-shadow: 0 0 0 2px #dcfce7; }
a { color: inherit; text-decoration: none; }
`.trim();
}

function latexJsEngineCss() {
  return `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
.page {
  width: var(--paper-width);
  min-height: var(--page-height);
  padding: var(--margin-top) var(--margin-right) var(--margin-bottom) var(--margin-left);
  margin: 0 auto;
  max-width: none;
  min-width: 0;
  background: #fff;
}
.page + .page { margin-top: 8mm; }
/* One sheet per printed page: the sheets are already full-height, so the only
   thing print needs is a hard break between them. */
@media print {
  .page { break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .page + .page { margin-top: 0; }
}
mark.added, .added { background: #dcfce7; }
`.trim();
}

// The TeX engine emits its blocks inside a single .body wrapper; the fast
// renderer emits them bare. Applied per page so pagination can still split the
// same block list across sheets.
function wrapBlocksForEngine(blocks, engine) {
  return engine === "latexjs" ? [`<div class="body">${blocks.join("")}</div>`] : blocks;
}

// Style + sheet markup on their own, for callers that embed the sheets in a
// page of their own (the print page) instead of loading a whole document in an
// iframe.
function paperDocumentParts({ pages, layout, engine, engineCss }) {
  const paper = paperDimensions(layout);
  const { marginsPt } = layout;

  const css = engine === "latexjs" ? latexJsEngineCss() : fastEngineCss(layout);
  const pageVars = `
  --page-width: ${paper.width};
  --page-height: ${paper.height};
  --margin-top: ${ptToCss(marginsPt.top)};
  --margin-right: ${ptToCss(marginsPt.right)};
  --margin-bottom: ${ptToCss(marginsPt.bottom)};
  --margin-left: ${ptToCss(marginsPt.left)};
  --size: ${round(layout.fontSizePt, 2)}pt;
  --textwidth: 100%;
  --marginleftwidth: 0%;
  --marginrightwidth: 0%;`;

  const pagesHtml = pages
    .map((pageBlocks) => {
      const inner = wrapBlocksForEngine(pageBlocks, engine).join("");
      return `<div class="page" style="${pageVars.trim()}">${inner}</div>`;
    })
    .join("\n");

  const style = `
  @page { size: ${paper.width} ${paper.height}; margin: 0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${engine === "latexjs" ? engineCss : ""}
  ${css}
  `;

  return { style, pagesHtml, paper };
}

function buildPaperDocument(args) {
  const { style, pagesHtml } = paperDocumentParts(args);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Resume preview</title>
<style>
${style}
</style>
</head>
<body>
${pagesHtml}
</body>
</html>`;
}

// ---- Public API -----------------------------------------------------------
function renderBlocks(tex, engine, options) {
  const opts = options || {};
  const layout = opts.layout || parseLatexLayout(tex);
  const warnings = opts.warnings || [];
  if (engine === "latexjs") return renderLatexJsBlocks(tex, layout, warnings);
  return Promise.resolve(renderFastBlocks(tex, layout, warnings));
}

function pageContentHeightPx(layout) {
  const paper = paperDimensions(layout);
  const pageHeightPt = parseLengthPt(paper.height, layout.fontSizePt);
  return ptToPx(pageHeightPt - layout.marginsPt.top - layout.marginsPt.bottom);
}

// The whole pipeline both preview pages need: render → highlight → measure →
// split into sheets → one document per sheet. `loadDoc` is the caller's iframe.
async function paginatePaperPages({ tex, engine, layout, highlightText, loadDoc }) {
  const effectiveEngine = engine === "latexjs" ? "latexjs" : "fast";
  const resolvedLayout = layout || parseLatexLayout(tex);
  const warnings = [];

  const blocks = highlightBlocks(
    await renderBlocks(tex, effectiveEngine, { layout: resolvedLayout, warnings }),
    highlightText,
    effectiveEngine
  );
  const pages = await paginateBlocks({ blocks, engine: effectiveEngine, layout: resolvedLayout, loadDoc });
  const { pageDocs } = await buildPaperPages({ engine: effectiveEngine, layout: resolvedLayout, pages });

  return {
    pageDocs,
    pages,
    layout: resolvedLayout,
    warnings,
    pageCount: pageDocs.length,
    engine: effectiveEngine
  };
}

// Outer width of one sheet in CSS px. The measuring iframe has to be exactly
// this wide, otherwise its line breaking (and therefore page breaks) differ.
function paperWidthPx(layout) {
  const paper = paperDimensions(layout);
  return round(ptToPx(parseLengthPt(paper.width, layout.fontSizePt)), 2);
}

function paperHeightPx(layout) {
  const paper = paperDimensions(layout);
  return round(ptToPx(parseLengthPt(paper.height, layout.fontSizePt)), 2);
}

// One .page per sheet. The preview mounts an iframe per returned doc so sheets
// scroll independently; the print page writes them all into one document.
// `pages` (already-measured, already-highlighted block groups) skips rendering.
async function buildPaperPages({ tex, engine, layout, highlightText, pages }) {
  const effectiveEngine = engine === "latexjs" ? "latexjs" : "fast";
  const resolvedLayout = layout || parseLatexLayout(tex);
  const warnings = [];

  let groups = pages;
  if (!groups || !groups.length) {
    const rawBlocks = await renderBlocks(tex, effectiveEngine, { layout: resolvedLayout, warnings });
    groups = [highlightBlocks(rawBlocks, highlightText, effectiveEngine)];
  }

  const engineCss = effectiveEngine === "latexjs" ? await loadLatexCss() : "";
  const pageDocs = groups.map((group) =>
    buildPaperDocument({
      pages: [group],
      layout: resolvedLayout,
      engine: effectiveEngine,
      engineCss
    })
  );

  return { pageDocs, pages: groups, layout: resolvedLayout, warnings, engine: effectiveEngine };
}

// Splits `blocks` into page-sized groups by laying them out on one sheet and
// measuring what each block actually costs. The caller owns the DOM and supplies
// `loadDoc(docString) => Promise<Document>` — page breaks can only be measured in
// a real rendered document, never predicted from the source.
async function paginateBlocks({ blocks, engine, layout, loadDoc }) {
  const limit = pageContentHeightPx(layout);
  const engineCss = engine === "latexjs" ? await loadLatexCss() : "";
  const probe = buildPaperDocument({ pages: [blocks], layout, engine, engineCss });
  const doc = await loadDoc(probe);

  const pageEl = doc.querySelector(".page");
  if (!pageEl) return [blocks];

  const view = doc.defaultView;
  const elements = Array.from(doc.querySelectorAll(blockSelector(engine)));

  const groups = [[]];
  let used = 0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const rect = el.getBoundingClientRect();
    const styles = view.getComputedStyle(el);
    // Flow height of the block itself (not its position on the single probe
    // sheet): margins included, and negative ones (LaTeX \vspace) subtracted.
    const flowHeight = Math.max(
      0,
      rect.height + (parseFloat(styles.marginTop) || 0) + (parseFloat(styles.marginBottom) || 0)
    );

    // 0.5px slack: a hair over the limit is a rounding artefact, not a reason to
    // push a whole section heading onto the next sheet.
    if (used > 0 && used + flowHeight > limit + 0.5) {
      groups.push([]);
      used = 0;
    }
    groups[groups.length - 1].push(blocks[i]);
    used += flowHeight;
  }

  return groups;
}

// Blocks the measurement helper looks at, per engine.
function blockSelector(engine) {
  return engine === "latexjs" ? ".page > .body > *" : ".page > *";
}