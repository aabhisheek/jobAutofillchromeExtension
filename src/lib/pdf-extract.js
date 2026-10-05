// PDF -> LaTeX. Turns an uploaded resume PDF into LaTeX source with the
// structure we can rebuild faithfully: a centred header, section headings,
// bullet lists, bold/emphasis runs, label:value lines and title|date rows.
//
// Everything downstream (tailoring, both preview engines, print to PDF) already
// works on LaTeX, so the PDF is only a source format: the .tex it produces is
// what the user previews, tailors and prints, and can be replaced by hand in the
// .tex box if they want to adjust the conversion.
//
// What this cannot do is preserve the original PDF's typography — a PDF stores
// glyph placements, not styles, so headings are re-derived from font size and
// emphasis from glyph width. It reproduces structure and content, not pixels.

const PDFJS_PATH = "src/lib/vendor/pdf.min.js";
const PDF_WORKER_PATH = "src/lib/vendor/pdf.worker.min.js";

// Bullet glyphs seen at the start of list items in real resumes.
const BULLET_CHARS = "•‣◦▪●◘◙‣·∙–—-";
const BULLET_RE = new RegExp("^[" + BULLET_CHARS.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&") + "]\\s*");
// Section headings in resumes are often just a phrase; these words help when a
// heading happens to be set at body size.
const HEADING_WORDS = new Set([
  "summary", "objective", "profile", "about", "overview",
  "experience", "work experience", "professional experience", "employment",
  "education", "academics", "qualifications", "projects", "key projects",
  "skills", "technical skills", "core skills", "competencies", "technologies",
  "certifications", "certificates", "awards", "achievements", "honors",
  "publications", "languages", "interests", "hobbies", "activities",
  "volunteering", "volunteer experience", "references", "contact",
  "professional summary", "key achievements", "core competencies",
  "work history", "career history", "professional experience"
]);

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// LaTeX text-mode specials. Without this, a single "%" or "&" from a PDF turns
// the rest of the line into a comment or blows up the parser.
function escapeLatexText(text) {
  return String(text == null ? "" : text)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// pdf.js splits text into runs; a run can end mid-word ("Go pro-"/"gramming")
// and words are separated by gaps rather than spaces.
function joinRuns(runs, size) {
  let out = "";
  let prevX1 = null;
  for (const run of runs) {
    const text = run.text.replace(/\s+/g, " ");
    if (!out) {
      if (!text.trim()) continue;
      out = text;
      prevX1 = run.x1;
      continue;
    }
    if (/\s$/.test(out) || /^\s/.test(text)) {
      out += text;
      prevX1 = run.x1;
      continue;
    }
    const gap = run.x - prevX1;
    out += gap > 0.16 * size ? " " + text : text;
    prevX1 = run.x1;
  }
  return out.replace(/\s+/g, " ").trim();
}

// pdf.js reports a run's advance width; the dumps/tests use "w".
function itemWidth(item) {
  return item.width != null ? item.width : item.w != null ? item.w : 0;
}

// Groups text items into visual lines. pdf.js gives every run a baseline y, so
// lines are found by clustering baselines rather than trusting item order.
function groupLines(items) {
  const runs = items
    .filter((item) => item && item.s && item.s.trim() && item.size > 0)
    .map((item) => ({
      text: item.s,
      x: item.x,
      y: item.y,
      x1: item.x + itemWidth(item),
      size: item.size,
      font: item.font != null ? item.font : item.f
    }));
  runs.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  let current = null;
  for (const run of runs) {
    const tolerance = Math.max(1.2, run.size * 0.3);
    if (!current || Math.abs(current.y - run.y) > tolerance) {
      current = { y: run.y, size: run.size, runs: [run] };
      lines.push(current);
      continue;
    }
    current.runs.push(run);
    // A tall run on the line defines the line's size for spacing decisions.
    if (run.size > current.size) current.size = run.size;
  }
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.text = joinRuns(line.runs, line.size);
    line.x0 = line.runs.length ? line.runs[0].x : 0;
    line.x1 = line.runs.reduce((max, run) => Math.max(max, run.x1), 0);
  }
  return lines.filter((line) => line.text);
}

// Bold cannot be read from the font name (subset fonts are named "g_d0_f4"), so
// it is inferred from glyph width: at the same size, bold text is wider. The
// reference is the font carrying the most characters, i.e. body text.
function detectBoldFonts(items) {
  const perFont = new Map();
  for (const item of items) {
    const text = item.s || "";
    if (!text.trim() || !(item.size > 0)) continue;
    const key = String(item.font != null ? item.font : item.f);
    const entry = perFont.get(key) || { ratios: [], chars: 0 };
    entry.ratios.push(itemWidth(item) / (item.size * text.trim().length));
    entry.chars += text.trim().length;
    perFont.set(key, entry);
  }
  if (perFont.size < 2) return new Set();

  let reference = null;
  for (const [font, entry] of perFont) {
    if (!reference || entry.chars > reference.chars) reference = entry;
  }
  const bodyRatio = median(reference.ratios);
  if (!(bodyRatio > 0)) return new Set();

  const bold = new Set();
  for (const [font, entry] of perFont) {
    const ratio = median(entry.ratios);
    // 6% wider than body text is a safe bold threshold; regular and italic
    // faces sit within a few percent of each other.
    if (ratio > bodyRatio * 1.06) bold.add(font);
  }
  return bold;
}

// The size most of the text is set at. Everything bigger is a heading.
function detectBodySize(items) {
  const buckets = new Map();
  for (const item of items) {
    const text = (item.s || "").trim();
    if (!text) continue;
    const size = Math.round((item.size || 0) * 2) / 2;
    if (!(size > 0)) continue;
    buckets.set(size, (buckets.get(size) || 0) + text.length);
  }
  let best = 0;
  let bestChars = -1;
  for (const [size, chars] of buckets) {
    if (chars > bestChars) {
      best = size;
      bestChars = chars;
    }
  }
  return best || 10;
}

// Detects a vertical gutter spanned by no *line*: the signature of a two-column
// layout. Coverage has to be computed per line, not per text run — in a
// single-column resume there are plenty of x ranges no individual run reaches
// (short headings, right-aligned dates), but some line always spans them.
function detectColumns(pages) {
  for (const page of pages) {
    const items = (page.items || []).filter((item) => item && item.s && item.s.trim());
    if (items.length < 20 || !page.width) continue;
    const lines = groupLines(items);
    if (lines.length < 12) continue;
    const minX = Math.min(...lines.map((line) => line.x0));
    const maxX = Math.max(...lines.map((line) => line.x1));
    if (maxX - minX < page.width * 0.5) continue;

    const covered = new Uint8Array(Math.ceil(maxX - minX) + 1);
    for (const line of lines) {
      const from = Math.max(0, Math.round(line.x0 - minX));
      const to = Math.min(covered.length - 1, Math.round(line.x1 - minX));
      for (let i = from; i <= to; i++) covered[i] = 1;
    }
    let best = { start: -1, width: 0 };
    let start = -1;
    for (let i = 0; i < covered.length; i++) {
      if (!covered[i]) {
        if (start === -1) start = i;
        continue;
      }
      if (start !== -1 && i - start > best.width) best = { start, width: i - start };
      start = -1;
    }
    if (start !== -1 && covered.length - start > best.width) best = { start, width: covered.length - start };
    // A gutter must sit between the columns, not in a page margin.
    const interior = best.start > 2 && best.start + best.width < covered.length - 2;
    if (interior && best.width >= page.width * 0.04 && best.width <= page.width * 0.2) {
      return { page: page.page, gutter: [minX + best.start, minX + best.start + best.width] };
    }
  }
  return null;
}

// Reads one PDF page's text runs into lines with structure attached.
function pdfPagesToLines(pages, options) {
  const opts = options || {};
  const allItems = pages.flatMap((page) => page.items || []);
  const boldFonts = detectBoldFonts(allItems);
  const bodySize = detectBodySize(allItems);

  const lines = [];
  for (const page of pages) {
    for (const line of groupLines(page.items || [])) {
      lines.push(Object.assign({}, line, {
        page: page.page,
        width: page.width,
        parts: line.runs.map((run) => ({
          text: run.text,
          x: run.x,
          x1: run.x1,
          size: run.size,
          bold: boldFonts.has(String(run.font))
        }))
      }));
    }
  }

  // Vertical rhythm: used to spot paragraph breaks and heading spacing.
  const pitch = lines.length > 1
    ? median(lines.slice(1).map((line, i) => Math.abs(lines[i].y - line.y)).filter((gap) => gap > 0.5))
    : 0;
  lines.forEach((line, i) => {
    line.gapBefore = i > 0 ? lines[i - 1].y - line.y : 0;
    line.isBig = line.size >= bodySize * 1.25;
    line.isHeading = Boolean(line.isBig && line.text.length <= 90);
    const lower = line.text.toLowerCase().replace(/[:.\s]+$/, "");
    line.headingWord = HEADING_WORDS.has(lower);
    line.boldish = line.parts.length > 0 && line.parts.every((part) => part.bold);
    line.leadingBold =
      line.parts.length > 1 && line.parts[0].bold && !line.parts[line.parts.length - 1].bold;
    // A bullet list item starts with a glyph; the font of that glyph is
    // irrelevant, so the marker is stripped here and never reaches the text.
    const bullet = BULLET_RE.exec(line.text);
    line.isBullet = Boolean(bullet) && line.text.length > bullet[0].length;
    line.body = line.isBullet ? line.text.slice(bullet[0].length).trim() : line.text;
    line.gapRatio = pitch > 0 ? line.gapBefore / pitch : 0;
  });

  const warnings = [];
  const columns = opts.skipColumnCheck ? null : detectColumns(pages);
  if (columns) {
    warnings.push(
      "This PDF looks two-column, so reading order can be wrong — check the preview and use the .tex box if it is."
    );
  }
  const headings = lines.filter((line) => line.isHeading).length;
  if (lines.length > 12 && headings === 0) {
    warnings.push("No section headings were detected, so the layout may not match the original.");
  }
  const textChars = lines.reduce((sum, line) => sum + line.text.length, 0);
  if (lines.length > 4 && textChars / lines.length < 8) {
    warnings.push("The extracted text looks fragmented (many very short lines).");
  }
  if (!textChars) {
    warnings.push("No text could be extracted — this may be a scanned image rather than a text PDF.");
  }

  return { lines, bodySize, pitch, warnings, columns };
}

// No space is inserted before closing punctuation, and none after an opening
// bracket, so style-run boundaries do not read as word boundaries.
const NO_SPACE_BEFORE = /^[.,;:!?…)\]}%'"”’]/;
const NO_SPACE_AFTER = /[([{“‘]$/;

// A line split into two groups by a wide gap ("Software Engineer    Bangalore,
// India"). Right-aligned groups become \hfill rows; anything else keeps the
// visual break with \quad. Without this the groups run together as one sentence.
function splitGroups(line, contentRight) {
  const tail = rightTailParts(line, contentRight);
  if (tail) return Object.assign({}, tail, { fill: true });

  const parts = significantParts(line.parts);
  if (parts.length < 2 || parts.length > 6) return null;
  const head = [];
  const tailParts = [];
  let splitting = false;
  for (const part of parts) {
    if (!splitting && part.x - (head.length ? head[head.length - 1].x1 : parts[0].x1) > 0.03 * contentRight && head.length) {
      splitting = true;
    }
    (splitting ? tailParts : head).push(part);
  }
  if (!tailParts.length) return null;
  const headText = head.map((part) => part.text).join("").trim();
  const tailText = tailParts.map((part) => part.text).join("").trim();
  if (!headText || !tailText) return null;
  if (headText.length + tailText.length > 90) return null;
  return { head, tail: tailParts, fill: false };
}

// Wraps bold runs in \textbf and stitches the runs of one line back together.
// The gap between runs decides whether a space was there, since a PDF stores
// positions, not spaces. Spacing is resolved before styling so a space never
// ends up inside \textbf{} ("using\textbf{ Java}").
function runsToLatex(parts, from) {
  const start = from || 0;
  const pieces = [];
  let prev = null;
  let explicitSpace = false;

  for (let i = start; i < parts.length; i++) {
    const part = parts[i];
    const text = part.text.replace(/\s+/g, " ");
    if (!text.trim()) {
      // A whitespace-only run is spacing the PDF itself decided on.
      if (pieces.length) explicitSpace = true;
      continue;
    }
    let spaceBefore = false;
    if (prev) {
      const size = part.size || prev.size || 9;
      spaceBefore = !part.noSpace && (explicitSpace || part.x - prev.x1 > 0.16 * size);
    }
    pieces.push({ text, bold: !!part.bold, spaceBefore });
    explicitSpace = false;
    prev = part;
  }
  if (!pieces.length) return "";

  // A space always separates two groups, even at the same weight, so no space
  // ever has to sit inside \textbf{} ("using\textbf{ Java}" is a common bug).
  // Same-weight neighbours are then merged again, moving the space inside,
  // which keeps the generated source readable.
  const runs = [];
  for (const piece of pieces) {
    const last = runs[runs.length - 1];
    if (last && last.bold === piece.bold && !piece.spaceBefore) last.text += piece.text;
    else runs.push({ text: piece.text, bold: piece.bold, lead: piece.spaceBefore });
  }
  for (let i = runs.length - 1; i > 0; i--) {
    const run = runs[i];
    const last = runs[i - 1];
    if (run.lead && last.bold === run.bold) {
      last.text += ` ${run.text}`;
      runs.splice(i, 1);
    }
  }

  let out = "";
  runs.forEach((run, index) => {
    let text = escapeLatexText(run.text);
    // "\textbf{...} Java" — the space belongs after the group, not before it.
    const prevEnds = out.replace(/\}+$/, "");
    if (index > 0 && run.lead && !NO_SPACE_BEFORE.test(text) && !NO_SPACE_AFTER.test(prevEnds)) {
      out += " ";
    }
    out += run.bold ? `\\textbf{${text}}` : text;
  });
  return out.replace(/\s+/g, " ").trim();
}

// A trailing "-" at the end of a line plus a lowercase start is a hyphenated
// word split by the PDF, not a real hyphen: rejoin it.
// Justified PDFs hyphenate words across lines ("Go pro-" / "gramming"), so a
// paragraph is re-joined at the run level — before styling, because removing a
// hyphen that sits inside \textbf{} afterwards would unbalance the braces.
function mergeParagraphLines(lines) {
  const merged = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    const lastText = previous ? previous.text : "";
    const hyphenated = /[‐-]$/.test(lastText) && /^[a-z]/.test(line.text);
    if (!previous || !hyphenated) {
      merged.push({ text: line.text, parts: line.parts.slice() });
      continue;
    }
    const parts = previous.parts.slice();
    const last = parts[parts.length - 1];
    last.text = last.text.replace(/[‐-]\s*$/, "");
    if (!last.text.trim()) parts.pop();
    for (const part of line.parts) {
      parts.push(Object.assign({}, part, { noSpace: parts.length === 0 || !parts[parts.length - 1].text }));
    }
    merged[merged.length - 1] = { text: previous.text.slice(0, -1) + line.text, parts };
  }
  return merged;
}

function joinParagraphLines(lines) {
  return mergeParagraphLines(lines)
    .map((chunk) => runsToLatex(chunk.parts))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Drops whitespace-only runs from both ends so a right-aligned tail is found on
// the last real run rather than on the trailing space the PDF emitted.
function significantParts(parts) {
  let start = 0;
  let end = parts.length;
  while (start < end && !parts[start].text.trim()) start++;
  while (end > start && !parts[end - 1].text.trim()) end--;
  return parts.slice(start, end);
}

// Right-aligned tail ("Company | Date"): only when a short head is followed by a
// short numeric tail reaching the right edge. Requiring a digit keeps justified
// body text — which also touches the right margin — from being misread as a
// title row.
function rightTailParts(line, contentRight) {
  if (contentRight <= 0) return null;
  const parts = significantParts(line.parts);
  if (parts.length < 2 || parts.length > 8) return null;
  const tail = parts[parts.length - 1];
  const head = parts.slice(0, -1);
  const headText = head.map((part) => part.text).join("").trim();
  const tailText = tail.text.trim();
  if (headText.length > 60 || tailText.length > 34) return null;
  if (!/\d/.test(tailText)) return null;
  if (line.x1 < contentRight * 0.93) return null;
  const gap = tail.x - head[0].x1;
  if (gap < 0.03 * contentRight) return null;
  return { head, tail: [tail], fill: true };
}

// Builds a LaTeX document from classified lines. Sections, bullets and header
// are emitted as real structures; body text keeps its bold runs.
function linesToTex(result, options) {
  const opts = options || {};
  const { lines } = result;
  const body = [];
  const push = (line) => body.push(line);

  const contentRight = lines.reduce((max, line) => Math.max(max, line.x1 || 0), 0);

  let header = [];
  let inHeader = true;
  let inItemize = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = joinParagraphLines(paragraph);
    paragraph = [];
    if (text) push(text);
  };
  const closeItemize = () => {
    flushParagraph();
    if (!inItemize) return;
    inItemize = false;
    push("\\end{itemize}");
  };
  const closeHeader = () => {
    if (!inHeader && !header.length) return;
    inHeader = false;
    flushParagraph();
    if (!header.length) return;
    const inner = header.join(" \\\\ ");
    header = [];
    push(`\\begin{center}\n${inner}\n\\end{center}`);
  };

// A bold run ending in a colon marks a "Languages:" style label line.
function labelPartsOf(line) {
  const parts = significantParts(line.parts);
  return parts.length > 1 && parts[0].bold && /:/.test(parts[0].text) ? parts : null;
}

// The text a label line carries: the label itself plus any wrapped
// continuation lines, since a long skills entry spans several PDF lines.
function labelBlockText(lines, start) {
  const parts = labelPartsOf(lines[start]);
  const label = escapeLatexText(parts[0].text.replace(/\s+$/, ""));
  const rest = escapeLatexText(
    parts
      .slice(1)
      .map((part) => part.text)
      .join("")
      .replace(/^\s+/, "")
  );
  let text = `\\textbf{${label}} ${rest}`;
  let end = start;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.isHeading || line.isBullet || labelPartsOf(line) || line.gapRatio > 1.6) break;
    text += ` ${runsToLatex(line.parts)}`;
    end = j;
  }
  return { text, end };
}

// "Languages: ... / Backend: ..." is one visual block, so the lines are broken
// with \\ instead of each starting a paragraph. The break is deferred until the
// block actually ends.
let pendingLabelBreak = false;
const endLabelBlock = () => {
  if (!pendingLabelBreak) return;
  pendingLabelBreak = false;
  if (body.length) body[body.length - 1] += " \\\\";
};

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tail = splitGroups(line, contentRight);
    const hasLabel = Boolean(labelPartsOf(line));

    // The header runs until the first real heading. A large short line is a
    // candidate for the name, so heading-shaped lines are allowed there — but
    // only as the very first line and only when it is far larger than body
    // text (a name is ~1.9x, a section heading ~1.3x).
    const headerCandidate = !line.isBullet
      && (!line.isHeading || (!header.length && line.size >= result.bodySize * 1.5));
    if (inHeader && body.length === 0 && header.length < 5 && headerCandidate && !tail && !hasLabel) {
      header.push(line.size > result.bodySize * 1.2
        ? `{\\Large \\textbf{${escapeLatexText(line.text)}}}`
        : runsToLatex(line.parts));
      continue;
    }
    closeHeader();

    if (line.isHeading) {
      pendingLabelBreak = false;
      closeItemize();
      push("");
      push(`\\section*{${escapeLatexText(line.text.replace(/[:.\s]+$/, ""))}}`);
      push("");
      continue;
    }

    if (line.isBullet) {
      pendingLabelBreak = false;
      flushParagraph();
      if (!inItemize) {
        push("\\begin{itemize}");
        inItemize = true;
      }
      push(`\\item ${runsToLatex(line.parts, bulletRunOffset(line))}`);
      continue;
    }

    if (!paragraph.length) endLabelBlock();

    if (hasLabel) {
      closeItemize();
      const block = labelBlockText(lines, i);
      push(block.text);
      i = block.end;
      pendingLabelBreak = true;
      continue;
    }

    if (tail) {
      closeItemize();
      const headLatex = tail.head.every((part) => part.bold)
        ? `\\textbf{${escapeLatexText(tail.head.map((part) => part.text).join("").trim())}}`
        : runsToLatex(tail.head);
      const tailText = escapeLatexText(
        tail.tail.map((part) => part.text).join("").replace(/\s+/g, " ").trim()
      );
      push(`${headLatex} ${tail.fill ? "\\hfill" : "\\quad"} ${tailText}`);
      continue;
    }

    if (inItemize && line.gapRatio > 1.8) closeItemize();
    paragraph.push(line);
  }
  closeItemize();
  closeHeader();
  flushParagraph();

  const preamble = opts.preamble != null ? opts.preamble : DEFAULT_PREAMBLE;
  const tex = [
    preamble.trimEnd(),
    "",
    body.map((line) => line).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    "",
    "\\end{document}",
    ""
  ].join("\n");

  return { tex, warnings: result.warnings || [] };
}

// Where the bullet glyph sits in the run list, so it is not re-emitted as text.
function bulletRunOffset(line) {
  let index = 0;
  for (; index < line.parts.length; index++) {
    const text = line.parts[index].text;
    const meaningful = text.replace(new RegExp("[" + BULLET_CHARS.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&") + "]", "g"), "").trim();
    if (meaningful) break;
  }
  return Math.min(index, Math.max(0, line.parts.length - 1));
}

// Same page setup as the bundled resume, so a PDF source renders in the same
// house style as a .tex source.
const DEFAULT_PREAMBLE = [
  "\\documentclass[9pt,a4paper]{article}",
  "\\usepackage[left=0.62in, right=0.62in, top=0.38in, bottom=0.38in]{geometry}",
  "\\usepackage{enumitem}",
  "\\usepackage[hidelinks]{hyperref}",
  "\\usepackage{titlesec}",
  "\\usepackage{tabularx}",
  "\\usepackage{xcolor}",
  "\\pagenumbering{gobble}",
  "\\setlength{\\parindent}{0pt}",
  "\\setlength{\\parskip}{0pt}",
  "\\setlist[itemize]{leftmargin=1.2em,noitemsep,topsep=1pt,parsep=0pt,partopsep=0pt}",
  "\\titleformat{\\section}{\\normalsize\\bfseries}{}{0em}{}[\\titlerule]",
  "\\titlespacing*{\\section}{0pt}{5pt}{3pt}",
  "\\begin{document}"
].join("\n");

// Loads the vendored pdf.js into the page on first use (~1.5 MB, so it is only
// fetched when a PDF is actually imported).
let pdfJsPromise = null;
function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = new Promise((resolve, reject) => {
    const url = chrome.runtime.getURL(PDFJS_PATH);
    const workerUrl = chrome.runtime.getURL(PDF_WORKER_PATH);
    const script = document.createElement("script");
    // A script that neither loads nor errors (a blocked extension URL, say)
    // would leave the caller waiting on "Reading <file>…" forever.
    const timer = setTimeout(
      () => finish(new Error(`${PDFJS_PATH} did not finish loading (blocked by the page?)`)),
      20000
    );
    const finish = (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(window.pdfjsLib);
    };
    script.onload = () => {
      if (!window.pdfjsLib) {
        finish(new Error("pdf.js loaded but pdfjsLib is missing."));
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      finish(null);
    };
    script.onerror = () => finish(new Error(`Could not load ${url}`));
    document.head.appendChild(script);
  }).catch((err) => {
    pdfJsPromise = null;
    throw err;
  });
  return pdfJsPromise;
}

// pdf.js normally parses in a Worker it creates from the vendored worker file.
// If the page's CSP refuses that (extension pages have a fixed script-src), the
// worker bundle can also be evaluated in the page: the legacy build assigns
// globalThis.pdfjsWorker, which is exactly what pdf.js's "fake worker" path
// looks for. Only paid for if the first attempt fails.
let fakeWorkerPromise = null;
function loadInPageWorker(lib) {
  if (fakeWorkerPromise) return fakeWorkerPromise;
  fakeWorkerPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(PDF_WORKER_PATH);
    script.onload = () => {
      if (!window.pdfjsWorker) {
        reject(new Error("The pdf.js worker bundle did not expose pdfjsWorker."));
        return;
      }
      lib.GlobalWorkerOptions.workerSrc = "";
      resolve();
    };
    script.onerror = () => reject(new Error("Could not load the pdf.js worker bundle."));
    document.head.appendChild(script);
  });
  return fakeWorkerPromise;
}

function openPdf(lib, arrayBuffer) {
  return lib.getDocument({
    data: new Uint8Array(arrayBuffer),
    // Stop pdf.js from reaching for network font files; resumes are local.
    useSystemFonts: false,
    isEvalSupported: false
  }).promise;
}

// PDF in, LaTeX out. Returns the .tex plus what was read, so callers can show
// "3 pages, 96 lines, 12 sections" and surface any extraction warnings.
async function extractPdfToTex(arrayBuffer, options) {
  const lib = await loadPdfJs();
  let doc;
  try {
    doc = await openPdf(lib, arrayBuffer);
  } catch (err) {
    try {
      await loadInPageWorker(lib);
      doc = await openPdf(lib, arrayBuffer);
    } catch {
      const message = /password/i.test(err && err.message)
        ? "This PDF is password protected, so it cannot be read."
        : `This file could not be read as a PDF (${(err && err.message) || err}).`;
      throw new Error(message);
    }
  }

  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        page: number,
        width: viewport.width,
        height: viewport.height,
        items: content.items
          .filter((item) => typeof item.str === "string" && item.str.trim())
          .map((item) => ({
            s: item.str,
            x: item.transform[4],
            y: item.transform[5],
            size: item.transform[0] || item.height || 0,
            width: item.width || 0,
            font: item.fontName
          }))
      });
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }

  const result = pdfPagesToLines(pages, options);
  const { tex } = linesToTex(result, options);
  return {
    tex,
    lines: result.lines,
    warnings: result.warnings,
    stats: {
      pages: pages.length,
      lines: result.lines.length,
      sections: result.lines.filter((line) => line.isHeading).length,
      bullets: result.lines.filter((line) => line.isBullet).length
    }
  };
}