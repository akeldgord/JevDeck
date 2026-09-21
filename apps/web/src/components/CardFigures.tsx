import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import type { GroundingFigure } from '@jevdeck/contracts';

/**
 * The figures the source states beside the passage this card cites.
 *
 * Shown **after** the answer, never before it: a diagram drawn above the question is the answer,
 * and a deck that trains recognition of the picture is not the deck anybody asked for. The server
 * decided which figures belong to this card — the ones on the cited page whose caption or
 * surrounding text touches the citation — so this component renders what it is given and never goes
 * looking for an image of its own.
 *
 * Three honest states, because "there is no picture" and "the picture would not load" are different
 * facts about a card:
 *
 *   - the card cites no figure: nothing is rendered at all, and the panel says nothing, because
 *     there is nothing to report;
 *   - the figure is stored without its bytes: the caption and the page are shown and the image is
 *     not claimed, rather than a frame that never fills;
 *   - the bytes failed to arrive: the failure is stated on the card. A silent gap here would be
 *     read as "this card has no figure", which is the thing this component exists to avoid.
 */
export const CardFigures: React.FC<{ figures: GroundingFigure[] }> = ({ figures }) => {
  if (figures.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
        <ImageIcon className="w-3.5 h-3.5" aria-hidden />
        {figures.length === 1 ? 'Figure from this page' : 'Figures from this page'}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {figures.map(figure => (
          <CardFigure key={figure.id} figure={figure} />
        ))}
      </div>
    </div>
  );
};

const CardFigure: React.FC<{ figure: GroundingFigure }> = ({ figure }) => {
  const [url, setUrl] = useState<string | null>(() => objectUrls.get(figure.id) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A stored image never changes, so the session keeps the object URL and reopening a card does
    // not re-download the same figure.
    if (url || error || !figure.hasBytes) return;

    let cancelled = false;

    void (async () => {
      try {
        const blob = await api.fetchMedia(figure.id);
        const created = URL.createObjectURL(blob);
        objectUrls.set(figure.id, created);
        if (!cancelled) setUrl(created);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'This figure could not be loaded.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [error, figure.hasBytes, figure.id, url]);

  return (
    <figure className="bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden">
      <div className="min-h-24 flex items-center justify-center bg-slate-950 p-2">
        {!figure.hasBytes ? (
          <p className="text-[11px] text-amber-300/90 px-3 py-4 text-center">
            The source holds a figure here, but its bytes were not stored, so it cannot be shown.
          </p>
        ) : url ? (
          <img src={url} alt={figure.caption ?? figure.name} className="max-h-72 max-w-full object-contain" />
        ) : error ? (
          <p className="text-[11px] text-red-300 px-3 text-center">
            {error} The figure exists; it did not load.
          </p>
        ) : (
          <Loader2 className="w-4 h-4 animate-spin text-slate-600" />
        )}
      </div>
      <figcaption className="px-3 py-2 space-y-0.5 border-t border-slate-800/80">
        <div className="text-[10px] font-mono text-slate-500">
          {figure.kind === 'scan' ? 'the page as uploaded' : figure.kind} · page {figure.pageNumber}
        </div>
        {figure.caption && (
          <div className="text-[11px] text-slate-300 leading-snug">{figure.caption}</div>
        )}
      </figcaption>
    </figure>
  );
};

/** Session-scoped object URLs, so reopening a card does not re-download the same figure. */
const objectUrls = new Map<string, string>();
