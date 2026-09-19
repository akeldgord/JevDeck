import React, { useState } from 'react';
import { Deck, Flashcard } from '@jevdeck/contracts';
import { exportDeckToAnkiTxt, exportDeckToJson } from '@jevdeck/anki-export';
import { 
  Download, 
  FileSpreadsheet, 
  Code, 
  Copy, 
  Check, 
  CheckCircle2,
  PackageOpen
} from 'lucide-react';
import { api } from '../lib/api';
import { SimulatedBadge } from './DemoBanner';

interface Props {
  deck: Deck | null;
  cards: Flashcard[];
  /** True when the cards being exported are synthetic demo content. */
  isDemo: boolean;
  /** The stored deck id, or `null` when only a local deck exists. */
  deckId: string | null;
  /** Whether the package endpoint is available for this deployment. */
  canExportPackage: boolean;
}

export const ExportView: React.FC<Props> = ({ deck, cards, isDemo, deckId, canExportPackage }) => {
  const [copiedFormat, setCopiedFormat] = useState<'anki' | 'json' | null>(null);
  const [packageState, setPackageState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [packageError, setPackageError] = useState<string | null>(null);

  /**
   * Downloads the real `.apkg`.
   *
   * The package is built by the server from the stored deck, its evidence and the caller's own
   * schedule, so the file is the deck's actual content rather than a browser-side approximation.
   */
  const handleDownloadApkg = async () => {
    if (!deckId) return;

    setPackageState('busy');
    setPackageError(null);

    try {
      const file = await api.downloadApkg(deckId);
      const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setPackageState('done');
    } catch (cause) {
      setPackageState('failed');
      setPackageError(cause instanceof Error ? cause.message : 'The package could not be built.');
    }
  };

  // Requirement (R0): do not offer an export of a deck that does not exist. An empty deck
  // reports that there is nothing to export instead of producing an empty file.
  if (!deck || cards.length === 0) {
    return (
      <div className="max-w-xl mx-auto bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center backdrop-blur-md shadow-2xl space-y-5">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/80 text-slate-400 mx-auto flex items-center justify-center border border-slate-700">
          <PackageOpen className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-black text-slate-100">Nothing to export yet</h2>
          <p className="text-sm text-slate-400">
            {deck
              ? 'This deck has no cards. Generate cards before exporting.'
              : 'Generate cards from a document first. Exports are produced from the cards in the deck, not from the document itself.'}
          </p>
        </div>
      </div>
    );
  }

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
            Export Deck ({cards.length} Cards)
            {isDemo && <SimulatedBadge label="Demo cards" />}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            A real Anki package (<code className="font-mono">.apkg</code>) built on the server and
            ready to import, or a tab-separated text file and a JSON bundle for other tools.
          </p>
        </div>

        {/* The real package: a ZIP containing an Anki collection the importer opens. */}
        <div className="bg-slate-950/60 border border-emerald-900/50 rounded-2xl p-6 space-y-3">
          <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
            <PackageOpen className="w-4 h-4" />
            Anki package (.apkg)
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Built on the server from the stored deck, each card's verbatim citation and your own
            review schedule, so the cards arrive with the intervals you have already earned.
            Figures and tables are not bundled: this application does not extract media yet, so
            the package has none rather than placeholders.
          </p>
          <button
            onClick={() => void handleDownloadApkg()}
            disabled={!canExportPackage || !deckId || packageState === 'busy'}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition-colors inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            {packageState === 'busy' ? 'Building package…' : 'Download .apkg'}
          </button>
          {!canExportPackage && (
            <p className="text-[11px] text-amber-300/90">
              Package export needs a stored deck on a running API. This configuration has none.
            </p>
          )}
          {packageState === 'done' && (
            <p className="text-[11px] text-emerald-300">Package downloaded.</p>
          )}
          {packageError && <p className="text-[11px] text-red-300">{packageError}</p>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Anki Export Card */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                <FileSpreadsheet className="w-4 h-4" />
                Anki import file (.txt)
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
                Deck JSON Bundle
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                JSON bundle with SM-2 scheduling state, source excerpts, page numbers and section
                titles. Highlight geometry is omitted when it was not measured.
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
