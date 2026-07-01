export type PdfTextExtractionResult = {
  text: string;
  pageCount?: number;
  parserVersion: string;
};

export async function extractPdfResumeText(buffer: Buffer): Promise<PdfTextExtractionResult> {
  // Exception: Plan requires dynamic import for pdf-parse to align with the server start load strategy.
  const { PDFParse } = await import('pdf-parse') as unknown as {
    PDFParse: new (options: { data: Buffer }) => {
      getText(): Promise<{ text?: string; total?: number; pages?: unknown[] }>;
      destroy(): Promise<void>;
    };
  };
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(line => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(line))
      .join('\n')
      .trim();
    if (text.length < 20) throw new Error('PDF_TEXT_EMPTY');
    return {
      text,
      pageCount: Array.isArray(result.pages) ? result.pages.length : undefined,
      parserVersion: 'pdf-parse@2'
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
