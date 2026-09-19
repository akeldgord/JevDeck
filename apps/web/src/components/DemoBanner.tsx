import React from 'react';
import { FlaskConical } from 'lucide-react';

interface Props {
  notice: string;
}

/**
 * Persistent marker for synthetic content.
 *
 * Requirement (R0): fabricated content is permitted only behind explicit demo
 * configuration and only when clearly labelled. Whenever demo mode is on, this banner is
 * visible on every screen so no figure or card can be mistaken for real output.
 */
export const DemoBanner: React.FC<Props> = ({ notice }) => (
  <div className="border-b border-amber-900/60 bg-amber-950/40" role="note">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-start gap-2.5">
      <FlaskConical className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
      <p className="text-[11px] sm:text-xs text-amber-200/90 leading-relaxed">
        <span className="font-bold uppercase tracking-wider text-amber-300">Demo mode</span>
        <span className="text-amber-200/50"> — </span>
        {notice}
      </p>
    </div>
  </div>
);

/** Compact marker used inline next to simulated figures. */
export const SimulatedBadge: React.FC<{ label?: string }> = ({ label = 'Simulated' }) => (
  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-400 border border-amber-800/60">
    {label}
  </span>
);
