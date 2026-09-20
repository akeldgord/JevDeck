import React, { useRef, useState } from 'react';
import { AlertCircle, FileText, Loader2, UploadCloud } from 'lucide-react';
import { SUPPORTED_FORMATS, UNSUPPORTED_FORMATS } from '@jevdeck/ingestion';
import { parseDocumentFile, parsePastedNotes, type ParsedDocument } from '../lib/documentParser';

/**
 * The one place a document enters the application.
 *
 * It reads every format this build supports — PDF, Word, PowerPoint, Markdown, plain text — and
 * text pasted directly, and then states what it actually read. That last part is the point: the
 * panel below the drop zone shows the pages that yielded text, the pages that are genuinely blank,
 * the pages whose content is a picture this build cannot read, the images it stored, and the reader's
 * own list of what it did not do. A person is deciding whether to generate cards from this, and an
 * upload that says "ready" without saying what it skipped is how the wrong decision gets made.
 */

interface Props {
  onDocumentParsed: (document: ParsedDocument) => void;
  isProcessing: boolean;
}

const FILE_ACCEPT = SUPPORTED_FORMATS.flatMap(format =>
  format.extensions.map(extension => `.${extension}`)
).join(',');

export const SourceUploader: React.FC<Props> = ({ onDocumentParsed, isProcessing }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'file' | 'notes'>('file');
  const [isDragging, setIsDragging] = useState(false);
  const [parsingStatus, setParsingStatus] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [notesTitle, setNotesTitle] = useState('Pasted notes');

  const busy = isProcessing || parsingStatus !== null;

  // Names the formats rather than only listing extensions, so the drop zone states what it reads.
  const accept = SUPPORTED_FORMATS.map(
    format => `${format.label} (${format.extensions.join(', ') || 'pasted'})`
  );

  const runParse = async (read: () => Promise<ParsedDocument>) => {
    setErrorMessage(null);
    setParsingStatus('Reading the document…');
    setProgressPercent(5);

    try {
      const result = await read();
      setParsingStatus(null);
      setProgressPercent(0);
      // The account of what was read is rendered by the screen above, from the same facts, so it
      // stays on screen after the document is stored and survives reopening it later.
      onDocumentParsed(result);
    } catch (error) {
      // The refusal says what the format is and what to do instead, so a rejected upload is a
      // next step rather than a dead end.
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'That document could not be read. Check that it is not corrupted or password protected.'
      );
      setParsingStatus(null);
      setProgressPercent(0);
    }
  };

  const processFile = (file: File) =>
    runParse(() =>
      parseDocumentFile(file, (percent, statusText) => {
        setProgressPercent(percent);
        setParsingStatus(statusText);
      })
    );

  const processNotes = () =>
    runParse(async () => parsePastedNotes(notes, notesTitle.trim() || 'Pasted notes'));

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) void processFile(files[0]);
    // Allows re-selecting the same file after a failed read.
    event.target.value = '';
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const files = event.dataTransfer.files;
    if (files && files.length > 0) void processFile(files[0]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode('file')}
          disabled={busy}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
            mode === 'file'
              ? 'bg-emerald-500 text-slate-950'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          Upload a file
        </button>
        <button
          onClick={() => setMode('notes')}
          disabled={busy}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
            mode === 'notes'
              ? 'bg-emerald-500 text-slate-950'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          Paste notes
        </button>
      </div>

      {mode === 'file' ? (
        <div
          onDragOver={event => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${
            isDragging
              ? 'border-emerald-400 bg-emerald-950/30'
              : 'border-slate-800 hover:border-slate-700 bg-slate-900/40 hover:bg-slate-900/60'
          }`}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept={FILE_ACCEPT}
            className="hidden"
            disabled={busy}
          />

          <div className="flex flex-col items-center justify-center space-y-3">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
              {parsingStatus ? (
                <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
              ) : (
                <UploadCloud className="w-6 h-6" />
              )}
            </div>

            <div>
              <div className="text-sm font-bold text-slate-200">
                {parsingStatus ?? 'Drop a document here, or click to browse'}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                {accept.join(' · ')}. The outline becomes the section list, and the text is stored
                with the pages that produced it.
              </p>
            </div>

            {parsingStatus && (
              <div className="w-full max-w-xs space-y-1.5 pt-2">
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>{parsingStatus}</span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-400" />
            <input
              value={notesTitle}
              onChange={event => setNotesTitle(event.target.value)}
              maxLength={120}
              placeholder="Title for this source"
              className="flex-1 min-w-[200px] bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-emerald-700"
            />
          </div>
          <textarea
            value={notes}
            onChange={event => setNotes(event.target.value)}
            rows={8}
            placeholder="Paste lecture notes, a summary, or any text you want cards from."
            className="w-full bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-emerald-700 resize-y"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-500 font-mono">
              {notes.trim().length === 0
                ? 'Nothing pasted yet.'
                : `${notes.trim().split(/\s+/).length} words`}
            </span>
            <button
              onClick={() => void processNotes()}
              disabled={busy || notes.trim().length === 0}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-colors disabled:opacity-40 inline-flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Read these notes
            </button>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Pasted text has no page of its own, so the pages are divided by content and the report
            says so. There is no original file to re-render later.
          </p>
        </div>
      )}

      {errorMessage && (
        <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/40 p-3 rounded-xl border border-red-900/50">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p>{errorMessage}</p>
            <details className="text-[11px] text-red-200/80">
              <summary className="cursor-pointer">Formats this build cannot read</summary>
              <ul className="mt-1 space-y-1 list-disc list-inside">
                {UNSUPPORTED_FORMATS.map(entry => (
                  <li key={entry.label}>
                    <strong>{entry.label}</strong> — {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      )}

    </div>
  );
};
