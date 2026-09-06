/**
 * pdfExtractionService.js
 * Universal, high-reliability PDF text extractor compatible with pdf-parse v1, v2, and raw streams.
 * Handles both v2.x (class PDFParse) and v1.x (function) gracefully.
 * 
 * @module pdfExtractionService
 */

/**
 * Extracts plain text from a PDF Buffer.
 * 
 * @param {Buffer} fileBuffer - PDF binary buffer
 * @returns {Promise<string>} Extracted text string
 */
async function extractPdfText(fileBuffer) {
  if (!fileBuffer || fileBuffer.length === 0) return "";

  try {
    const pdfModule = require("pdf-parse");

    // 1. pdf-parse v2 (Class PDFParse)
    if (pdfModule.PDFParse) {
      const parser = new pdfModule.PDFParse({ data: fileBuffer });
      const result = await parser.getText();
      if (result && result.text && result.text.trim()) {
        return result.text.trim();
      }
    }

    // 2. pdf-parse v1 (Function)
    if (typeof pdfModule === "function") {
      const result = await pdfModule(fileBuffer);
      if (result && result.text && result.text.trim()) {
        return result.text.trim();
      }
    }

    if (pdfModule.default && typeof pdfModule.default === "function") {
      const result = await pdfModule.default(fileBuffer);
      if (result && result.text && result.text.trim()) {
        return result.text.trim();
      }
    }
  } catch (err) {
    console.warn("⚠️ [PDF EXTRACTION] Standard parser error:", err.message);
  }

  // 3. Fallback extraction for simple uncompressed PDF text streams
  try {
    const raw = fileBuffer.toString("binary");
    const textChunks = [];
    const textBlockRegex = /\(([^)]+)\)\s*Tj/g;
    let match;
    while ((match = textBlockRegex.exec(raw)) !== null) {
      textChunks.push(match[1]);
    }
    if (textChunks.length > 0) {
      return textChunks.join(" ").trim();
    }
  } catch (fallbackErr) {
    console.warn("⚠️ [PDF FALLBACK] Stream extraction error:", fallbackErr.message);
  }

  return "";
}

module.exports = {
  extractPdfText
};
