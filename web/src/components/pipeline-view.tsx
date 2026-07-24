"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, ChevronsUpDown, X, Compass, ArrowRight, MapPin, DollarSign, Clock3, ExternalLink, BookmarkCheck, Archive } from "lucide-react";
import type { Application, InboxJob, PipelinePosting } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { canonStatus, scoreNum, scoreTone, statusDot } from "@/lib/format";
import { cn } from "@/lib/cn";

// INBOX is the active triage queue; SHORTLIST is the saved-for-review stage.
// APPLICATIONS and the status tabs are the evaluated tracker.
const TABS = [
  "INBOX",
  "SHORTLIST",
  "APPLICATIONS",
  "EVALUATED",
  "APPLIED",
  "RESPONDED",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "DISCARDED",
  "SKIP",
  "EXPIRED",
] as const;
type Tab = (typeof TABS)[number];

const SORT_KEYS = ["company", "role", "score", "status", "date", "location", "pay", "last"] as const;
type SortKey = (typeof SORT_KEYS)[number];

const WORK_MODE_OPTIONS = ["Remote", "RemoteFlex", "Hybrid", "Full"] as const;

const SORT_LABELS: Record<SortKey, string> = {
  company: "company",
  role: "role",
  score: "score",
  status: "status",
  date: "date",
  location: "mobility",
  pay: "pay",
  last: "last",
};

function arrangementLabel(mode?: string): string {
  if (mode === "Remote") return "Remote eligible";
  if (mode === "RemoteFlex") return "Remote-flex";
  if (mode === "Hybrid") return "Hybrid / relocate";
  if (mode === "Full") return "On-site / relocate";
  return "Unknown";
}

function locationText(app: Application): string {
  return [app.locationRegion, app.workMode ? arrangementLabel(app.workMode) : "", app.location && app.location !== app.locationRegion ? app.location : ""].filter(Boolean).join(" · ") || "—";
}

function postingLocationText(posting: PipelinePosting): string {
  return [posting.locationRegion, posting.workMode ? arrangementLabel(posting.workMode) : "", posting.location && posting.location !== posting.locationRegion ? posting.location : ""].filter(Boolean).join(" · ") || "—";
}

function dateValue(date?: string): number {
  const t = date ? Date.parse(`${date}T00:00:00`) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function PipelineView({
  applications,
  inbox,
  postings,
}: {
  applications: Application[];
  inbox: InboxJob[];
  postings: PipelinePosting[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // The URL is the SINGLE source of truth for tab/min/sort/dir, so the home stat
  // tiles' deep links AND the assistant's filterPipeline/navigate actions drive
  // the table identically (no useState mirror → no desync).
  const pTab = (params.get("tab") ?? "").toUpperCase();
  const normalizedTab = pTab === "ALL" ? "APPLICATIONS" : pTab;
  const tab: Tab = (TABS as readonly string[]).includes(normalizedTab) ? (normalizedTab as Tab) : "INBOX";
  const pMin = parseFloat(params.get("min") ?? "");
  const minFilter: number | null = Number.isFinite(pMin) ? pMin : null;
  const pPay = parseFloat(params.get("pay") ?? "");
  const payFilter: number | null = Number.isFinite(pPay) ? pPay : null;
  const pMode = params.get("mode") ?? "";
  const modeFilter = (WORK_MODE_OPTIONS as readonly string[]).includes(pMode) ? pMode : "";
  const pSort = params.get("sort") ?? "";
  const sortKey: SortKey = (SORT_KEYS as readonly string[]).includes(pSort) ? (pSort as SortKey) : "score";
  const sort = { key: sortKey, dir: (params.get("dir") === "1" ? 1 : -1) as 1 | -1 };

  // Search stays LOCAL for snappy typing; seeded from the URL and re-synced only
  // when the URL's q changes (i.e. the assistant set it) — never per keystroke.
  const [q, setQ] = useState(params.get("q") ?? "");
  const lastUrlQ = useRef(params.get("q") ?? "");
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setQ(urlQ);
    }
  }, [params]);

  const setParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") sp.delete(k);
        else sp.set(k, String(v));
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname],
  );

  // Pending + deduped by URL (pipeline.md can list the same posting twice) so the
  // header count, the tab count and the triage list all agree on one number.
  const pendingInbox = useMemo(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      if (j.done || seen.has(j.url)) continue;
      if (j.pipelineState && j.pipelineState !== "pending") continue;
      seen.add(j.url);
      out.push(j);
    }
    return out;
  }, [inbox]);

  const shortlistedInbox = useMemo(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      if (j.done || seen.has(j.url)) continue;
      if (j.pipelineState !== "shortlisted") continue;
      seen.add(j.url);
      out.push(j);
    }
    return out;
  }, [inbox]);

  const expiredInbox = useMemo(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      if (j.done || seen.has(j.url)) continue;
      if (j.pipelineState !== "expired") continue;
      seen.add(j.url);
      out.push(j);
    }
    return out;
  }, [inbox]);

  const pendingPostings = useMemo(
    () => postings.filter((p) => p.pipelineState === "pending" && p.status !== "expired"),
    [postings],
  );
  const shortlistedPostings = useMemo(
    () => postings.filter((p) => p.pipelineState === "shortlisted" && p.status !== "expired"),
    [postings],
  );
  const expiredPostings = useMemo(
    () => postings.filter((p) => p.pipelineState === "expired" || p.status === "expired"),
    [postings],
  );
  const discardedPostings = useMemo(
    () => postings.filter((p) => p.pipelineState === "discarded" && p.status !== "expired"),
    [postings],
  );

  const filteredPostings = useMemo(() => {
    let rows: PipelinePosting[];
    if (tab === "INBOX") rows = pendingPostings;
    else if (tab === "SHORTLIST") rows = shortlistedPostings;
    else if (tab === "DISCARDED") rows = discardedPostings;
    else if (tab === "EXPIRED") rows = expiredPostings;
    else return [];
    if (minFilter != null) {
      rows = rows.filter((r) => {
        const n = scoreNum(r.score);
        return !Number.isNaN(n) && n >= minFilter;
      });
    }
    if (payFilter != null) rows = rows.filter((r) => (r.payMax ?? 0) >= payFilter);
    if (modeFilter) rows = rows.filter((r) => r.workMode === modeFilter);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((r) =>
        `${r.company} ${r.role} ${r.locationRegion ?? ""} ${r.location ?? ""} ${r.workMode ?? ""} ${r.payRange ?? ""} ${r.compensation ?? ""} ${r.pipelineState} ${r.status} ${r.score} ${r.notes} ${r.source ?? ""}`
          .toLowerCase()
          .includes(needle),
      );
    }
    return [...rows].sort((a, b) => {
      if (sort.key === "score") {
        const an = scoreNum(a.score);
        const bn = scoreNum(b.score);
        const av = Number.isNaN(an) ? -Infinity : an;
        const bv = Number.isNaN(bn) ? -Infinity : bn;
        return (av - bv) * sort.dir;
      }
      if (sort.key === "pay") return ((a.payMax ?? 0) - (b.payMax ?? 0)) * sort.dir;
      if (sort.key === "last") return (dateValue(a.lastContact) - dateValue(b.lastContact)) * sort.dir;
      if (sort.key === "location") {
        const rank = (mode?: string) => (mode === "Remote" ? 0 : mode === "RemoteFlex" ? 1 : mode === "Hybrid" ? 2 : mode === "Full" ? 3 : 4);
        const modeDelta = rank(a.workMode) - rank(b.workMode);
        if (modeDelta !== 0) return modeDelta * sort.dir;
        return (a.locationRegion || a.location || "").localeCompare(b.locationRegion || b.location || "") * sort.dir;
      }
      if (sort.key === "status") return `${a.pipelineState} ${a.status}`.localeCompare(`${b.pipelineState} ${b.status}`) * sort.dir;
      if (sort.key === "date") return (a.date || "").localeCompare(b.date || "") * sort.dir;
      return (a[sort.key] || "").localeCompare(b[sort.key] || "") * sort.dir;
    });
  }, [pendingPostings, shortlistedPostings, discardedPostings, expiredPostings, tab, q, sort, minFilter, payFilter, modeFilter]);

  const filtered = useMemo(() => {
    if (tab === "INBOX" || tab === "SHORTLIST" || tab === "DISCARDED" || tab === "EXPIRED") return [];
    let rows = applications;
    if (tab !== "APPLICATIONS") rows = rows.filter((r) => canonStatus(r.status).includes(tab));
    if (minFilter != null) {
      rows = rows.filter((r) => {
        const n = scoreNum(r.score);
        return !Number.isNaN(n) && n >= minFilter;
      });
    }
    if (payFilter != null) rows = rows.filter((r) => (r.payMax ?? 0) >= payFilter);
    if (modeFilter) rows = rows.filter((r) => r.workMode === modeFilter);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((r) => `${r.company} ${r.role} ${r.locationRegion ?? ""} ${r.location ?? ""} ${r.workMode ?? ""} ${r.payRange ?? ""} ${r.notes}`.toLowerCase().includes(needle));
    }
    return [...rows].sort((a, b) => {
      if (sort.key === "score") {
        const an = scoreNum(a.score);
        const bn = scoreNum(b.score);
        const av = Number.isNaN(an) ? -Infinity : an;
        const bv = Number.isNaN(bn) ? -Infinity : bn;
        return (av - bv) * sort.dir;
      }
      if (sort.key === "pay") return ((a.payMax ?? 0) - (b.payMax ?? 0)) * sort.dir;
      if (sort.key === "last") return (dateValue(a.lastContact) - dateValue(b.lastContact)) * sort.dir;
      if (sort.key === "location") {
        const rank = (mode?: string) => (mode === "Remote" ? 0 : mode === "RemoteFlex" ? 1 : mode === "Hybrid" ? 2 : mode === "Full" ? 3 : 4);
        const modeDelta = rank(a.workMode) - rank(b.workMode);
        if (modeDelta !== 0) return modeDelta * sort.dir;
        return (a.locationRegion || a.location || "").localeCompare(b.locationRegion || b.location || "") * sort.dir;
      }
      return (a[sort.key] || "").localeCompare(b[sort.key] || "") * sort.dir;
    });
  }, [applications, tab, q, sort, minFilter, payFilter, modeFilter]);

  const hasMetadataFilters = minFilter != null || payFilter != null || modeFilter;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 max-sm:pb-24">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Pipeline</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="tabular-nums">{postings.length ? pendingPostings.length : pendingInbox.length}</span> in inbox ·{" "}
            <span className="tabular-nums">{postings.length ? shortlistedPostings.length : shortlistedInbox.length}</span> shortlisted ·{" "}
            <span className="tabular-nums">{discardedPostings.length}</span> discarded ·{" "}
            <span className="tabular-nums">{applications.length}</span> tracked
          </p>
        </div>
        <div className="relative w-72 max-w-[44vw]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, role, notes…"
            className="w-full rounded-md border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </div>
      </div>

      {/* tabs */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => {
          const count =
            t === "INBOX"
              ? postings.length ? pendingPostings.length : pendingInbox.length
              : t === "SHORTLIST"
                ? postings.length ? shortlistedPostings.length : shortlistedInbox.length
              : t === "EXPIRED"
                ? postings.length ? expiredPostings.length : expiredInbox.length
              : t === "DISCARDED"
                ? discardedPostings.length
              : t === "APPLICATIONS"
                ? applications.length
                : applications.filter((r) => canonStatus(r.status).includes(t)).length;
          return (
            <button
              key={t}
              onClick={() => setParams({ tab: t === "INBOX" ? null : t })}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === t
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {t} <span className="text-faint tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Filters:</span>
          {minFilter != null && (
            <button
              type="button"
              onClick={() => setParams({ min: null })}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
              title="Clear score filter"
            >
              score ≥ {minFilter.toFixed(1)}
              <X className="size-3" />
            </button>
          )}
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1 text-xs text-muted">
            <span>min score</span>
            <input
              value={minFilter ?? ""}
              onChange={(e) => setParams({ min: e.target.value ? Number(e.target.value) : null })}
              type="number"
              min={0}
              max={5}
              step={0.1}
              placeholder="any"
              className="w-14 bg-transparent text-foreground outline-none placeholder:text-faint"
            />
          </label>
          <div className="inline-flex rounded-lg border border-border bg-surface/40 p-0.5">
            {WORK_MODE_OPTIONS.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setParams({ mode: modeFilter === mode ? null : mode })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  modeFilter === mode ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
                )}
              >
                {arrangementLabel(mode)}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1 text-xs text-muted">
            <DollarSign className="size-3.5 text-faint" />
            <span>min pay</span>
            <input
              value={payFilter ?? ""}
              onChange={(e) => setParams({ pay: e.target.value ? Number(e.target.value) : null })}
              type="number"
              min={0}
              step={10000}
              placeholder="any"
              className="w-20 bg-transparent text-foreground outline-none placeholder:text-faint"
            />
          </label>
          {hasMetadataFilters && (
            <button
              type="button"
              onClick={() => setParams({ min: null, pay: null, mode: null })}
              className="inline-flex items-center gap-1 rounded-full px-2 text-xs text-faint transition-colors hover:text-foreground"
            >
              <X className="size-3" /> Clear
            </button>
          )}
      </div>

      {tab === "INBOX" ? (
        postings.length > 0 ? (
          filteredPostings.length > 0 ? (
            <PostingsTable
              postings={filteredPostings}
              sort={sort}
              onSort={(key) => setParams({ sort: key, dir: sort.key === key ? sort.dir * -1 : key === "location" ? 1 : -1 })}
              onChanged={() => router.refresh()}
            />
          ) : (
            <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
              <p className="font-display text-lg">No inbox matches</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Try a lower score floor, clear pay, or broaden the search.</p>
            </div>
          )
        ) : pendingInbox.length > 0 ? (
          <LegacyInboxTable postings={pendingInbox} />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : tab === "SHORTLIST" ? (
        postings.length > 0 ? (
          filteredPostings.length > 0 ? (
            <PostingsTable
              postings={filteredPostings}
              sort={sort}
              onSort={(key) => setParams({ sort: key, dir: sort.key === key ? sort.dir * -1 : key === "location" ? 1 : -1 })}
              onChanged={() => router.refresh()}
            />
          ) : (
            <InboxEmpty count={0} filtered={false} />
          )
        ) : shortlistedInbox.length > 0 ? (
          <LegacyInboxTable postings={shortlistedInbox} />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : tab === "DISCARDED" ? (
        filteredPostings.length > 0 ? (
          <PostingsTable
            postings={filteredPostings}
            sort={sort}
            onSort={(key) => setParams({ sort: key, dir: sort.key === key ? sort.dir * -1 : key === "location" ? 1 : -1 })}
            onChanged={() => router.refresh()}
          />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : tab === "EXPIRED" ? (
        postings.length > 0 ? (
          filteredPostings.length > 0 ? (
            <PostingsTable
              postings={filteredPostings}
              sort={sort}
              onSort={(key) => setParams({ sort: key, dir: sort.key === key ? sort.dir * -1 : key === "location" ? 1 : -1 })}
              onChanged={() => router.refresh()}
            />
          ) : (
            <InboxEmpty count={0} filtered={false} />
          )
        ) : expiredInbox.length > 0 ? (
          <ExpiredPostingsTable postings={expiredInbox} />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : filtered.length > 0 ? (
        /* ── Tracker table ── */
        <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                {SORT_KEYS.map((k) => (
                  <th
                    key={k}
                    className="cursor-pointer select-none px-4 py-2.5 font-medium hover:text-foreground"
                    onClick={() => setParams({ sort: k, dir: sort.key === k ? sort.dir * -1 : k === "location" ? 1 : -1 })}
                  >
                    <span className="inline-flex items-center gap-1">
                      {SORT_LABELS[k]}
                      <ChevronsUpDown className="size-3" />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r, i) => (
                <tr key={`${r.n}-${i}`} className="group transition-colors hover:bg-surface/40">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/pipeline/${r.n}`} className="flex items-center gap-2.5 transition-colors group-hover:text-brand">
                      <CompanyLogo name={r.company} size={20} />
                      {r.company}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <Link href={`/pipeline/${r.n}`}>{r.role}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={scoreTone(r.score)}>{r.score || "—"}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(r.status))} />
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-faint tabular-nums">{r.date}</td>
                  <td className="px-4 py-3 text-muted">
                    <span className="inline-flex max-w-[180px] items-center gap-1.5">
                      <MapPin className="size-3.5 shrink-0 text-faint" />
                      <span className="truncate">{locationText(r)}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {r.payRange ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="tabular-nums">{r.payRange}</span>
                        {r.paySource && <span className="rounded bg-surface-hover px-1 py-px text-[10px] uppercase text-faint">{r.paySource}</span>}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-faint">
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      <Clock3 className="size-3.5" />
                      {r.lastContact || "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
          <p className="font-display text-lg">No matches</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Try a different tab or clear the search.</p>
        </div>
      )}
    </div>
  );
}

function LegacyInboxTable({ postings }: { postings: InboxJob[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
          <tr>
            <th className="px-4 py-2.5 font-medium">company</th>
            <th className="px-4 py-2.5 font-medium">role</th>
            <th className="px-4 py-2.5 font-medium">score</th>
            <th className="px-4 py-2.5 font-medium">mobility</th>
            <th className="px-4 py-2.5 font-medium">source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {postings.map((p) => (
            <tr key={p.url} className="transition-colors hover:bg-surface/40">
              <td className="px-4 py-3 font-medium">
                <div className="flex items-center gap-2.5">
                  <CompanyLogo name={p.company} size={20} />
                  {p.company}
                </div>
              </td>
              <td className="px-4 py-3">
                <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-foreground hover:text-brand">
                  {p.role}
                </a>
              </td>
              <td className="px-4 py-3"><Badge tone={scoreTone(p.score ?? "")}>{p.score || "—"}</Badge></td>
              <td className="px-4 py-3 text-muted">{p.location || "—"}</td>
              <td className="px-4 py-3 text-muted">{p.source || "pipeline"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pipelineStateTone(state: string): "good" | "warn" | "bad" | "muted" {
  if (state === "shortlisted") return "good";
  if (state === "pending") return "warn";
  if (state === "discarded" || state === "expired") return "bad";
  return "muted";
}

function compactSource(source?: string): string {
  if (!source) return "scanner";
  return source.replace(/-api$/i, "").replaceAll("-", " ");
}

function PostingsTable({
  postings,
  sort,
  onSort,
  onChanged,
}: {
  postings: PipelinePosting[];
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (key: SortKey) => void;
  onChanged: () => void;
}) {
  const movePosting = async (posting: PipelinePosting, state: "pending" | "shortlisted" | "discarded") => {
    const res = await fetch("/api/postings/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: posting.id, url: posting.url, state }),
    });
    if (res.ok) {
      window.dispatchEvent(new CustomEvent("co-pipeline-changed"));
      onChanged();
    }
  };

  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[1120px] text-sm">
        <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
          <tr>
            {[
              ["company", "company"],
              ["role", "role"],
              ["score", "score"],
              ["status", "state"],
              ["date", "first seen"],
              ["location", "mobility"],
              ["pay", "pay"],
            ].map(([key, label]) => (
              <th
                key={key}
                className="cursor-pointer select-none px-4 py-2.5 font-medium hover:text-foreground"
                onClick={() => onSort(key as SortKey)}
              >
                <span className="inline-flex items-center gap-1">
                  {label}
                  <ChevronsUpDown className={cn("size-3", sort.key === key && "text-brand")} />
                </span>
              </th>
            ))}
            <th className="px-4 py-2.5 font-medium">source</th>
            <th className="px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {postings.map((p) => (
            <tr key={p.id || p.url} className="group transition-colors hover:bg-surface/40">
              <td className="px-4 py-3 font-medium">
                <div className="flex min-w-0 items-center gap-2.5">
                  <CompanyLogo name={p.company} size={20} />
                  <span className="truncate">{p.company}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-muted">
                <Link href={`/postings/${p.id}`} className="inline-flex max-w-[280px] items-center gap-1.5 text-foreground transition-colors hover:text-brand">
                  <span className="truncate">{p.role}</span>
                </Link>
                <a href={p.url} target="_blank" rel="noreferrer" title="Open live posting" className="ml-1.5 inline-flex align-middle text-faint transition-colors hover:text-brand">
                  <ExternalLink className="size-3.5 shrink-0 text-faint" />
                </a>
                {p.notes && <p className="mt-0.5 max-w-[300px] truncate text-xs text-faint">{p.notes}</p>}
              </td>
              <td className="px-4 py-3">
                <Badge tone={scoreTone(p.score)}>{p.score || "—"}</Badge>
                {p.deepFitScore != null && p.deepFitScore > 0 && (
                  <p className="mt-1 text-[11px] text-faint">deep fit {p.deepFitScore.toFixed(1)}</p>
                )}
              </td>
              <td className="px-4 py-3">
                <Badge tone={pipelineStateTone(p.pipelineState)} className="capitalize">{p.pipelineState || "pending"}</Badge>
                {p.status && p.status !== "active" && <p className="mt-1 text-[11px] text-faint">{p.status}</p>}
              </td>
              <td className="px-4 py-3 text-faint tabular-nums">{p.date || "—"}</td>
              <td className="px-4 py-3 text-muted">
                <span className="inline-flex max-w-[190px] items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{postingLocationText(p)}</span>
                </span>
              </td>
              <td className="px-4 py-3 text-muted">
                {p.payRange ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="tabular-nums">{p.payRange}</span>
                    {p.paySource && <span className="rounded bg-surface-hover px-1 py-px text-[10px] uppercase text-faint">{p.paySource}</span>}
                  </span>
                ) : p.compensation ? (
                  <span className="inline-block max-w-[180px] truncate text-faint">{p.compensation}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="px-4 py-3 capitalize text-muted">{compactSource(p.source)}</td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1">
                  {p.pipelineState !== "shortlisted" && (
                    <button
                      type="button"
                      onClick={() => void movePosting(p, "shortlisted")}
                      title="Move to shortlist"
                      className="inline-flex items-center justify-center rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-brand"
                    >
                      <BookmarkCheck className="size-4" />
                    </button>
                  )}
                  {p.pipelineState !== "discarded" && (
                    <button
                      type="button"
                      onClick={() => void movePosting(p, "discarded")}
                      title="Discard posting"
                      className="inline-flex items-center justify-center rounded-md p-1.5 text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      <Archive className="size-4" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpiredPostingsTable({ postings }: { postings: InboxJob[] }) {
  const restore = async (posting: InboxJob) => {
    const res = await fetch("/api/postings/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: posting.id, url: posting.url, state: "pending" }),
    });
    if (res.ok) window.dispatchEvent(new CustomEvent("co-pipeline-changed"));
  };

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
          <tr>
            <th className="px-4 py-2.5 font-medium">company</th>
            <th className="px-4 py-2.5 font-medium">role</th>
            <th className="px-4 py-2.5 font-medium">source</th>
            <th className="px-4 py-2.5 font-medium">first seen</th>
            <th className="px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {postings.map((p) => (
            <tr key={p.url} className="border-t border-border/70">
              <td className="px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <CompanyLogo name={p.company} />
                  <span className="truncate font-medium text-foreground">{p.company}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-foreground hover:text-brand">
                  {p.role}
                </a>
                {p.location && <p className="mt-0.5 text-xs text-faint">{p.location}</p>}
              </td>
              <td className="px-4 py-3 text-muted">{p.source || "scanner"}</td>
              <td className="px-4 py-3 text-muted">{p.postedAt || "unknown"}</td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => void restore(p)}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand"
                >
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Empty inbox. Self-sufficient for the mainstream user (a primary in-web action),
// honest for devs (the CLI/file path stays, demoted to progressive transparency).
function InboxEmpty({ count, filtered }: { count: number; filtered: boolean }) {
  if (filtered) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
        <p className="font-display text-lg">No matches</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Clear the search to see the full inbox.</p>
      </div>
    );
  }
  return (
    <div className="dot-bg mt-4 overflow-hidden rounded-2xl border border-border bg-surface/50 bg-origin-border bg-gradient-to-tr from-brand/10 via-transparent to-transparent shadow-lg">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-5 py-3">
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="ml-3 font-mono text-xs tracking-wide text-muted">career-ops · inbox</span>
      </div>
      <div className="px-6 py-10 text-center">
        <p className="font-display text-lg">
          Your <span className="text-brand">inbox</span> is empty.
        </p>
        {count > 0 ? (
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">Nothing pending right now.</p>
        ) : (
          <>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">Find roles that match your CV — free, no tokens spent.</p>
            <Link
              href="/explore?run=1"
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-sm transition-all duration-200 hover:bg-brand-200 hover:-translate-y-0.5 hover:shadow-md"
            >
              <Compass className="size-4" /> Run your first free scan <ArrowRight className="size-4" />
            </Link>
            <p className="mx-auto mt-4 max-w-sm text-xs text-muted">
              Prefer the terminal? Run <code className="rounded bg-surface-hover px-1 py-0.5 font-mono">career-ops scan</code>, or add job URLs to{" "}
              <code className="rounded bg-surface-hover px-1 py-0.5 font-mono">data/pipeline.md</code>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
