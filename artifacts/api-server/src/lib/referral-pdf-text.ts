// fontkit's Indic shaping state machine expects this runtime on Node.
import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { PDFDocument, type PDFFont } from "pdf-lib";

const fontNames = [
  "NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "NotoSansArabic-Regular.ttf",
  "NotoSansGurmukhi-Regular.ttf", "NotoSansSC-Regular.ttf",
];
// esbuild bundles this module into dist/index.mjs; build.mjs copies fonts
// beside that file. Source execution (tests) uses the source-relative assets.
const fontDirectory = new URL(
  import.meta.url.endsWith(".ts") ? "../../assets/fonts/" : "./assets/fonts/",
  import.meta.url,
);
type FontData = { bytes: Buffer; supported: Set<number> };
const fontBytes = new Map<number, Promise<FontData>>();
function loadFont(index: number): Promise<FontData> {
  let pending = fontBytes.get(index);
  if (!pending) {
    pending = readFile(new URL(fontNames[index], fontDirectory)).then(bytes => ({
      bytes, supported: new Set(fontkit.create(bytes).characterSet),
    })).catch(error => {
      // A transient read/parse failure must not poison all later downloads.
      fontBytes.delete(index);
      throw error;
    });
    fontBytes.set(index, pending);
  }
  return pending;
}
type FontRun = { font: PDFFont; text: string };

/** Supply all document strings before drawing so fallback fonts are embedded only when needed. */
export async function referralPdfText(pdf: PDFDocument, strings: readonly string[]) {
  pdf.registerFontkit(fontkit);
  const data = new Map<number, FontData>(await Promise.all(
    [0, 1].map(async index => [index, await loadFont(index)] as const),
  ));
  const needed = new Set([0, 1]);
  const seen = new Set<number>();
  // One text pass. Latin documents never read or parse a fallback font; font
  // coverage is cached across downloads, independently of per-PDF embedding.
  for (const text of strings) {
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (seen.has(code)) continue;
      seen.add(code);
      if (data.get(0)!.supported.has(code)) continue;
      for (const index of [2, 3, 4]) {
        if (!data.has(index)) data.set(index, await loadFont(index));
        if (data.get(index)!.supported.has(code)) {
          needed.add(index);
          break;
        }
      }
    }
  }
  const fonts = new Map(await Promise.all([...needed].map(async index =>
    [index, await pdf.embedFont(data.get(index)!.bytes, { subset: true })] as const,
  )));
  function runs(text: string, bold = false): FontRun[] {
    const order = bold ? [1, 0, 2, 3, 4] : [0, 2, 3, 4];
    const result: FontRun[] = [];
    for (const char of text) {
      const index = order.find(i => fonts.has(i) && data.get(i)!.supported.has(char.codePointAt(0)!));
      const font = fonts.get(index ?? (bold ? 1 : 0))!;
      const rendered = index === undefined ? "?" : char;
      const last = result.at(-1);
      if (last?.font === font) last.text += rendered;
      else result.push({ font, text: rendered });
    }
    return result;
  }
  const width = (text: string, size: number, bold = false) =>
    runs(text, bold).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
  const wrap = (text: string, size: number, bold = false, maxWidth = 516): string[] => {
    const lines: string[] = [];
    for (const paragraph of text.replace(/\r/g, "").split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (width(candidate, size, bold) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) { lines.push(line); line = ""; }
        // Only a word too wide on its own can be split within the word.
        for (const char of word) {
          if (line && width(line + char, size, bold) > maxWidth) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
      }
      lines.push(line);
    }
    return lines;
  };
  return { runs, width, wrap, regular: fonts.get(0)! };
}
