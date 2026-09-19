import React, { useEffect, useState } from 'react';
import { AlertCircle, KeyRound, Loader2, Mail, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { InvitationInspection, REASON_TEXT, api } from '../lib/api';
import { UseSessionResult, describeAuthFailure } from '../hooks/useSession';
import { UnavailablePanel } from './UnavailablePanel';

interface Props {
  session: UseSessionResult;
  /** Invitation token from the URL, if the visitor arrived through an invitation link. */
  inviteToken: string | null;
  onInvitationResolved: () => void;
}

const PASSWORD_MIN_LENGTH = 12;

/**
 * The only way into the application.
 *
 * Three entry points, in order of precedence: accept an invitation, create the first
 * administrator on a fresh installation, or sign in. There is no registration form, because
 * accounts are created by administrator invitation only.
 */
export const AuthView: React.FC<Props> = ({ session, inviteToken, onInvitationResolved }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InvitationInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const accepting = inviteToken !== null;

  // Inspecting the invitation is deliberately non-consuming, so loading this screen (or
  // reloading it) never burns the link.
  useEffect(() => {
    if (!inviteToken) {
      setInspection(null);
      return;
    }

    let cancelled = false;
    setInspecting(true);

    api
      .inspectInvitation(inviteToken)
      .then(result => {
        if (!cancelled) setInspection(result);
      })
      .catch(cause => {
        if (!cancelled) {
          setInspection({
            email: '',
            role: 'member',
            expiresAt: '',
            usable: false,
            reason: 'unknown',
          });
          setFormError(describeAuthFailure(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setInspecting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  if (session.status === 'checking') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Checking the session…</span>
        </div>
      </div>
    );
  }

  // No API means no accounts, so there is nothing to sign in to. Say so instead of showing a
  // form that cannot work.
  if (!session.capabilities.session.available) {
    return (
      <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-16 space-y-6">
        <UnavailablePanel
          capability={session.capabilities.session}
          blockedAction="Signing in is unavailable, so the application cannot be used yet."
        />
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-2">
          <h2 className="text-sm font-bold text-slate-200">What to do</h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            Start the API service and reload this page. On a fresh installation the API will
            then offer the one-time administrator bootstrap, and accounts are created from
            there by invitation.
          </p>
        </div>
      </div>
    );
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      if (accepting && inviteToken) {
        await session.acceptInvitation({ token: inviteToken, name, password });
        onInvitationResolved();
      } else if (session.bootstrap.required) {
        await session.bootstrapAdministrator({
          email,
          name,
          password,
          ...(bootstrapToken ? { token: bootstrapToken } : {}),
        });
      } else {
        await session.signIn(email, password);
      }
    } catch (cause) {
      setFormError(describeAuthFailure(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const invitationUnusable = accepting && inspection !== null && !inspection.usable;
  const invitationNotice = inspecting
    ? 'Checking this invitation…'
    : invitationUnusable
      ? REASON_TEXT[inspection?.reason ?? 'unknown']
      : null;
  const showInvitationNotice = accepting && (invitationNotice !== null || formError !== null);
  const heading = accepting
    ? 'Accept your invitation'
    : session.bootstrap.required
      ? 'Set up this installation'
      : 'Sign in';
  const subheading = accepting
    ? 'Choose a display name and a password to activate your account.'
    : session.bootstrap.required
      ? 'No accounts exist yet. Create the first administrator; this can be done once.'
      : 'JevDeck accounts are created by administrator invitation.';

  return (
    <div className="flex-1 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center shadow-lg shadow-emerald-900/30">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-black text-slate-100">{heading}</h1>
          <p className="text-sm text-slate-400">{subheading}</p>
        </div>

        {showInvitationNotice && (
          <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-4 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-amber-200/90 space-y-1">
              <p className="font-semibold">{invitationNotice ?? formError}</p>
              {invitationNotice && formError && (
                <p className="text-amber-200/70">{formError}</p>
              )}
              {invitationUnusable && (
                <p className="text-amber-200/70">
                  Ask an administrator to send a new invitation.
                </p>
              )}
            </div>
          </div>
        )}

        {!invitationUnusable && (
          <form
            onSubmit={onSubmit}
            className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl"
          >
            {!accepting && session.bootstrap.required && (
              <Field
                label="Your name"
                icon={<UserRound className="w-4 h-4" />}
                value={name}
                onChange={setName}
                autoComplete="name"
                required
              />
            )}

            {accepting && (
              <>
                <div className="space-y-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Invited address
                  </span>
                  <div className="px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-300 font-mono">
                    {inspection?.email || '—'}
                  </div>
                </div>
                <Field
                  label="Your name"
                  icon={<UserRound className="w-4 h-4" />}
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  required
                />
              </>
            )}

            {!accepting && (
              <Field
                label="Email address"
                icon={<Mail className="w-4 h-4" />}
                value={email}
                onChange={setEmail}
                type="email"
                autoComplete="username"
                required
              />
            )}

            <Field
              label={`Password (at least ${PASSWORD_MIN_LENGTH} characters)`}
              icon={<KeyRound className="w-4 h-4" />}
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete={
                accepting || session.bootstrap.required ? 'new-password' : 'current-password'
              }
              required
            />

            {!accepting && session.bootstrap.required && session.bootstrap.tokenRequired && (
              <Field
                label="Bootstrap token"
                icon={<ShieldCheck className="w-4 h-4" />}
                value={bootstrapToken}
                onChange={setBootstrapToken}
                type="password"
                autoComplete="off"
                required
              />
            )}

            {formError && !showInvitationNotice && (
              <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/30 border border-red-900/50 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-sm transition-colors flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>
                {accepting ? 'Activate account' : session.bootstrap.required ? 'Create administrator' : 'Sign in'}
              </span>
            </button>
          </form>
        )}

        <p className="text-center text-[11px] text-slate-500 leading-relaxed">
          Accounts are invitation-only. There is no public registration, and this application
          never creates an account on your behalf.
        </p>
      </div>
    </div>
  );
};

interface FieldProps {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}

const Field: React.FC<FieldProps> = ({
  label,
  icon,
  value,
  onChange,
  type = 'text',
  autoComplete,
  required,
}) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</span>
    <span className="flex items-center gap-2 px-3.5 rounded-xl bg-slate-950 border border-slate-800 focus-within:border-emerald-500 transition-colors">
      <span className="text-slate-500">{icon}</span>
      <input
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={event => onChange(event.target.value)}
        className="flex-1 bg-transparent py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
      />
    </span>
  </label>
);
