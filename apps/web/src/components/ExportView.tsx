import React, { useState } from 'react';
import { Deck, Flashcard } from '@jevdeck/contracts';
import { exportDeckToAnkiTxt, exportDeckToJson } from '@jevdeck/anki-export';
import { 
  Download, 
  FileSpreadsheet, 
  Code, 
  Copy, 
  Check, 
  CheckCircle2
} from 'lucide-react';

interface Props {
  deck: Deck;
  cards: Flashcard[];
}

export const ExportView: React.FC<Props> = ({ deck, cards }) => {
  const [copiedFormat, setCopiedFormat] = useState<'anki' | 'json' | null>(null);

  const ankiTxt = exportDeckToAnkiTxt(deck, cards);
  const jsonExport = exportDeckToJson(deck, cards);

  const handleDownloadTxt = () => {
    const blob = new Blob([ankiTxt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${deck.title.replace(/\s+/g, '_')}_anki_export.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    const blob = new Blob([jsonExport], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${deck.title.replace(/\s+/g, '_')}_cards.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (text: string, format: 'anki' | 'json') => {
    navigator.clipboard.writeText(text);
    setCopiedFormat(format);
    setTimeout(() => setCopiedFormat(null), 2000);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 backdrop-blur-md shadow-xl space-y-6">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Download className="w-5 h-5 text-emerald-400" />
            Export Deck ({cards.length} Grounded Flashcards)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Export directly to Anki (.txt with native Cloze markup & citations) or structured JSON.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Anki Export Card */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                <FileSpreadsheet className="w-4 h-4" />
                Anki Desktop / Mobile (.txt)
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Tab-separated format configured with tags, native <code className="text-purple-300 font-mono">{"{{c1::...}}"}</code> cloze fields, and verbatim source excerpts with page numbers.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={handleDownloadTxt}
                className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-colors flex items-center justify-center gap-1.5 shadow-md shadow-emerald-500/20"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .txt</span>
              </button>
              <button
                onClick={() => copyToClipboard(ankiTxt, 'anki')}
                className="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors flex items-center gap-1"
                title="Copy contents"
              >
                {copiedFormat === 'anki' ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* JSON Export Card */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
                <Code className="w-4 h-4" />
                Full Deck JSON Bundle
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Complete JSON bundle preserving SuperMemo SM-2 intervals, bounding box coordinates, excerpt citations, and section hierarchy.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={handleDownloadJson}
                className="flex-1 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-xs transition-colors flex items-center justify-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .json</span>
              </button>
              <button
                onClick={() => copyToClipboard(jsonExport, 'json')}
                className="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors flex items-center gap-1"
                title="Copy JSON"
              >
                {copiedFormat === 'json' ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Anki Import Instructions */}
        <div className="p-4 rounded-2xl bg-slate-950/40 border border-slate-800/60 space-y-2">
          <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            Quick Anki Desktop Import Steps:
          </div>
          <ol className="text-xs text-slate-400 list-decimal list-inside space-y-1">
            <li>Click <strong>File → Import</strong> in Anki.</li>
            <li>Select the downloaded <code className="text-emerald-400 font-mono">_anki_export.txt</code> file.</li>
            <li>Set card type to <strong>Cloze</strong> or <strong>Basic</strong> (Anki handles tab-separated columns automatically).</li>
            <li>Click <strong>Import</strong>. Your cards and tags will appear under the deck name.</li>
          </ol>
        </div>
      </div>
    </div>
  );
};
