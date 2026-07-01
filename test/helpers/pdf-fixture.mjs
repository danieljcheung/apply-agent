import { Buffer } from 'node:buffer';

/**
 * Generates a valid one-page PDF with a text layer and correct xref offsets.
 * 
 * @param {string} text The text to insert in the PDF text layer.
 * @returns {Buffer} The generated PDF as a Buffer.
 */
export function makeTextPdf(text) {
  const lines = String(text).split(/\r?\n/);
  const escapedLines = lines.map((line) => line
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)'));
  const textOps = escapedLines.map((line) => `(${line}) Tj T*`).join('\n');
  const streamContent = `BT /F1 12 Tf 14 TL 72 712 Td\n${textOps}\nET`;
  
  const header = '%PDF-1.4\n';
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n';
  const obj4 = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  
  const streamLength = Buffer.byteLength(streamContent, 'utf8');
  const obj5Header = `5 0 obj\n<< /Length ${streamLength} >>\nstream\n`;
  const obj5Footer = '\nendstream\nendobj\n';
  const obj5Total = obj5Header + streamContent + obj5Footer;
  
  const offsets = [];
  let currentOffset = Buffer.byteLength(header, 'utf8');
  
  offsets.push(currentOffset);
  currentOffset += Buffer.byteLength(obj1, 'utf8');
  
  offsets.push(currentOffset);
  currentOffset += Buffer.byteLength(obj2, 'utf8');
  
  offsets.push(currentOffset);
  currentOffset += Buffer.byteLength(obj3, 'utf8');
  
  offsets.push(currentOffset);
  currentOffset += Buffer.byteLength(obj4, 'utf8');
  
  offsets.push(currentOffset);
  currentOffset += Buffer.byteLength(obj5Total, 'utf8');
  
  const startxref = currentOffset;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets) {
    const padOffset = String(offset).padStart(10, '0');
    xref += `${padOffset} 00000 n \n`;
  }
  
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  
  const finalPdfStr = header + obj1 + obj2 + obj3 + obj4 + obj5Total + xref + trailer;
  return Buffer.from(finalPdfStr, 'utf8');
}
