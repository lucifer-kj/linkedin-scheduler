'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Eye,
  FileText,
  FlaskConical,
  KeyRound,
  Loader2,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Unlink,
  XCircle,
} from 'lucide-react';
import {
  api,
  ApiError,
  type AccountStatusResponse,
  type HealthResponse,
  type PostRecord,
  type PostStatus,
} from '@/lib/api';
import { ExecutionLogsDrawer } from '@/components/ExecutionLogsDrawer';

type FilterTab = 'all' | PostStatus;

function formatLocalDateTimeInput(date: Date): string {
  const tzOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

function formatExpiryCountdown(expiresAtIso: string): string {
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return `Expires in ${days}d`;
  const hours = Math.floor(diffMs / 3_600_000);
  return `Expires in ${Math.max(1, hours)}h`;
}

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [account, setAccount] = useState<AccountStatusResponse | null>(null);
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [pollingActive, setPollingActive] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Banner / Toast feedback (replaces window.alert / confirm)
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(
    null
  );

  // Custom OAuth Credentials accordion
  const [oauthOpen, setOauthOpen] = useState(false);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);
  const [originUrl, setOriginUrl] = useState('http://localhost:3000');

  // Composer state
  const [composerTab, setComposerTab] = useState<'compose' | 'preview'>('compose');
  const [content, setContent] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicatePostId, setDuplicatePostId] = useState<string | null>(null);

  // Queue state
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [selectedLogPost, setSelectedLogPost] = useState<PostRecord | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [highlightedPostId, setHighlightedPostId] = useState<string | null>(null);

  const connectionRef = useRef<HTMLElement | null>(null);
  const postRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const detectedTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return 'Local';
    }
  }, []);

  const setQuickTime = useCallback((secondsAhead: number) => {
    setScheduledFor(formatLocalDateTimeInput(new Date(Date.now() + secondsAhead * 1000)));
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [h, a, p] = await Promise.all([
        api.getHealth().catch(() => null),
        api.getAccount(),
        api.listPosts(),
      ]);
      if (h) setHealth(h);
      setAccount(a);
      setPosts(p.posts ?? []);
    } catch (err) {
      if (err instanceof ApiError) {
        setBanner({ type: 'error', text: err.message });
      }
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOriginUrl(window.location.origin);
      const params = new URLSearchParams(window.location.search);
      const authStatus = params.get('auth');
      const authMsg = params.get('message');
      if (authStatus === 'success') {
        setBanner({ type: 'success', text: 'LinkedIn account connected and encrypted with AES-256-GCM.' });
        window.history.replaceState({}, '', '/');
      } else if (authStatus === 'error') {
        setBanner({ type: 'error', text: authMsg || 'LinkedIn OAuth failed or was cancelled.' });
        window.history.replaceState({}, '', '/');
      }
    }
    setQuickTime(15);
    fetchAll();
  }, [fetchAll, setQuickTime]);

  useEffect(() => {
    if (!pollingActive) return;
    const id = setInterval(fetchAll, 2000);
    return () => clearInterval(id);
  }, [pollingActive, fetchAll]);

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      setBanner({ type: 'error', text: 'Clipboard access unavailable in this browser.' });
    }
  };

  const handleConnect = async () => {
    try {
      const { url } = await api.getAuthUrl();
      window.location.href = url;
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to start LinkedIn OAuth.',
      });
    }
  };

  const handleSaveCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customClientId.trim() || !customClientSecret.trim()) return;
    setSavingCreds(true);
    try {
      await api.saveCredentials(customClientId.trim(), customClientSecret.trim());
      setCustomClientId('');
      setCustomClientSecret('');
      setBanner({
        type: 'success',
        text: 'Custom LinkedIn OAuth credentials encrypted and saved for your session.',
      });
      await fetchAll();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSavingCreds(false);
    }
  };

  const handleClearCreds = async () => {
    setSavingCreds(true);
    try {
      await api.deleteCredentials();
      setBanner({ type: 'info', text: 'Custom credentials cleared. Using server OAuth defaults.' });
      await fetchAll();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Clear failed.' });
    } finally {
      setSavingCreds(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await api.disconnectAccount();
      setBanner({ type: 'info', text: 'LinkedIn account disconnected.' });
      await fetchAll();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Disconnect failed.' });
    }
  };

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setDuplicatePostId(null);

    const trimmed = content.trim();
    if (!trimmed) {
      setFormError('Post content cannot be empty.');
      return;
    }
    if (trimmed.length > 3000) {
      setFormError('Post content exceeds 3000 characters.');
      return;
    }
    const parsedDate = new Date(scheduledFor);
    if (!scheduledFor || Number.isNaN(parsedDate.getTime())) {
      setFormError('Please select a valid scheduled date and time.');
      return;
    }

    setSubmitting(true);
    try {
      await api.schedulePost(trimmed, parsedDate.toISOString());
      setContent('');
      setQuickTime(15);
      setBanner({ type: 'success', text: 'Post scheduled in PostgreSQL and BullMQ.' });
      await fetchAll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const dup = (err.data as { post?: PostRecord } | undefined)?.post;
        setDuplicatePostId(dup?.id ?? null);
        setFormError('Duplicate post detected for this exact content and timestamp.');
      } else {
        setFormError(err instanceof Error ? err.message : 'Failed to schedule post.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmCancel = async (postId: string) => {
    setCancelingId(postId);
    try {
      await api.cancelPost(postId);
      setConfirmCancelId(null);
      setBanner({ type: 'info', text: 'Scheduled post canceled and BullMQ job removed.' });
      await fetchAll();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Cancel failed.' });
    } finally {
      setCancelingId(null);
    }
  };

  const handleToggle503 = async () => {
    try {
      const res = await api.toggleSimulateFailure();
      setBanner({ type: 'info', text: res.message });
      await fetchAll();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Toggle failed.' });
    }
  };

  const jumpToPost = (postId: string) => {
    setFilterTab('all');
    setHighlightedPostId(postId);
    setTimeout(() => {
      postRefs.current[postId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    setTimeout(() => setHighlightedPostId(null), 2500);
  };

  const counts = useMemo(() => {
    return {
      all: posts.length,
      scheduled: posts.filter((p) => p.status === 'scheduled').length,
      processing: posts.filter((p) => p.status === 'processing').length,
      published: posts.filter((p) => p.status === 'published').length,
      failed: posts.filter((p) => p.status === 'failed').length,
    };
  }, [posts]);

  const filteredPosts = useMemo(
    () => (filterTab === 'all' ? posts : posts.filter((p) => p.status === filterTab)),
    [posts, filterTab]
  );

  const isConnected = Boolean(account?.connected);
  const isExpired = Boolean(account?.isExpired);
  const canSchedule = isConnected && !isExpired && content.trim().length > 0 && content.trim().length <= 3000;
  const scheduledUtcPreview = scheduledFor ? new Date(scheduledFor).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b border-[#1E2433] bg-[#090B10]/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#0A66C2] flex items-center justify-center font-bold text-white text-base tracking-tight">
              in
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm sm:text-base font-semibold text-slate-50">
                  LinkedIn Post Scheduler
                </h1>
                <span
                  className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
                    health?.status === 'ok'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {health?.status === 'ok' ? 'Worker Ready' : 'Checking'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                NestJS + BullMQ + PostgreSQL Multi-Tenant Pipeline
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2.5 py-1 rounded-full bg-[#11151E] border border-[#1E2433] text-slate-300 font-medium">
              Mode: <span className="text-sky-400">{account?.mode === 'live' ? 'Live' : 'Mock'}</span>
            </span>

            <button
              type="button"
              onClick={() => connectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className={`min-h-[36px] px-2.5 py-1 rounded-full border font-medium transition ${
                isExpired
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  : isConnected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              }`}
            >
              {isExpired
                ? 'Token Expired'
                : isConnected
                  ? `Connected: ${account?.account?.linkedinName}`
                  : 'Not Connected'}
            </button>

            <button
              type="button"
              onClick={() => setPollingActive((v) => !v)}
              className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#11151E] border border-[#1E2433] hover:border-[#2E374D] text-slate-300 inline-flex items-center gap-1.5"
              title="Toggle 2s live polling"
            >
              {pollingActive ? <Pause className="w-3.5 h-3.5 text-emerald-400" /> : <Play className="w-3.5 h-3.5 text-slate-400" />}
              <span className="tabular-nums">{pollingActive ? 'Live • 2s' : 'Paused'}</span>
            </button>

            <button
              type="button"
              onClick={fetchAll}
              aria-label="Refresh dashboard"
              className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#11151E] border border-[#1E2433] hover:border-[#2E374D] text-slate-300 inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Inline Notification Banner */}
      {banner && (
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div
            role="status"
            className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border text-xs ${
              banner.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : banner.type === 'error'
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
            }`}
          >
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-current opacity-75 hover:opacity-100 font-medium"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main 12-Col Grid */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Rail */}
        <div className="lg:col-span-5 space-y-5">
          {/* 1. LinkedIn Connection Card */}
          <section
            ref={connectionRef}
            className="bg-[#11151E] border border-[#1E2433] rounded-xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                1. LinkedIn Connection
              </h2>
              <span
                className={`text-[11px] px-2 py-0.5 rounded font-medium border ${
                  isExpired
                    ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                    : isConnected
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                      : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                }`}
              >
                {isExpired ? 'Expired' : isConnected ? 'Connected' : 'Not Connected'}
              </span>
            </div>

            {initialLoading ? (
              <div className="h-24 rounded-lg bg-[#0D1017] animate-pulse" />
            ) : isConnected && account?.account ? (
              <div className="space-y-3">
                <div className="bg-[#0D1017] border border-[#1E2433] rounded-lg p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Account</span>
                    <span className="font-semibold text-slate-100">{account.account.linkedinName}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400 shrink-0">Person URN</span>
                    <button
                      type="button"
                      onClick={() => copyText('urn', account.account!.linkedinPersonUrn)}
                      className="font-mono text-[11px] text-sky-400 hover:text-sky-300 break-all text-right inline-flex items-center gap-1"
                    >
                      <span>{account.account.linkedinPersonUrn}</span>
                      {copiedKey === 'urn' ? <Check className="w-3 h-3 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Token Lifecycle</span>
                    <span className={isExpired ? 'text-rose-400 font-medium' : 'text-slate-300 tabular-nums'}>
                      {formatExpiryCountdown(account.account.expiresAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Storage</span>
                    <span className="text-emerald-400 inline-flex items-center gap-1">
                      <Lock className="w-3 h-3" /> AES-256-GCM Encrypted
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleConnect}
                    className="flex-1 min-h-[44px] py-2 px-3 rounded-lg bg-[#0A66C2] hover:bg-[#0958A8] text-xs font-medium text-white transition"
                  >
                    {isExpired ? 'Reconnect Expired Token' : 'Reconnect'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="min-h-[44px] py-2 px-3 rounded-lg bg-[#0D1017] border border-[#1E2433] hover:border-rose-500/40 text-xs font-medium text-slate-300 hover:text-rose-300 inline-flex items-center gap-1.5 transition"
                  >
                    <Unlink className="w-3.5 h-3.5" /> Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-400 leading-relaxed">
                  Authorize via LinkedIn OAuth 2.0. Tokens are encrypted with AES-256-GCM and isolated per browser session.
                </p>
                <button
                  type="button"
                  onClick={handleConnect}
                  className="w-full min-h-[44px] py-2.5 px-4 rounded-lg bg-[#0A66C2] hover:bg-[#0958A8] font-medium text-sm text-white transition"
                >
                  Connect LinkedIn Account
                </button>
              </div>
            )}

            {/* Collapsible Custom OAuth Credentials Accordion */}
            <div className="border-t border-[#1E2433] pt-3">
              <button
                type="button"
                onClick={() => setOauthOpen((o) => !o)}
                className="w-full flex items-center justify-between text-xs text-slate-300 hover:text-slate-100 py-1"
              >
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                  Custom OAuth Credentials
                  {account?.hasCustomCredentials && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      Active
                    </span>
                  )}
                </span>
                {oauthOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {oauthOpen && (
                <div className="mt-3 space-y-3 bg-[#0D1017] border border-[#1E2433] rounded-lg p-3">
                  <div>
                    <span className="block text-[11px] text-slate-400 mb-1">
                      Authorized Redirect URI (add to LinkedIn App):
                    </span>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-[11px] font-mono text-sky-400 break-all bg-[#090B10] px-2 py-1.5 rounded border border-[#1E2433]">
                        {originUrl}/api/auth/linkedin/callback
                      </code>
                      <button
                        type="button"
                        onClick={() => copyText('redirect', `${originUrl}/api/auth/linkedin/callback`)}
                        className="min-h-[36px] px-2.5 rounded bg-[#11151E] border border-[#1E2433] hover:border-[#2E374D] text-xs text-slate-300"
                      >
                        {copiedKey === 'redirect' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  <form onSubmit={handleSaveCreds} className="space-y-2.5">
                    <input
                      type="text"
                      value={customClientId}
                      onChange={(e) => setCustomClientId(e.target.value)}
                      placeholder="LinkedIn Client ID (write-only)"
                      className="w-full min-h-[40px] rounded-lg bg-[#090B10] border border-[#1E2433] px-3 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                    />
                    <input
                      type="password"
                      value={customClientSecret}
                      onChange={(e) => setCustomClientSecret(e.target.value)}
                      placeholder="LinkedIn Client Secret (write-only)"
                      className="w-full min-h-[40px] rounded-lg bg-[#090B10] border border-[#1E2433] px-3 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={savingCreds || !customClientId.trim() || !customClientSecret.trim()}
                        className="flex-1 min-h-[38px] rounded-lg bg-[#1E2433] hover:bg-[#2E374D] text-xs font-medium text-slate-100 disabled:opacity-50"
                      >
                        {savingCreds ? 'Saving...' : 'Save Encrypted Credentials'}
                      </button>
                      {account?.hasCustomCredentials && (
                        <button
                          type="button"
                          onClick={handleClearCreds}
                          disabled={savingCreds}
                          className="min-h-[38px] px-3 rounded-lg border border-rose-500/30 text-xs text-rose-300 hover:bg-rose-500/10"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              )}
            </div>
          </section>

          {/* 2. Post Composer Card */}
          <section className="bg-[#11151E] border border-[#1E2433] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                2. Schedule LinkedIn Post
              </h2>
              <div className="inline-flex rounded-lg bg-[#0D1017] p-0.5 border border-[#1E2433] text-xs">
                <button
                  type="button"
                  onClick={() => setComposerTab('compose')}
                  className={`px-2.5 py-1 rounded-md inline-flex items-center gap-1 transition ${
                    composerTab === 'compose' ? 'bg-[#1E2433] text-slate-100' : 'text-slate-400'
                  }`}
                >
                  <FileText className="w-3 h-3" /> Compose
                </button>
                <button
                  type="button"
                  onClick={() => setComposerTab('preview')}
                  className={`px-2.5 py-1 rounded-md inline-flex items-center gap-1 transition ${
                    composerTab === 'preview' ? 'bg-[#1E2433] text-slate-100' : 'text-slate-400'
                  }`}
                >
                  <Eye className="w-3 h-3" /> LinkedIn Preview
                </button>
              </div>
            </div>

            {(!isConnected || isExpired) && (
              <div className="text-xs px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-center justify-between gap-2">
                <span>
                  {isExpired
                    ? 'Your LinkedIn token expired. Reconnect before scheduling.'
                    : 'Connect LinkedIn above to enable scheduling.'}
                </span>
                <button
                  type="button"
                  onClick={handleConnect}
                  className="underline font-medium shrink-0"
                >
                  {isExpired ? 'Reconnect' : 'Connect'}
                </button>
              </div>
            )}

            <form onSubmit={handleSchedule} className="space-y-4">
              {composerTab === 'compose' ? (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <label htmlFor="post-content" className="font-medium text-slate-300">
                      Post Content
                    </label>
                    <span
                      className={`font-mono tabular-nums ${
                        content.length >= 2950
                          ? 'text-rose-400'
                          : content.length >= 2700
                            ? 'text-amber-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {content.length} / 3000
                    </span>
                  </div>
                  <textarea
                    id="post-content"
                    rows={5}
                    maxLength={3000}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    aria-invalid={Boolean(formError)}
                    placeholder="Write your LinkedIn post..."
                    className="w-full rounded-lg bg-[#0D1017] border border-[#1E2433] p-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 resize-y"
                  />
                </div>
              ) : (
                <div className="rounded-lg bg-white text-slate-900 p-4 border border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-10 h-10 rounded-full bg-[#0A66C2] text-white font-semibold flex items-center justify-center text-sm">
                        {(account?.account?.linkedinName || 'LI').slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {account?.account?.linkedinName || 'LinkedIn Member'}
                        </p>
                        <p className="text-[11px] text-slate-500">Just now • Public</p>
                      </div>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                      Feed Preview
                    </span>
                  </div>
                  <p className="text-sm text-slate-800 whitespace-pre-wrap break-words leading-relaxed">
                    {content.trim()
                      ? content.length > 210
                        ? `${content.slice(0, 210)}… see more`
                        : content
                      : 'Your post preview will appear here as you type...'}
                  </p>
                  <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500 font-medium">
                    <span>Like</span>
                    <span>Comment</span>
                    <span>Repost</span>
                    <span>Send</span>
                  </div>
                </div>
              )}

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-1.5">
                  <label htmlFor="scheduled-for" className="font-medium text-slate-300">
                    Scheduled Date & Time
                  </label>
                  <div className="flex items-center gap-1">
                    {[
                      { label: '+15s', sec: 15 },
                      { label: '+1m', sec: 60 },
                      { label: '+5m', sec: 300 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setQuickTime(preset.sec)}
                        className="px-2 py-0.5 rounded bg-[#0D1017] border border-[#1E2433] hover:border-[#2E374D] text-[11px] text-sky-400"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  id="scheduled-for"
                  type="datetime-local"
                  required
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="w-full min-h-[44px] rounded-lg bg-[#0D1017] border border-[#1E2433] px-3 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                />
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-400 font-mono">
                  <span>Zone: {detectedTimeZone}</span>
                  <span>{scheduledUtcPreview}</span>
                </div>
              </div>

              {formError && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {formError}
                  </span>
                  {duplicatePostId && (
                    <button
                      type="button"
                      onClick={() => jumpToPost(duplicatePostId)}
                      className="underline font-medium shrink-0 text-amber-300"
                    >
                      Jump to existing post
                    </button>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={!canSchedule || submitting}
                className="w-full min-h-[44px] py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium text-sm text-white transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Scheduling...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" /> Schedule Post
                  </>
                )}
              </button>
            </form>
          </section>

          {/* 3. Evaluator Test Bench */}
          <section className="bg-[#11151E]/80 border border-[#1E2433] rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider inline-flex items-center gap-1.5">
              <FlaskConical className="w-3.5 h-3.5" /> Evaluator Resilience Test Bench
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Inject a transient HTTP 503 error on attempt 1 to verify automatic BullMQ exponential backoff retries without creating duplicate posts.
            </p>
            <button
              type="button"
              onClick={handleToggle503}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-medium text-amber-300 flex items-center justify-between transition"
            >
              <span>Simulate 503 Service Unavailable</span>
              <span className="font-mono font-bold">
                {health?.simulateTransientFailure ? 'ON' : 'OFF'}
              </span>
            </button>
          </section>
        </div>

        {/* Right Column: Live Execution Pipeline */}
        <div className="lg:col-span-7 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Live Post Queue & Pipeline</h2>
              <p className="text-xs text-slate-400">
                BullMQ delayed worker with atomic CAS deduplication
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5 text-xs">
              {(['all', 'scheduled', 'processing', 'published', 'failed'] as FilterTab[]).map(
                (tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setFilterTab(tab)}
                    className={`px-2.5 py-1 rounded-full border capitalize transition tabular-nums ${
                      filterTab === tab
                        ? 'bg-[#1E2433] border-[#2E374D] text-slate-100 font-medium'
                        : 'bg-[#11151E] border-[#1E2433] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab} ({counts[tab]})
                  </button>
                )
              )}
            </div>
          </div>

          {initialLoading ? (
            <div className="space-y-3">
              <div className="h-36 rounded-xl bg-[#11151E] border border-[#1E2433] animate-pulse" />
              <div className="h-36 rounded-xl bg-[#11151E] border border-[#1E2433] animate-pulse" />
            </div>
          ) : filteredPosts.length === 0 ? (
            <div className="p-10 text-center border border-dashed border-[#1E2433] rounded-xl space-y-3">
              <p className="text-sm text-slate-300 font-medium">No posts in this view</p>
              <p className="text-xs text-slate-400">
                Connect your LinkedIn account and schedule a post to watch the live worker pipeline.
              </p>
              <button
                type="button"
                onClick={() =>
                  setContent(
                    'Shipping our resilient LinkedIn Post Scheduler powered by NestJS, BullMQ, PostgreSQL, and AES-256-GCM encryption.'
                  )
                }
                className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#11151E] border border-[#1E2433] hover:border-[#2E374D] text-xs text-sky-400"
              >
                Insert Sample Post
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredPosts.map((post) => {
                const retrySecondsLeft =
                  post.status === 'scheduled' && post.retryCount > 0
                    ? Math.max(0, Math.ceil((new Date(post.scheduledFor).getTime() - nowMs) / 1000))
                    : 0;

                return (
                  <div
                    key={post.id}
                    ref={(el) => {
                      postRefs.current[post.id] = el;
                    }}
                    className={`bg-[#11151E] border rounded-xl p-4 space-y-3 transition ${
                      highlightedPostId === post.id
                        ? 'border-amber-400 ring-2 ring-amber-400/30'
                        : 'border-[#1E2433] hover:border-[#2E374D]'
                    }`}
                  >
                    {/* Top Meta + Status */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        {post.status === 'scheduled' && (
                          <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 inline-flex items-center gap-1 font-medium">
                            <Clock className="w-3 h-3" /> Scheduled
                          </span>
                        )}
                        {post.status === 'processing' && (
                          <span className="px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20 inline-flex items-center gap-1 font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" /> Processing
                          </span>
                        )}
                        {post.status === 'published' && (
                          <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 inline-flex items-center gap-1 font-medium">
                            <CheckCircle2 className="w-3 h-3" /> Published
                          </span>
                        )}
                        {post.status === 'failed' && (
                          <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 inline-flex items-center gap-1 font-medium">
                            <XCircle className="w-3 h-3" /> Failed
                          </span>
                        )}

                        {post.retryCount > 0 && (
                          <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-amber-500/10 text-amber-300 border border-amber-500/20 tabular-nums">
                            {post.status === 'scheduled' && retrySecondsLeft > 0
                              ? `Retrying in ${retrySecondsLeft}s • Attempt ${post.retryCount}/${post.maxRetries}`
                              : `Attempt ${post.retryCount}/${post.maxRetries}`}
                          </span>
                        )}
                      </div>

                      <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                        Due: {new Date(post.scheduledFor).toLocaleString()}
                      </span>
                    </div>

                    {/* 4-Stage Pipeline Stepper */}
                    <div className="grid grid-cols-4 gap-1.5 text-[10px] font-medium">
                      {(['scheduled', 'processing', 'published'] as const).map((step, idx) => {
                        const active =
                          (step === 'scheduled' && ['scheduled', 'processing', 'published', 'failed'].includes(post.status)) ||
                          (step === 'processing' && ['processing', 'published', 'failed'].includes(post.status)) ||
                          (step === 'published' && post.status === 'published');
                        return (
                          <div
                            key={step}
                            className={`h-1.5 rounded-full ${
                              active ? 'bg-emerald-500' : 'bg-[#1E2433]'
                            }`}
                            title={`Stage ${idx + 1}: ${step}`}
                          />
                        );
                      })}
                      <div
                        className={`h-1.5 rounded-full ${
                          post.status === 'failed' ? 'bg-rose-500' : 'bg-[#1E2433]'
                        }`}
                        title="Terminal failure"
                      />
                    </div>

                    {/* Content */}
                    <p className="text-sm text-slate-200 whitespace-pre-wrap break-words bg-[#0D1017] p-3 rounded-lg border border-[#1E2433]">
                      {post.content}
                    </p>

                    {/* Published URN */}
                    {post.externalPostUrn && (
                      <div className="flex items-center justify-between gap-2 text-xs bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 rounded-lg">
                        <span className="text-emerald-300 font-medium inline-flex items-center gap-1">
                          <ShieldCheck className="w-3.5 h-3.5" /> LinkedIn URN
                        </span>
                        <button
                          type="button"
                          onClick={() => copyText(post.id, post.externalPostUrn!)}
                          className="font-mono text-[11px] text-emerald-200 hover:underline break-all inline-flex items-center gap-1"
                        >
                          <span>{post.externalPostUrn}</span>
                          <Copy className="w-3 h-3 shrink-0" />
                        </button>
                      </div>
                    )}

                    {/* Error / Retry Strip */}
                    {post.lastError && (
                      <div className="text-xs bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg text-rose-200 font-mono text-[11px] break-words">
                        {post.lastError}
                      </div>
                    )}

                    {/* Card Footer */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1E2433] text-xs">
                      <button
                        type="button"
                        onClick={() => setSelectedLogPost(post)}
                        className="text-sky-400 hover:text-sky-300 font-medium"
                      >
                        View Execution Logs
                      </button>

                      {post.status === 'scheduled' &&
                        (confirmCancelId === post.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-slate-300">Confirm cancel?</span>
                            <button
                              type="button"
                              disabled={cancelingId === post.id}
                              onClick={() => handleConfirmCancel(post.id)}
                              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-medium"
                            >
                              {cancelingId === post.id ? 'Canceling...' : 'Yes'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmCancelId(null)}
                              className="px-2 py-1 rounded bg-[#1E2433] text-slate-300"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmCancelId(post.id)}
                            className="text-rose-400 hover:text-rose-300 inline-flex items-center gap-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Cancel Post
                          </button>
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      <ExecutionLogsDrawer post={selectedLogPost} onClose={() => setSelectedLogPost(null)} />
    </div>
  );
}
