/** Loads a PDF with pdf.js and hands back the positioned text runs of each page. */

let pdfjs = null;

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
  }
  return pdfjs;
}

/**
 * @param {ArrayBuffer} buffer Raw PDF bytes.
 * @returns {Promise<Array<Array<{str: string, x: number, y: number, width: number, height: number}>>>}
 *          One array of text runs per page, in page order.
 */
export async function readPdfPages(buffer) {
  const api = await loadPdfjs();
  const doc = await api.getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter((item) => typeof item.str === "string" && item.str.trim() !== "")
          .map((item) => ({
            str: item.str,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            height: item.height,
          })),
      );
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}
