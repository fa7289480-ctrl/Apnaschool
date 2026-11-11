import { deflateRawSync } from 'node:zlib';

export type PaperQuestion = {
  type: string;
  prompt: string;
  marks: number;
  options?: string[];
  answer?: string;
};

export type ApprovedPaperDocument = {
  schoolName: string;
  title: string;
  subject: string;
  examination: string;
  className: string;
  section: string | null;
  totalMarks: number;
  durationMinutes: number;
  difficulty: string;
  language: string;
  questions: PaperQuestion[];
};

function xml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = (crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: Buffer; data: Buffer; compressed: Buffer; crc: number; offset: number };

function makeZip(files: Array<{ name: string; contents: string }>): Buffer {
  const entries: ZipEntry[] = files.map((file) => {
    const data = Buffer.from(file.contents, 'utf8');
    return { name: Buffer.from(file.name, 'utf8'), data, compressed: deflateRawSync(data), crc: crc32(data), offset: 0 };
  });
  const locals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt32LE(entry.crc, 14); header.writeUInt32LE(entry.compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(entry.name.length, 26);
    entry.offset = offset;
    const local = Buffer.concat([header, entry.name, entry.compressed]); locals.push(local); offset += local.length;
  }
  const centralOffset = offset;
  const central = entries.map((entry) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(8, 10); header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20); header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(entry.name.length, 28); header.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([header, entry.name]);
  });
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

function paragraph(text: string, bold = false, rtl = false): string {
  const paragraphProperties = rtl ? '<w:pPr><w:bidi/></w:pPr>' : '';
  const runProperties = `${bold ? '<w:b/>' : ''}${rtl ? '<w:rtl/>' : ''}`;
  return `<w:p>${paragraphProperties}<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

/** Build a minimal standards-compliant DOCX using only Node's built-in zlib. */
export function createPaperDocx(paper: ApprovedPaperDocument): Buffer {
  const para = (text: string, bold = false) => paragraph(text, bold, paper.language === 'URDU');
  const lines = [
    para(paper.schoolName, true), para(paper.title, true),
    para(`Examination: ${paper.examination}`),
    para(`Class: ${paper.className}${paper.section ? ` — ${paper.section}` : ''}    Subject: ${paper.subject}`),
    para(`Date: ____________________    Duration: ${paper.durationMinutes} minutes    Total marks: ${paper.totalMarks}`),
    para(`Difficulty: ${paper.difficulty}    Language: ${paper.language}`), para(''),
    ...paper.questions.flatMap((question, index) => [
      para(`${index + 1}. ${question.prompt} (${question.marks} marks)`, true),
      ...(question.options ?? []).map((option, optionIndex) => para(`   ${String.fromCharCode(65 + optionIndex)}. ${option}`)),
    ]),
  ];
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', contents: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', contents: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', contents: documentXml },
  ]);
}
