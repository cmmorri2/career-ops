import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Database, FileText, MapPin, Tag } from "lucide-react";
import { findPosting, readPostingArtifacts, readPostingSnapshot } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { PostingDetailActions } from "@/components/posting-detail-actions";
import { scoreTone } from "@/lib/format";

export const dynamic = "force-dynamic";

function fact(label: string, value?: string | number | null) {
  if (value == null || value === "") return null;
  return (
    <div className="rounded-lg border border-border bg-surface/35 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-1 text-sm text-foreground">{value}</p>
    </div>
  );
}

function arrangementLabel(mode?: string): string | undefined {
  if (!mode) return undefined;
  if (mode === "Remote") return "Remote eligible";
  if (mode === "RemoteFlex") return "Remote-flex";
  if (mode === "Hybrid") return "Hybrid / relocate";
  if (mode === "Full") return "On-site / relocate";
  return mode;
}

function artifactLabel(type: string): string {
  return type.replaceAll("_", " ");
}

export default async function PostingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const posting = findPosting(id);
  if (!posting) notFound();

  const snapshot = readPostingSnapshot(posting.id);
  const artifacts = readPostingArtifacts(posting.id);
  const description = snapshot?.description?.trim();
  const isExpired = posting.status === "expired" || posting.pipelineState === "expired";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 max-sm:pb-24">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Inbox
      </Link>

      <section className="mt-5 border-b border-border pb-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <CompanyLogo name={posting.company} size={28} />
              <p className="text-sm font-medium text-muted">{posting.company}</p>
            </div>
            <h1 className="mt-3 max-w-3xl font-display text-3xl leading-tight tracking-tight text-landing">{posting.role}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge tone={scoreTone(posting.score)}>{posting.score || "not scored"}</Badge>
              {isExpired && <Badge tone="bad">expired</Badge>}
              <Badge tone={posting.pipelineState === "shortlisted" ? "good" : posting.pipelineState === "pending" ? "warn" : posting.pipelineState === "discarded" || posting.pipelineState === "expired" ? "bad" : "muted"} className="capitalize">
                {posting.pipelineState}
              </Badge>
              {posting.applicationPriority && <Badge tone="muted">{posting.applicationPriority}</Badge>}
            </div>
          </div>
          <PostingDetailActions posting={posting} />
        </div>
      </section>

      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fact("Mobility", [posting.locationRegion, arrangementLabel(posting.workMode)].filter(Boolean).join(" · "))}
        {fact("Raw location", posting.location)}
        {fact("Pay", posting.payRange || posting.compensation)}
        {fact("Source", posting.source)}
        {fact("First seen", posting.date)}
        {fact("Last seen", posting.lastSeen)}
        {fact("Posting status", posting.status)}
        {fact("Deep reviewed", posting.deepReviewedAt)}
        {fact("Deep review", posting.deepReviewPath)}
      </section>

      {(posting.deepFitScore || posting.deepStretchScore || posting.deepInterestScore) && (
        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted">
            <Tag className="size-4 text-brand" /> Deep signals
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {fact("Fit", posting.deepFitScore != null ? posting.deepFitScore.toFixed(1) : undefined)}
            {fact("Stretch", posting.deepStretchScore != null ? posting.deepStretchScore.toFixed(1) : undefined)}
            {fact("Interest", posting.deepInterestScore != null ? posting.deepInterestScore.toFixed(1) : undefined)}
          </div>
        </section>
      )}

      <section className="mt-8 grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted">
            <FileText className="size-4 text-brand" /> Details
          </h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/35 p-5">
            {description ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
            ) : (
              <div className="space-y-3 text-sm text-muted">
                <p>No full job description is cached locally for this posting yet.</p>
                {posting.notes && (
                  <>
                    <p className="text-xs font-semibold uppercase tracking-wide text-faint">Stored notes</p>
                    <p>{posting.notes}</p>
                  </>
                )}
                <p>
                  {isExpired ? (
                    <>Restore this posting before evaluating it or changing its triage state.</>
                  ) : (
                    <>Use <span className="font-medium text-foreground">Open posting</span> to inspect the live JD, or run <span className="font-medium text-foreground">Evaluate</span> to create the deeper report and tailored package.</>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted">
              <Database className="size-4 text-brand" /> Stored fields
            </h2>
            <dl className="mt-3 space-y-2 rounded-2xl border border-border bg-surface/35 p-4 text-sm">
              <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">URL</dt><dd className="min-w-0 truncate text-muted">{posting.url}</dd></div>
              <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">ID</dt><dd className="text-muted">{posting.id}</dd></div>
              <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">State</dt><dd className="text-muted">{posting.pipelineState}</dd></div>
              <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">Availability</dt><dd className={isExpired ? "text-red-300" : "text-muted"}>{posting.status}</dd></div>
              {posting.reportPath && <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">Report</dt><dd className="min-w-0 truncate text-muted">{posting.reportPath}</dd></div>}
              {posting.pdfPath && <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">PDF</dt><dd className="min-w-0 truncate text-muted">{posting.pdfPath}</dd></div>}
              {snapshot && <div className="flex gap-3"><dt className="w-24 shrink-0 text-faint">Snapshot</dt><dd className="text-muted">{snapshot.capturedAt}</dd></div>}
            </dl>
          </div>

          {artifacts.length > 0 && (
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                <CalendarDays className="size-4 text-brand" /> Artifacts
              </h2>
              <ul className="mt-3 space-y-2 rounded-2xl border border-border bg-surface/35 p-4">
                {artifacts.map((a) => (
                  <li key={a.id} className="text-sm">
                    <p className="font-medium capitalize text-foreground">{artifactLabel(a.artifactType)}</p>
                    <p className="truncate text-xs text-faint">{a.path}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-2xl border border-border bg-surface/35 p-4 text-sm text-muted">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <MapPin className="size-4 text-brand" /> Decision cue
            </p>
            <p className="mt-2">If the stored score and metadata look promising, open the live posting first. If it still fits, evaluate it to generate the full report and tailored artifacts.</p>
          </div>
        </aside>
      </section>
    </div>
  );
}
