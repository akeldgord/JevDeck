import React, { useRef, useState } from 'react';
import { UploadCloud, AlertCircle, Loader2 } from 'lucide-react';
import { parsePdfDocument, ParsedPdfResult } from '../lib/pdfParser';

interface Props {
  onDocumentParsed: (result: ParsedPdfResult) => void;
  isProcessing: boolean;
}

export const PdfUploader: React.FC<Props> = ({ onDocumentParsed, isProcessing }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [parsingStatus, setParsingStatus] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const processFile = async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMessage('Please select a valid PDF file.');
      return;
    }

    setErrorMessage(null);
    setParsingStatus('Initializing PDF parser...');
    setProgressPercent(5);

    try {
      const result = await parsePdfDocument(file, (percent, statusText) => {
        setProgressPercent(percent);
        setParsingStatus(statusText);
      });

      setParsingStatus(null);
      setProgressPercent(0);
      onDocumentParsed(result);
    } catch (err: any) {
      console.error('PDF parsing error:', err);
      setErrorMessage(
        err?.message || 'Failed to parse PDF document. Ensure the file is not corrupted or password protected.'
      );
      setParsingStatus(null);
      setProgressPercent(0);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
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
          accept="application/pdf"
          className="hidden"
          disabled={isProcessing || Boolean(parsingStatus)}
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
              {parsingStatus ? 'Extracting Sections...' : 'Upload PDF Document or Textbook'}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Drag and drop your PDF here, or click to browse. Automatic TOC extraction with section segmentation.
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

      {errorMessage && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-950/40 p-3 rounded-xl border border-red-900/50">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
