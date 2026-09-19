import React from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { CapabilityUnavailable } from '../config/capabilities';

interface Props {
  capability: CapabilityUnavailable;
  /** The action this blocks, stated in the user's terms. */
  blockedAction?: string;
  className?: string;
}

/**
 * Renders a capability the application does not have.
 *
 * Requirement (R0): when a production capability is unavailable, show an actionable
 * unavailable/error state rather than simulated success. This panel is the only way the
 * application reports a missing feature, so the wording always names what is missing, what
 * it means, and what would fix it.
 */
export const UnavailablePanel: React.FC<Props> = ({ capability, blockedAction, className = '' }) => (
  <div
    className={`rounded-2xl border border-amber-900/50 bg-amber-950/20 p-5 space-y-3 ${className}`}
    role="status"
  >
    <div className="flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-amber-200">{capability.title}</h3>
        {blockedAction && (
          <p className="text-xs font-semibold text-amber-300/90">{blockedAction}</p>
        )}
        <p className="text-xs text-slate-300 leading-relaxed">{capability.detail}</p>
        <p className="text-xs text-slate-400 leading-relaxed flex items-start gap-1.5">
          <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-400" />
          <span>{capability.remedy}</span>
        </p>
      </div>
    </div>
  </div>
);
