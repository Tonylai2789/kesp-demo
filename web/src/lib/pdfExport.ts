import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

export type PdfExportOrientation = 'portrait' | 'landscape';

export interface PdfExportElement {
  element: HTMLElement;
}

export interface PdfExportOptions {
  filename: string;
  elements: PdfExportElement[];
  orientation?: PdfExportOrientation;
  marginMm?: number;
  backgroundColor?: string;
  scale?: number;
}

const DEFAULT_MARGIN_MM = 10;
const DEFAULT_BACKGROUND = '#ffffff';
const MAX_CANVAS_SCALE = 2;

/** Sanitizes a display label into a safe PDF filename. */
export function sanitizePdfFileName(value: string): string {
  const sanitized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .toLowerCase();
  return sanitized || 'kesp-export';
}

/** Returns the scale used for DOM capture without creating oversized canvases. */
function resolveCanvasScale(scale: number | undefined): number {
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return scale;
  return Math.max(1, Math.min(MAX_CANVAS_SCALE, window.devicePixelRatio || 1));
}

/** Tells html2canvas which export controls should be skipped. */
function shouldIgnorePdfElement(node: Element): boolean {
  return node instanceof HTMLElement && node.dataset.pdfExclude === 'true';
}

/** Removes export-only controls from the cloned DOM before rasterizing. */
function preparePdfClone(documentClone: Document): void {
  documentClone.querySelectorAll('[data-pdf-exclude="true"]').forEach(
    /** Handles the callback for this operation. */
    (node) => node.remove()
  );

  const style = documentClone.createElement('style');
  style.textContent = `
    * {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
    }
    [data-pdf-export-root="true"] {
      box-shadow: none !important;
    }
  `;
  documentClone.head.appendChild(style);
}

/** Renders one visible DOM element into a canvas for PDF insertion. */
async function renderElementCanvas(
  element: HTMLElement,
  options: Pick<PdfExportOptions, 'backgroundColor' | 'scale'>
): Promise<HTMLCanvasElement> {
  const scale = resolveCanvasScale(options.scale);

  /** Uses html2canvas to rasterize the currently rendered browser DOM into a client-side canvas. */
  return html2canvas(element, {
    backgroundColor: options.backgroundColor ?? DEFAULT_BACKGROUND,
    scale,
    useCORS: true,
    allowTaint: true,
    scrollX: 0,
    scrollY: -window.scrollY,
    windowWidth: Math.max(document.documentElement.clientWidth, element.scrollWidth),
    windowHeight: Math.max(document.documentElement.clientHeight, element.scrollHeight),
    ignoreElements: shouldIgnorePdfElement,
    onclone: preparePdfClone,
  });
}

/** Creates a temporary canvas containing one vertical slice of a larger canvas. */
function createCanvasSlice(source: HTMLCanvasElement, y: number, height: number): HTMLCanvasElement {
  const slice = document.createElement('canvas');
  slice.width = source.width;
  slice.height = height;
  const context = slice.getContext('2d');
  if (!context) throw new Error('Canvas is not available for PDF export.');
  context.fillStyle = DEFAULT_BACKGROUND;
  context.fillRect(0, 0, slice.width, slice.height);
  context.drawImage(source, 0, y, source.width, height, 0, 0, source.width, height);
  return slice;
}

/** Adds a canvas image to the PDF, splitting it across pages when it is taller than one page. */
function addCanvasToPdf(
  pdf: jsPDF,
  canvas: HTMLCanvasElement,
  options: {
    marginMm: number;
    isFirstElement: boolean;
  }
): void {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const usableWidth = pageWidth - options.marginMm * 2;
  const usableHeight = pageHeight - options.marginMm * 2;
  const pixelsPerMm = canvas.width / usableWidth;
  const maxSliceHeight = Math.floor(usableHeight * pixelsPerMm);

  let offsetY = 0;
  let isFirstSlice = true;

  while (offsetY < canvas.height) {
    if (!options.isFirstElement || !isFirstSlice) {
      pdf.addPage();
    }

    const sliceHeight = Math.min(maxSliceHeight, canvas.height - offsetY);
    const slice = createCanvasSlice(canvas, offsetY, sliceHeight);
    const sliceHeightMm = slice.height / pixelsPerMm;
    const imageData = slice.toDataURL('image/png');

    /** Uses jsPDF to place the captured canvas image into the client-side PDF document. */
    pdf.addImage(imageData, 'PNG', options.marginMm, options.marginMm, usableWidth, sliceHeightMm);
    offsetY += sliceHeight;
    isFirstSlice = false;
  }
}

/** Downloads one or more visible DOM elements as a single PDF document. */
export async function downloadElementsAsPdf(options: PdfExportOptions): Promise<void> {
  if (options.elements.length === 0) throw new Error('No elements were provided for PDF export.');

  /** Creates the client-side PDF document that receives rendered DOM captures. */
  const pdf = new jsPDF({
    orientation: options.orientation ?? 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  for (const [index, item] of options.elements.entries()) {
    const canvas = await renderElementCanvas(item.element, options);
    addCanvasToPdf(pdf, canvas, {
      marginMm: options.marginMm ?? DEFAULT_MARGIN_MM,
      isFirstElement: index === 0,
    });
  }

  const filename = options.filename.toLowerCase().endsWith('.pdf')
    ? options.filename
    : `${options.filename}.pdf`;

  /** Uses jsPDF's browser save API to trigger the local PDF download. */
  pdf.save(filename);
}
