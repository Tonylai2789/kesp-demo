import { useState, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/utils';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// CSS for text layer highlighting
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

interface PdfViewerProps {
  pdfUrl: string;
  className?: string;
}

/** Renders the PdfViewer component. */
export function PdfViewer({ pdfUrl, className }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /** Handles the onDocumentLoadSuccess interaction. */
  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setError(null);
  }

  /** Handles the onDocumentLoadError interaction. */
  function onDocumentLoadError(err: Error) {
    console.error('PDF load error:', err);
    setError('Error al cargar el PDF. Por favor intente de nuevo.');
  }

  const goToPrevPage = /** Documents the goToPrevPage behavior. */ () => setPageNumber(/** Handles the callback for this operation. */(prev) => Math.max(prev - 1, 1));
  const goToNextPage = /** Documents the goToNextPage behavior. */ () => setPageNumber(/** Handles the callback for this operation. */(prev) => Math.min(prev + 1, numPages));
  const zoomIn = /** Documents the zoomIn behavior. */ () => setScale(/** Handles the callback for this operation. */(prev) => Math.min(prev + 0.25, 2.5));
  const zoomOut = /** Documents the zoomOut behavior. */ () => setScale(/** Handles the callback for this operation. */(prev) => Math.max(prev - 0.25, 0.5));

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 bg-muted border-b">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={goToPrevPage}
            disabled={pageNumber <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">
            {pageNumber} / {numPages || '...'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={goToNextPage}
            disabled={pageNumber >= numPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={zoomOut}>
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm w-14 text-center">{Math.round(scale * 100)}%</span>
          <Button variant="outline" size="sm" onClick={zoomIn}>
            <ZoomIn className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* PDF Container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-muted p-4"
      >
        {error ? (
          <div className="flex items-center justify-center h-full text-red-600">
            {error}
          </div>
        ) : (
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
              </div>
            }
          >
            <Page
              pageNumber={pageNumber}
              scale={scale}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className="shadow-lg mx-auto"
            />
          </Document>
        )}
      </div>
    </div>
  );
}

export default PdfViewer;
