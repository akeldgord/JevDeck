import React, { useEffect, useState } from 'react';
import { AlertTriangle, FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { api, type StoredMediaItem } from '../lib/api';
import type { ReadReport } from '../lib/readReport';

/**
 * What was read from the open document, and what was not.
 *
 * A page that yielded no text is one of two different things — a blank divider, which is a result,
 * or a page whose content is a picture, which is a gap — and this panel keeps them apart instead of
 * reporting one number called "empty". Within that gap it keeps a second distinction: a page whose
 * picture was stored can still be read, and one with nothing stored cannot. Text read *off* a
 * picture is named separately again, with who read it, because a card resting on a model's
 * transcription is a different claim from a card resting on the document's own text. The
 * limitations below the counts are the reader's own words, stored with the document, so a reader
 * reopened after a restart says exactly what it said when it was first read.
 *
 * The images are listed with their page and served one at a time, to the account that owns the
 * document. Nothing here is a placeholder for media that does not exist.
 */
export const ReadReportPanel: React.FC<{ report: ReadReport }> = ({ report }) => {
  const [showMedia, setShowMedia] = useState(false);
  const unanchored = report.media.filter(item => !item.pageAnchored).length;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <FileText className="w-4 h-4 text-cyan-400" />
          What was read
        </h2>
        <span className="text-[11px] font-mono text-slate-500">
          {report.formatLabel} ·{' '}
          {report.pagination === 'virtual'
            ? 'page numbers are this import’s'
            : report.pagination === 'mixed'
              ? 'mixed pagination'
              : report.pagination === 'explicit'
                ? 'the document’s own page numbers'
                : 'pagination not recorded'}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Pages" value={report.pageCount} />
        <Stat label="Readable" value={report.textPages} tone="good" />
        <Stat label="Blank" value={report.blankPages} />
        <Stat
          label="Unread content"
          value={report.unextractedPages}
          tone={report.unextractedPages > 0 ? 'warn' : undefined}
        />
        <Stat label="Sections" value={report.sectionCount} />
        <Stat label="Words" value={report.totalWords} />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5 text-slate-500" />
          {report.mediaCount === 0
            ? 'No images stored with this document'
            : `${report.mediaCount} image${report.mediaCount === 1 ? '' : 's'} stored`}
        </span>
        {report.captionedFigures > 0 && (
          <span className="text-slate-500">
            {report.captionedFigures} of them with the document’s own caption
          </span>
        )}
        {report.mediaCount > 0 && (
          <button
            onClick={() => setShowMedia(previous => !previous)}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition-colors"
          >
            {showMedia ? 'Hide images' : 'Show images'}
          </button>
        )}
        <span>
          {report.rendersPages
            ? 'The original file is kept, so pages can be re-rendered.'
            : 'There is no page image for this format; the stored text is the record.'}
        </span>
      </div>

      {report.ocrPages > 0 && (
        <p className="text-[11px] text-slate-400 leading-relaxed">
          {report.ocrPages} page{report.ocrPages === 1 ? '' : 's'} carry no text of their own and{' '}
          {report.ocrPages === 1 ? 'was' : 'were'} read off a picture instead
          {report.ocrReaders.length > 0 ? ` by ${report.ocrReaders.join(', ')}` : ''}. That text is a
          transcription of an image rather than text the document wrote, and the pages holding it
          record which one it is.
        </p>
      )}

      {showMedia && report.media.length > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {report.media.map(item => (
              <StoredImage key={item.id} item={item} />
            ))}
          </div>
          {unanchored > 0 && (
            <p className="text-[11px] text-amber-300/90">
              {unanchored} of these are not anchored to a page: the format stored the image without
              recording where it sits, so no page number is claimed for it.
            </p>
          )}
        </div>
      )}

      {report.limitations.length > 0 && (
        <div className="space-y-1.5 border-t border-slate-800 pt-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-300/90 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            What this read does not cover
          </p>
          <ul className="space-y-1 list-disc list-inside">
            {report.limitations.map(limitation => (
              <li key={limitation} className="text-[11px] text-slate-400 leading-relaxed">
                {limitation}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.unextractedPages > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-amber-200/90 leading-relaxed">
            {report.unextractedPages} page{report.unextractedPages === 1 ? '' : 's'} hold content this
            build could not read — a scan, or an image of text. Nothing on them can be turned into
            cards or counted as covered, and they are reported rather than silently skipped.
          </p>
          {report.unreadPictures > 0 && (
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {report.unreadPictures} of them kept a readable picture, so a run can still read{' '}
              {report.unreadPictures === 1 ? 'it' : 'them'} — the gap is closable, not permanent.
            </p>
          )}
          {report.unreadWithoutPicture > 0 && (
            <p className="text-[11px] text-amber-300/80 leading-relaxed">
              {report.unreadWithoutPicture} of them kept no picture at all: this build stored nothing
              that could be read, so re-running it cannot close {report.unreadWithoutPicture === 1 ? 'this gap' : 'these gaps'}.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * One stored image.
 *
 * The bytes are fetched as a blob rather than pointed at with an `<img src>`: the API is on another
 * origin in development, and the session is an HttpOnly cookie that a plain image request would not
 * carry. The URL is cached for the session, since a stored image never changes.
 */
const StoredImage: React.FC<{ item: StoredMediaItem }> = ({ item }) => {
  const [url, setUrl] = useState<string | null>(() => objectUrls.get(item.id) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (url || error) return;

    let cancelled = false;

    void (async () => {
      try {
        const blob = await api.fetchMedia(item.id);
        const created = URL.createObjectURL(blob);
        objectUrls.set(item.id, created);
        if (!cancelled) setUrl(created);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'This image could not be read.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [error, item.id, url]);

  return (
    <figure className="bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden">
      <div className="h-32 flex items-center justify-center bg-slate-950">
        {url ? (
          <img src={url} alt={item.name} className="max-h-32 max-w-full object-contain" />
        ) : error ? (
          <span className="text-[11px] text-red-300 px-3 text-center">{error}</span>
        ) : (
          <Loader2 className="w-4 h-4 animate-spin text-slate-600" />
        )}
      </div>
      <figcaption className="px-3 py-2 space-y-0.5">
        <div className="text-[11px] text-slate-300 truncate" title={item.name}>
          {item.name}
        </div>
        <div className="text-[10px] font-mono text-slate-500">
          {item.kind} · {item.pageAnchored ? `page ${item.pageIndex}` : 'page not recorded'} ·{' '}
          {formatBytes(item.byteSize)}
        </div>
        {item.caption && (
          <div className="text-[10px] text-slate-400 leading-snug line-clamp-2">{item.caption}</div>
        )}
      </figcaption>
    </figure>
  );
};

/** Session-scoped object URLs, so reopening a document does not re-download the same image. */
const objectUrls = new Map<string, string>();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const Stat: React.FC<{ label: string; value: number | string; tone?: 'good' | 'warn' }> = ({
  label,
  value,
  tone,
}) => (
  <div className="bg-slate-950/50 border border-slate-800/80 rounded-xl px-3 py-2">
    <div
      className={`text-sm font-bold ${
        tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : 'text-slate-200'
      }`}
    >
      {value}
    </div>
    <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
  </div>
);
