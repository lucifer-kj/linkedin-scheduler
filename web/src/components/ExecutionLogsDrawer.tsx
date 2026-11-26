'use client';

import { X, Clock, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { PostRecord } from '@/lib/api';

interface ExecutionLogsDrawerProps {
  post: PostRecord | null;
  onClose: () => void;
}

export function ExecutionLogsDrawer({ post, onClose }: ExecutionLogsDrawerProps) {
  if (!post) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Execution logs drawer"
    >
      <div className="w-full sm:w-[440px] h-full bg-[#11151E] border-l border-[#1E2433] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1E2433]">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Execution & Retry Inspector</h2>
            <p className="text-xs font-mono text-slate-400 mt-0.5">{post.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-100 hover:bg-[#1E2433] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
              Lifecycle Timeline
            </h3>
            <ol className="relative border-l border-[#1E2433] ml-2 space-y-4">
              <li className="pl-5 relative">
                <span className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full bg-[#1E2433] border border-slate-600 flex items-center justify-center">
                  <Clock className="w-2.5 h-2.5 text-amber-400" />
                </span>
                <p className="text-xs font-medium text-slate-200">Enqueued in BullMQ & PostgreSQL</p>
                <p className="text-[11px] font-mono text-slate-400">
                  Created: {new Date(post.createdAt).toLocaleString()}
                </p>
              </li>

              {post.retryCount > 0 && (
                <li className="pl-5 relative">
                  <span className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                    <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />
                  </span>
                  <p className="text-xs font-medium text-amber-300">
                    Retries Recorded: {post.retryCount} / {post.maxRetries}
                  </p>
                  {post.lastError && (
                    <p className="text-[11px] font-mono text-rose-300 mt-1 break-words bg-[#0D1017] p-2 rounded border border-[#1E2433]">
                      {post.lastError}
                    </p>
                  )}
                </li>
              )}

              <li className="pl-5 relative">
                <span className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full bg-[#1E2433] border border-slate-600 flex items-center justify-center">
                  {post.status === 'published' ? (
                    <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                  ) : post.status === 'processing' ? (
                    <Loader2 className="w-2.5 h-2.5 text-sky-400 animate-spin" />
                  ) : post.status === 'failed' ? (
                    <AlertTriangle className="w-2.5 h-2.5 text-rose-400" />
                  ) : (
                    <Clock className="w-2.5 h-2.5 text-amber-400" />
                  )}
                </span>
                <p className="text-xs font-medium text-slate-200 capitalize">
                  Current State: {post.status}
                </p>
                <p className="text-[11px] font-mono text-slate-400">
                  {post.publishedAt
                    ? `Published: ${new Date(post.publishedAt).toLocaleString()}`
                    : `Target: ${new Date(post.scheduledFor).toLocaleString()}`}
                </p>
              </li>
            </ol>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Structured Payload Inspector
            </h3>
            <pre className="text-[11px] font-mono text-slate-300 bg-[#0D1017] border border-[#1E2433] rounded-lg p-3 overflow-x-auto leading-relaxed">
              {JSON.stringify(
                {
                  postId: post.id,
                  status: post.status,
                  idempotencyKey: post.idempotencyKey,
                  bullmqJobId: post.bullmqJobId,
                  retryCount: post.retryCount,
                  maxRetries: post.maxRetries,
                  scheduledFor: post.scheduledFor,
                  publishedAt: post.publishedAt,
                  externalPostUrn: post.externalPostUrn,
                  lastError: post.lastError,
                },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
