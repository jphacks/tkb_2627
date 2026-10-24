import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import type { LineStyle, PrintLine } from './print-model.ts';

/**
 * E02: renders the fixed print layout (print-model.ts) to PDF in-process with pdf-lib. No browser, no HTML and no
 * URL is ever loaded: the only inputs are the lines and the bundled Noto Sans JP (OFL-1.1, @reogrid/font-jp,
 * EUC-JP repertoire), which is embedded as a subset. A character the font cannot draw becomes '?'.
 */

const require = createRequire(import.meta.url);
interface Fonts {
  regular: Uint8Array;
  bold: Uint8Array;
  covers: (cp: number) => boolean;
}
let cached: Fonts | null = null;
function fonts(): Fonts {
  if (!cached) {
    const regular = readFileSync(require.resolve('@reogrid/font-jp/NotoSansJP-Regular.ttf'));
    const bold = readFileSync(require.resolve('@reogrid/font-jp/NotoSansJP-Bold.ttf'));
    const face = fontkit.create(regular) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
    cached = { regular, bold, covers: (cp) => face.hasGlyphForCodePoint(cp) };
  }
  return cached;
}

const PAGE: [number, number] = [595.28, 841.89]; // A4
const MARGIN = 48;
const FOOTER = 28;
export const MAX_PAGES = 80;

const STYLE: Record<LineStyle, { size: number; bold: boolean; indent: number; gap: number; gray: number }> = {
  title: { size: 20, bold: true, indent: 0, gap: 0, gray: 0 },
  heading: { size: 13, bold: true, indent: 0, gap: 12, gray: 0.1 },
  item: { size: 10.5, bold: true, indent: 0, gap: 6, gray: 0 },
  detail: { size: 9, bold: false, indent: 14, gap: 1, gray: 0.25 },
  note: { size: 9, bold: false, indent: 0, gap: 4, gray: 0.4 },
};

/** Drops control characters and replaces what the font cannot draw. */
export function sanitize(text: string, covers: (cp: number) => boolean = fonts().covers): string {
  let out = '';
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    out += cp === 0x20 || covers(cp) ? ch : '?';
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of text) {
    const cw = font.widthOfTextAtSize(ch, size);
    if (w + cw > width && line !== '') {
      out.push(line);
      line = '';
      w = 0;
      if (ch === ' ') continue;
    }
    line += ch;
    w += cw;
  }
  out.push(line);
  return out;
}

export interface RenderOptions {
  footer: string;
}

export async function renderPdf(lines: PrintLine[], opts: RenderOptions): Promise<Uint8Array> {
  const f = fonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(sanitize(lines[0]?.text ?? 'trip', f.covers));
  doc.setProducer('tkb_2627');
  doc.setCreator('tkb_2627');
  const regular = await doc.embedFont(f.regular, { subset: true });
  const bold = await doc.embedFont(f.bold, { subset: true });

  const width = PAGE[0] - MARGIN * 2;
  let page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  let truncated = false;
  const newPage = () => {
    if (doc.getPageCount() >= MAX_PAGES) return false;
    page = doc.addPage(PAGE);
    y = PAGE[1] - MARGIN;
    return true;
  };
  outer: for (const line of lines) {
    const s = STYLE[line.style];
    const font = s.bold ? bold : regular;
    const leading = s.size * 1.45;
    y -= s.gap;
    for (const part of wrap(sanitize(line.text, f.covers), font, s.size, width - s.indent)) {
      if (y - leading < MARGIN + FOOTER) {
        if (!newPage()) {
          truncated = true;
          break outer;
        }
      }
      y -= leading;
      page.drawText(part, { x: MARGIN + s.indent, y, size: s.size, font, color: rgb(s.gray, s.gray, s.gray) });
    }
  }
  if (truncated) {
    page.drawText(sanitize('（ページ数の上限に達したため、以降は省略しました）', f.covers), {
      x: MARGIN,
      y: MARGIN + FOOTER - 4,
      size: 9,
      font: bold,
    });
  }
  const pages = doc.getPages();
  const footer = sanitize(opts.footer, f.covers);
  pages.forEach((p, i) => {
    p.drawText(`${footer}  ${i + 1} / ${pages.length}`, { x: MARGIN, y: MARGIN - 8, size: 8, font: regular, color: rgb(0.45, 0.45, 0.45) });
  });
  return doc.save();
}
