/**
 * Punjab Textbook Library helpers.
 * Official PCTB/PECTAA digital books are NOT scraped. Only school-authorized
 * uploads or verified catalog metadata are stored. Full-text copyrighted
 * content is never redistributed.
 */
import { TextbookLanguage, TextbookProcessingStatus, TextbookSource } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type ChapterDraft = {
  chapterNumber: number;
  title: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  topics?: string[];
  keyConcepts?: string[];
};

/** Very light heuristic chapter detection from plain text (English/Urdu headings). */
export function detectChaptersFromText(text: string, maxChapters = 40): ChapterDraft[] {
  if (!text || text.trim().length < 40) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const chapters: ChapterDraft[] = [];
  const chapterRe = /^(?:chapter|باب|unit|یونٹ)\s*[:.\-]?\s*(\d{1,2})\s*[:.\-]?\s*(.*)$/i;
  const numberedRe = /^(\d{1,2})\s*[\.\)]\s+([A-Za-z\u0600-\u06FF].{3,80})$/;

  for (const line of lines) {
    if (chapters.length >= maxChapters) break;
    let m = line.match(chapterRe);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > 0 && num < 50 && !chapters.some((c) => c.chapterNumber === num)) {
        chapters.push({ chapterNumber: num, title: (m[2] || `Chapter ${num}`).slice(0, 280) });
      }
      continue;
    }
    m = line.match(numberedRe);
    if (m && chapters.length < 5) {
      // only accept early numbered headings if few chapters found yet
      const num = parseInt(m[1], 10);
      if (num > 0 && num <= 20 && !chapters.some((c) => c.chapterNumber === num)) {
        chapters.push({ chapterNumber: num, title: m[2].slice(0, 280) });
      }
    }
  }
  return chapters;
}

/**
 * Attempt basic text extraction from a PDF buffer.
 * Returns null if the buffer is not a recognizable text PDF or extraction fails.
 * Scanned/image-only PDFs require OCR which is not bundled; status is reported honestly.
 */
export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<{ text: string; pageCountHint?: number } | null> {
  // Minimal PDF text stream extraction without external native deps.
  // Looks for text between BT/ET and ( ... ) Tj operators — sufficient for many text PDFs.
  try {
    const raw = buffer.toString('latin1');
    if (!raw.startsWith('%PDF')) return null;
    const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g);
    const pageCountHint = pageMatches ? pageMatches.length : undefined;
    const chunks: string[] = [];
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
    let match: RegExpExecArray | null;
    while ((match = streamRe.exec(raw)) !== null) {
      const body = match[1];
      // Extract literal strings that look like readable text
      const stringRe = /\((?:\\.|[^\\)]){3,200}\)/g;
      let s: RegExpExecArray | null;
      while ((s = stringRe.exec(body)) !== null) {
        const cleaned = s[0]
          .slice(1, -1)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '')
          .replace(/\\t/g, ' ')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\');
        if (/[A-Za-z\u0600-\u06FF]{3,}/.test(cleaned)) {
          chunks.push(cleaned);
        }
      }
    }
    const text = chunks.join('\n').replace(/\s+\n/g, '\n').trim();
    if (text.length < 80) return null; // likely scanned or encrypted
    return { text: text.slice(0, 500_000), pageCountHint };
  } catch {
    return null;
  }
}

export async function markTextbookReady(
  textbookId: string,
  schoolId: string,
  chapters: ChapterDraft[],
  notes: string,
  pageCount?: number,
) {
  return prisma.$transaction(async (tx) => {
    await tx.textbookChapter.deleteMany({ where: { textbookId, schoolId } });
    if (chapters.length) {
      await tx.textbookChapter.createMany({
        data: chapters.map((c) => ({
          schoolId,
          textbookId,
          chapterNumber: c.chapterNumber,
          title: c.title,
          pageStart: c.pageStart ?? null,
          pageEnd: c.pageEnd ?? null,
          topics: c.topics ?? undefined,
          keyConcepts: c.keyConcepts ?? undefined,
        })),
      });
    }
    return tx.textbook.update({
      where: { id: textbookId },
      data: {
        processingStatus: TextbookProcessingStatus.READY,
        processingError: null,
        extractionNotes: notes,
        pageCount: pageCount ?? undefined,
      },
      include: { chapters: { orderBy: { chapterNumber: 'asc' } } },
    });
  });
}

export async function markTextbookFailed(textbookId: string, error: string) {
  return prisma.textbook.update({
    where: { id: textbookId },
    data: {
      processingStatus: TextbookProcessingStatus.FAILED,
      processingError: error.slice(0, 4000),
    },
  });
}

export { TextbookLanguage, TextbookProcessingStatus, TextbookSource };
