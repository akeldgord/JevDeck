import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { DocumentPage, Flashcard } from '@jevdeck/contracts';
import { locateExcerptRects, type HighlightRect } from '../lib/excerptGeometry';
import {
  X,
  BookOpen,
  CheckCircle2,
  Bookmark,
  Loader2,
  AlertCircle,
} from 'lucide-react';

// Ensure the worker is configured even if the viewer mounts first
if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();
}

interface Props {
  card: Flashcard | null;
  onClose: () => void;
  /** Intact bytes of the uploaded PDF, when a document is loaded. */
  pdfBytes: ArrayBuffer | null;
  /** Extracted page text, used when there is no PDF to rasterise. */
  pages: DocumentPage[];
  documentName: string;
  /**
   * True when this document was really uploaded but its original bytes were not retained.
   *
   * The distinction matters: presenting a genuine upload as a "sample document" is a false
   * statement about where the text came from.
   */
  sourceNotRetained?: boolean;
  isDemo?: boolean;
}



export const DualGroundingViewer: React.FC<Props> = ({
  card,
  onClose,
  pdfBytes,
  pages,
  documentName,
  sourceNotRetained = false,
  isDemo = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<any>(null);
  // One rectangle per line of the cited passage; empty means it could not be located.
  const [highlight, setHighlight] = useState<HighlightRect[]>([]);
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  const pageNumber = card?.grounding.pageNumber ?? null;
  const excerpt = card?.grounding.excerpt ?? '';

  // Drop the cached document when a different file is loaded
  useEffect(() => {
    pdfDocRef.current = null;
  }, [pdfBytes]);

  useEffect(() => {
    if (!card || !pdfBytes || pageNumber === null) {
      setIsRendering(false);
      setHighlight([]);
      setRenderError(null);
      return;
    }

    let cancelled = false;
    setIsRendering(true);
    setRenderError(null);
    setHighlight([]);

    (async () => {
      try {
        if (!pdfDocRef.current) {
          // pdf.js detaches the buffer it receives, so render from a copy
          pdfDocRef.current = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
        }
        const doc = pdfDocRef.current;
        const page = await doc.getPage(Math.min(Math.max(pageNumber, 1), doc.numPages));
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 720 / baseViewport.width);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        await page.render({ canvas, viewport }).promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        setHighlight(locateExcerptRects(textContent.items ?? [], excerpt, viewport));
      } catch (err: any) {
        if (!cancelled) {
          setRenderError(err?.message || 'Could not render the original page.');
        }
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [card, pdfBytes, pageNumber, excerpt]);

  if (!card) return null;

  const extractedPage = pages.find(p => p.pageNumber === card.grounding.pageNumber);
  const usesPdf = Boolean(pdfBytes);

  return (
    // `animate-in fade-in` were inert: they belong to `tailwindcss-animate`, which is not
    // installed. The animation is now defined in the Tailwind theme and applied only when the
    // person has not asked for reduced motion.
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-6 motion-safe:animate-jevdeck-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-6xl h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Top Bar */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-100 text-sm sm:text-base">
                  Dual Grounding Inspection
                </h3>
                {/*
                  * The recorded checks, not a score. An earlier version showed "100% Grounding
                  * Score" on every card: locating an excerpt and verifying a claim are separate
                  * checks, and neither one produces a percentage.
                  */}
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-slate-400 font-mono">
                  {card.grounding.validationCodes && card.grounding.validationCodes.length > 0
                    ? `Checked: ${card.grounding.validationCodes.join(', ')}`
                    : 'Checked: excerpt located in the stored page'}
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate max-w-[240px] sm:max-w-md">
                {card.grounding.sectionTitle} • Page {card.grounding.pageNumber}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dual Panels: Left = Excerpt & Card context, Right = Original page */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left Panel: Verified Excerpt & Card Synthesis */}
          <div className="lg:col-span-5 p-6 border-r border-slate-800/80 overflow-y-auto space-y-6 bg-slate-950/30">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Extracted Source Excerpt
              </span>
              <div className="mt-2 p-4 rounded-2xl bg-slate-900 border border-slate-800 text-slate-200 text-sm leading-relaxed relative">
                <div className="absolute top-3 right-3 text-slate-600">
                  <Bookmark className="w-4 h-4 text-emerald-400/60" />
                </div>
                "{card.grounding.excerpt}"
              </div>
            </div>

            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Synthesized Flashcard
              </span>
              <div className="mt-2 p-4 rounded-2xl bg-emerald-950/20 border border-emerald-500/30 space-y-3">
                <div className="text-xs font-bold uppercase text-emerald-400">
                  {card.format === 'qa' ? 'Question & Answer' : 'Cloze Deletion'}
                </div>
                {card.format === 'qa' ? (
                  <>
                    <div className="text-sm font-semibold text-slate-100">{card.question}</div>
                    <div className="text-sm text-emerald-200 border-t border-emerald-900/60 pt-2">
                      {card.answer}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-slate-200">{card.clozeText}</div>
                )}
              </div>
            </div>

            {card.explanation && (
              <div className="text-xs text-slate-400 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800">
                <span className="font-semibold text-slate-300">Contextual Nuance: </span>
                {card.explanation}
              </div>
            )}
          </div>

          {/* Right Panel: Original source page */}
          <div className="lg:col-span-7 bg-slate-950 flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 bg-slate-900/50">
              <span className="font-mono truncate max-w-[55%]">
                {/* What this panel is actually showing, said plainly. */}
                {usesPdf
                  ? `Original PDF: ${documentName} — Page ${card.grounding.pageNumber}`
                  : isDemo
                    ? `Sample document — Page ${card.grounding.pageNumber}`
                    : `Extracted text of ${documentName} — Page ${card.grounding.pageNumber}`}
              </span>
              <div className="flex items-center gap-3">
                {usesPdf && <span className="text-[11px] bg-slate-800 px-2 py-0.5 rounded text-slate-300">Fit width</span>}
                {usesPdf && highlight.length > 0 && (
                  <span className="text-emerald-400 flex items-center gap-1 font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Excerpt located on page
                    {highlight.length > 1 && (
                      <span className="text-emerald-400/70 font-normal">
                        ({highlight.length} lines)
                      </span>
                    )}
                  </span>
                )}
                {/* R4: when the excerpt cannot be located, say so instead of drawing nothing. */}
                {usesPdf && highlight.length === 0 && !isRendering && !renderError && (
                  <span
                    className="text-amber-400/90 font-mono text-[11px]"
                    title="The cited text was not found in this page's text layer, so no rectangle is drawn."
                  >
                    Exact highlight unavailable
                  </span>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto p-6 sm:p-8 flex justify-center bg-slate-950">
              {usesPdf ? (
                <div className="relative self-start">
                  <canvas
                    ref={canvasRef}
                    className="rounded-xl border border-slate-800 shadow-2xl bg-white max-w-full h-auto"
                  />
                  {highlight.map((rect, index) => (
                    <div
                      key={`${rect.left}-${rect.top}-${index}`}
                      className="absolute rounded-md bg-emerald-400/30 ring-2 ring-emerald-400/70 pointer-events-none"
                      style={{
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height,
                      }}
                      title="Cited excerpt"
                    />
                  ))}
                  {isRendering && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-300 gap-2 bg-slate-950/60 rounded-xl text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" /> Rendering original page...
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-slate-900 text-slate-300 border border-slate-800 rounded-xl shadow-2xl p-8 sm:p-12 max-w-2xl w-full text-xs sm:text-sm font-serif leading-relaxed">
                  <div className="border-b border-slate-800 pb-3 mb-6 flex justify-between text-[11px] font-mono text-slate-500 uppercase tracking-widest">
                    <span className="truncate max-w-[70%]">{documentName}</span>
                    <span>Page {card.grounding.pageNumber}</span>
                  </div>

                  {sourceNotRetained && (
                    <p className="mb-4 text-[11px] text-amber-300/90 not-italic font-sans">
                      The original file was not retained for this document (it exceeded the
                      retention limit), so this is the extracted text rather than the page image.
                    </p>
                  )}

                  {extractedPage && extractedPage.text.length > 0 ? (
                    <p className="whitespace-pre-wrap">
                      {highlightExcerpt(extractedPage.text, card.grounding.excerpt)}
                    </p>
                  ) : (
                    <p className="text-slate-500 italic">
                      No extracted text is available for this page.
                    </p>
                  )}

                  <div className="mt-12 pt-4 border-t border-slate-800 text-[10px] font-mono text-slate-600 text-center">
                    --- End of Page {card.grounding.pageNumber} ---
                  </div>
                </div>
              )}
            </div>

            {renderError && (
              <div className="px-4 py-3 border-t border-red-900/50 bg-red-950/30 text-xs text-red-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{renderError}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Wraps the cited excerpt inside the extracted page text. */
function highlightExcerpt(pageText: string, excerpt: string): React.ReactNode {
  const index = pageText.indexOf(excerpt);
  if (index === -1) return pageText;

  return (
    <>
      {pageText.slice(0, index)}
      <mark className="bg-emerald-500/25 text-emerald-100 rounded px-0.5 ring-1 ring-emerald-500/40">
        {excerpt}
      </mark>
      {pageText.slice(index + excerpt.length)}
    </>
  );
}

/*
 * The measurement itself lives in `lib/excerptGeometry.ts`, so it can be exercised without a
 * browser: it returns one rectangle per line of the passage, transformed through whatever
 * viewport is in use, and is covered by `tests/excerptGeometry.test.ts`.
 */
