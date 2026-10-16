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
let fontBytes: Promise<Buffer[]> | undefined;
type FontRun = { font: PDFFont; text: string };

export async function referralPdfText(pdf: PDFDocument) {
  pdf.registerFontkit(fontkit);
  const bytes = await (fontBytes ??= Promise.all(fontNames.map(name => readFile(new URL(name, fontDirectory)))));
  const fonts = await Promise.all(bytes.map(data => pdf.embedFont(data, { subset: true })));
  const supported = fonts.map(font => new Set(font.getCharacterSet()));
  function runs(text: string, bold = false): FontRun[] {
    const order = bold ? [1, 0, 2, 3, 4] : [0, 2, 3, 4];
    const result: FontRun[] = [];
    for (const char of text) {
      const index = order.find(i => supported[i].has(char.codePointAt(0)!));
      const font = fonts[index ?? (bold ? 1 : 0)];
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
  return { runs, width, wrap, regular: fonts[0] };
}
