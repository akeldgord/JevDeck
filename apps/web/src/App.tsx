import { useState } from 'react';
import { 
  Deck, 
  DocumentSection, 
  Flashcard, 
  CoverageMode, 
  User, 
  Invitation, 
  SystemUsageStats 
} from '@jevdeck/contracts';
import { generateFlashcardsFromSections } from '@jevdeck/generation';
import { isCardDue } from '@jevdeck/scheduling';
import { ParsedPdfResult } from './lib/pdfParser';
import { 
  INITIAL_SECTIONS, 
  SAMPLE_DECK, 
  INITIAL_CARDS, 
  INITIAL_USERS, 
  INITIAL_INVITATIONS, 
  INITIAL_STATS 
} from './data/mockData';
import { Header } from './components/Header';
import { SectionSelectorAndEstimator } from './components/SectionSelectorAndEstimator';
import { StudyInterface } from './components/StudyInterface';
import { DualGroundingViewer } from './components/DualGroundingViewer';
import { AdminPanel } from './components/AdminPanel';
import { ExportView } from './components/ExportView';

export default function App() {
  const [activeTab, setActiveTab] = useState<'generator' | 'study' | 'admin' | 'export'>('generator');
  
  // Document and Sections State
  const [sections, setSections] = useState<DocumentSection[]>(INITIAL_SECTIONS);
  const [coverageMode, setCoverageMode] = useState<CoverageMode>('comprehensive');
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasCustomToc, setHasCustomToc] = useState(true);
  
  // Deck & Cards State
  const [deck, setDeck] = useState<Deck>(SAMPLE_DECK);
  const [cards, setCards] = useState<Flashcard[]>(INITIAL_CARDS);
  
  // Dual Inspection State
  const [inspectingCard, setInspectingCard] = useState<Flashcard | null>(null);

  // Cram Session State
  const [isCramSession, setIsCramSession] = useState(false);
  const [modifyScheduleInCram, setModifyScheduleInCram] = useState(false);

  // Admin and Budget State
  const [currentUser] = useState<User>(INITIAL_USERS[0]);
  const [users] = useState<User[]>(INITIAL_USERS);
  const [invitations, setInvitations] = useState<Invitation[]>(INITIAL_INVITATIONS);
  const [stats, setStats] = useState<SystemUsageStats>(INITIAL_STATS);

  // Toggle section selection
  const handleToggleSection = (id: string) => {
    setSections(prev =>
      prev.map(s => (s.id === id ? { ...s, selected: !s.selected } : s))
    );
  };

  const handleSelectAll = (select: boolean) => {
    setSections(prev => prev.map(s => ({ ...s, selected: select })));
  };

  // Handler when user uploads a new PDF file
  const handleDocumentUploaded = (result: ParsedPdfResult) => {
    const newDocId = `doc-${Date.now()}`;
    setSections(result.sections);
    setHasCustomToc(result.hasToc);
    setDeck(prev => ({
      ...prev,
      documentId: newDocId,
      documentName: result.fileName,
      title: result.fileName.replace(/\.[^/.]+$/, ''),
      pageCount: result.pageCount,
    }));
  };

  // Start Generation pipeline
  const handleStartGeneration = () => {
    setIsGenerating(true);
    setTimeout(() => {
      const newGeneratedCards = generateFlashcardsFromSections({
        deckId: deck.id,
        documentId: deck.documentId,
        documentName: deck.documentName,
        sections,
        coverageMode,
      });

      setCards(prev => [...prev, ...newGeneratedCards]);
      setDeck(prev => ({
        ...prev,
        cardCount: prev.cardCount + newGeneratedCards.length,
        updatedAt: new Date().toISOString()
      }));

      // Update token and budget usage in stats
      const addedTokens = newGeneratedCards.length * 550;
      const addedSpend = Math.round((addedTokens / 1000) * 0.003 * 100) / 100;

      setStats(prev => ({
        ...prev,
        instanceTotalSpendUsd: Math.round((prev.instanceTotalSpendUsd + addedSpend) * 100) / 100,
        instanceTotalTokens: prev.instanceTotalTokens + addedTokens,
        totalCardsGenerated: prev.totalCardsGenerated + newGeneratedCards.length,
      }));

      setIsGenerating(false);
      setActiveTab('study');
    }, 1200);
  };

  const handleUpdateCard = (updatedCard: Flashcard) => {
    setCards(prev => prev.map(c => (c.id === updatedCard.id ? updatedCard : c)));
  };

  const handleInviteUser = (email: string, spendLimit: number) => {
    const newInv: Invitation = {
      id: `inv-${Date.now()}`,
      email,
      role: 'member',
      invitedBy: currentUser.email,
      token: `jev_inv_${Math.random().toString(36).substring(2, 12)}`,
      monthlySpendLimitUsd: spendLimit,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    setInvitations(prev => [newInv, ...prev]);
  };

  const handleRevokeInvitation = (id: string) => {
    setInvitations(prev => prev.filter(inv => inv.id !== id));
  };

  const handleUpdateInstanceCap = (newCapUsd: number) => {
    setStats(prev => ({ ...prev, instanceMonthlyCapUsd: newCapUsd }));
  };

  const dueCardCount = cards.filter(c => isCardDue(c)).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-emerald-500 selection:text-slate-950">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={currentUser}
        stats={stats}
        dueCardCount={dueCardCount}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'generator' && (
          <SectionSelectorAndEstimator
            sections={sections}
            onToggleSection={handleToggleSection}
            onSelectAll={handleSelectAll}
            coverageMode={coverageMode}
            onCoverageModeChange={setCoverageMode}
            onStartGeneration={handleStartGeneration}
            isGenerating={isGenerating}
            documentName={deck.documentName}
            pageCount={deck.pageCount}
            hasCustomToc={hasCustomToc}
            onDocumentUploaded={handleDocumentUploaded}
          />
        )}

        {activeTab === 'study' && (
          <StudyInterface
            cards={cards}
            onUpdateCard={handleUpdateCard}
            onOpenDualViewer={(c) => setInspectingCard(c)}
            isCramSession={isCramSession}
            onToggleCramSession={setIsCramSession}
            modifyScheduleInCram={modifyScheduleInCram}
            onToggleModifyScheduleInCram={setModifyScheduleInCram}
          />
        )}

        {activeTab === 'export' && (
          <ExportView deck={deck} cards={cards} />
        )}

        {activeTab === 'admin' && (
          <AdminPanel
            users={users}
            invitations={invitations}
            stats={stats}
            onInviteUser={handleInviteUser}
            onRevokeInvitation={handleRevokeInvitation}
            onUpdateInstanceCap={handleUpdateInstanceCap}
          />
        )}
      </main>

      {/* Dual Grounding PDF and Excerpt Inspector Modal */}
      <DualGroundingViewer
        card={inspectingCard}
        onClose={() => setInspectingCard(null)}
      />
    </div>
  );
}
