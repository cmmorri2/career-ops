"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Eye, Loader2, Pin, Search, SlidersHorizontal, ThumbsDown, Wand2 } from "lucide-react";
import type { RoleDiscoveryCluster } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const FILTERS = ["all", "new", "review", "watching", "promoted", "ignored"] as const;
type Filter = (typeof FILTERS)[number];

function scoreTone(score?: number): "good" | "warn" | "bad" | "muted" {
  if (score == null) return "muted";
  if (score >= 3.8) return "good";
  if (score >= 3.0) return "warn";
  return "bad";
}

function coverageTone(status: string): "good" | "warn" | "muted" {
  if (status === "covered") return "good";
  if (status === "under_covered") return "warn";
  return "muted";
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function coverageLabel(status: string): string {
  if (status === "covered") return "Already in system";
  if (status === "under_covered") return "New title variant";
  return "Coverage unknown";
}

function statusTone(state: string): "good" | "warn" | "bad" | "muted" {
  if (state === "shortlisted" || state === "applied") return "good";
  if (state === "pending") return "warn";
  if (state === "discarded" || state === "expired") return "bad";
  return "muted";
}

type SearchFormState = {
  keywords: string;
  negative: string;
  sinceDays: number;
  limitPerAts: number;
  ats: string[];
};

const ATS_OPTIONS = ["greenhouse", "ashby", "lever", "workday"];

export function RoleDiscoveryView({ clusters }: { clusters: RoleDiscoveryCluster[] }) {
  const [rows, setRows] = useState(clusters);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [runningSearchId, setRunningSearchId] = useState<number | null>(null);
  const [searchForms, setSearchForms] = useState<Record<number, SearchFormState>>({});

  const visible = useMemo(() => {
    const source = filter === "all" ? rows : rows.filter((row) => row.reviewStatus === filter);
    return [...source].sort((a, b) => {
      const statusRank = (status: string) => (status === "new" ? 0 : status === "review" ? 1 : status === "watching" ? 2 : status === "promoted" ? 3 : 4);
      const sr = statusRank(a.reviewStatus) - statusRank(b.reviewStatus);
      if (sr !== 0) return sr;
      const cr = (a.coverageStatus === "under_covered" ? 0 : 1) - (b.coverageStatus === "under_covered" ? 0 : 1);
      if (cr !== 0) return cr;
      return (b.bestScore ?? 0) - (a.bestScore ?? 0);
    });
  }, [rows, filter]);

  async function updateCluster(id: number, status: string) {
    setBusyId(id);
    try {
      const res = await fetch("/api/role-discovery/cluster", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) throw new Error(await res.text());
      setRows((current) => current.map((row) => row.id === id ? { ...row, reviewStatus: status } : row));
    } finally {
      setBusyId(null);
    }
  }

  function defaultSearchForm(cluster: RoleDiscoveryCluster, searchId: number): SearchFormState {
    const search = cluster.searches.find((item) => item.id === searchId);
    const base = `${cluster.displayRole} ${search?.query ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !["jobs", "remote", "united", "states", "or"].includes(token));
    const preferred = base.filter((token) => ["ai", "agentic", "agents", "genai", "product", "platform", "solutions", "solution", "architect", "consultant", "consulting", "technical", "deployed", "workflow", "transformation", "anaplan"].includes(token));
    return {
      keywords: Array.from(new Set(preferred)).join(", "),
      negative: "",
      sinceDays: 14,
      limitPerAts: 25,
      ats: ["greenhouse", "ashby"],
    };
  }

  function updateSearchForm(searchId: number, patch: Partial<SearchFormState>) {
    setSearchForms((current) => ({
      ...current,
      [searchId]: { ...current[searchId], ...patch } as SearchFormState,
    }));
  }

  async function runSearch(cluster: RoleDiscoveryCluster, searchId: number) {
    const form = searchForms[searchId] ?? defaultSearchForm(cluster, searchId);
    setRunningSearchId(searchId);
    try {
      const res = await fetch("/api/role-discovery/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          searchId,
          filters: {
            positive: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
            negative: form.negative.split(",").map((item) => item.trim()).filter(Boolean),
            sinceDays: form.sinceDays,
            limitPerAts: form.limitPerAts,
            ats: form.ats,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Search failed.");
      setRows((current) =>
        current.map((row) => {
          if (row.id !== cluster.id) return row;
          return {
            ...row,
            searches: row.searches.map((search) =>
              search.id === searchId
                ? {
                    ...search,
                    status: "searched",
                    resultCount: Number(data.count ?? 0),
                    results: Array.isArray(data.offers)
                      ? data.offers.map((offer: Record<string, unknown>, index: number) => ({
                          id: -Date.now() - index,
                          searchId,
                          clusterId: cluster.id,
                          url: String(offer.url ?? ""),
                          company: String(offer.company ?? ""),
                          title: String(offer.title ?? ""),
                          location: typeof offer.location === "string" ? offer.location : undefined,
                          postedAt: typeof offer.postedAt === "string" ? offer.postedAt : undefined,
                          ats: typeof offer.ats === "string" ? offer.ats : undefined,
                          source: "role-discovery-search",
                          matchedKeyword: typeof offer.matchedKeyword === "string" ? offer.matchedKeyword : undefined,
                          note: typeof offer.note === "string" ? offer.note : undefined,
                          reviewStatus: "new",
                        }))
                      : search.results,
                  }
                : search,
            ),
          };
        }),
      );
    } finally {
      setRunningSearchId(null);
    }
  }

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: rows.length };
    for (const row of rows) out[row.reviewStatus] = (out[row.reviewStatus] ?? 0) + 1;
    return out;
  }, [rows]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 max-sm:pb-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Role Discovery</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            LinkedIn recommendations become reviewable role clusters here before they touch the authoritative pipeline.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <div>
            <div className="text-xl font-semibold tabular-nums">{rows.length}</div>
            <div className="text-xs text-faint">clusters</div>
          </div>
          <div>
            <div className="text-xl font-semibold tabular-nums">{rows.reduce((sum, row) => sum + row.evidenceCount, 0)}</div>
            <div className="text-xs text-faint">leads</div>
          </div>
          <div>
            <div className="text-xl font-semibold tabular-nums">{rows.filter((row) => row.coverageStatus === "under_covered").length}</div>
            <div className="text-xs text-faint">under-covered</div>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {FILTERS.map((item) => (
          <button
            key={item}
            onClick={() => setFilter(item)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs font-medium capitalize transition-colors",
              filter === item ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {statusLabel(item)} <span className="text-faint tabular-nums">{counts[item] ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="mt-8 rounded-md border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground">No role-discovery rows yet</h2>
          <p className="mt-2 text-sm text-muted">
            Run <code className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-xs">npm run db:role-discovery</code> after fetching LinkedIn email leads.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {visible.map((cluster) => {
            const sampleLeads = cluster.leads.slice(0, 5);
            const search = cluster.searches[0];
            return (
              <section key={cluster.id} className="rounded-md border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">{cluster.displayRole}</h2>
                      <Badge tone={coverageTone(cluster.coverageStatus)}>{coverageLabel(cluster.coverageStatus)}</Badge>
                      <Badge tone={scoreTone(cluster.bestScore)}>{cluster.bestScore?.toFixed(1) ?? "—"}/5</Badge>
                      <Badge>{statusLabel(cluster.reviewStatus)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {cluster.evidenceCount} discovery lead{cluster.evidenceCount === 1 ? "" : "s"} · {cluster.linkedinCount} from LinkedIn · {cluster.pipelineMatchCount} normalized pipeline matches · {cluster.applicationMatchCount} normalized application matches
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone="warn">active {cluster.pipelineActiveCount}</Badge>
                      <Badge tone="good">shortlisted {cluster.pipelineShortlistedCount}</Badge>
                      <Badge tone="bad">discarded {cluster.pipelineDiscardedCount}</Badge>
                      <Badge tone="muted">expired {cluster.pipelineExpiredCount}</Badge>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={busyId === cluster.id} onClick={() => updateCluster(cluster.id, "watching")} title="Keep this role family visible for future review">
                      <Eye className="size-3.5" /> Keep Watching
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === cluster.id} onClick={() => updateCluster(cluster.id, "promoted")} title="Mark this role family as useful for ingestion decisions">
                      <Pin className="size-3.5" /> Mark Useful
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busyId === cluster.id} onClick={() => updateCluster(cluster.id, "ignored")} title="Mark this role family as not useful for ingestion decisions">
                      <ThumbsDown className="size-3.5" /> Ignore
                    </Button>
                  </div>
                </div>

                {search && (
                  <div className="mt-4 rounded-md border border-border bg-background/60 p-3">
                    {(() => {
                      const form = searchForms[search.id] ?? defaultSearchForm(cluster, search.id);
                      return (
                        <>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-faint">
                          <Search className="size-3.5" /> Suggested bounded search
                        </div>
                        <p className="mt-2 text-xs text-muted">
                          Search intent: <span className="font-mono text-foreground">{search.query}</span>
                        </p>
                        <p className="mt-1 text-xs text-muted">Status: {statusLabel(search.status)} · Stored results: {search.results.length || search.resultCount}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={runningSearchId === search.id}
                        onClick={() => runSearch(cluster, search.id)}
                        title="Run a bounded live ATS search for this role cluster"
                      >
                        {runningSearchId === search.id ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                        Run Search
                      </Button>
                    </div>
                    <div className="mt-3 grid gap-3 border-t border-border pt-3 md:grid-cols-[1fr_1fr_auto_auto]">
                      <label className="text-xs text-muted">
                        <span className="mb-1 flex items-center gap-1.5 font-medium text-faint"><SlidersHorizontal className="size-3.5" /> Keywords</span>
                        <input
                          value={form.keywords}
                          onChange={(e) => updateSearchForm(search.id, { ...form, keywords: e.target.value })}
                          className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        />
                      </label>
                      <label className="text-xs text-muted">
                        <span className="mb-1 block font-medium text-faint">Exclude</span>
                        <input
                          value={form.negative}
                          onChange={(e) => updateSearchForm(search.id, { ...form, negative: e.target.value })}
                          placeholder="sales, iam, intern"
                          className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-brand/40"
                        />
                      </label>
                      <label className="text-xs text-muted">
                        <span className="mb-1 block font-medium text-faint">Days</span>
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={form.sinceDays}
                          onChange={(e) => updateSearchForm(search.id, { ...form, sinceDays: Number(e.target.value) || 14 })}
                          className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        />
                      </label>
                      <label className="text-xs text-muted">
                        <span className="mb-1 block font-medium text-faint">Per ATS</span>
                        <input
                          type="number"
                          min={10}
                          max={150}
                          value={form.limitPerAts}
                          onChange={(e) => updateSearchForm(search.id, { ...form, limitPerAts: Number(e.target.value) || 25 })}
                          className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        />
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {ATS_OPTIONS.map((ats) => (
                        <button
                          key={ats}
                          type="button"
                          onClick={() => {
                            const next = form.ats.includes(ats) ? form.ats.filter((item) => item !== ats) : [...form.ats, ats];
                            updateSearchForm(search.id, { ...form, ats: next.length ? next : [ats] });
                          }}
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs capitalize transition-colors",
                            form.ats.includes(ats) ? "border-brand/40 bg-brand-soft text-brand" : "border-border bg-surface text-muted hover:text-foreground",
                          )}
                        >
                          {ats}
                        </button>
                      ))}
                    </div>
                        </>
                      );
                    })()}
                    {search.results.length > 0 && (
                      <div className="mt-3 border-t border-border pt-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Search-expanded roles</div>
                        <div className="grid gap-2 md:grid-cols-2">
                          {search.results.slice(0, 10).map((result) => (
                            <a
                              key={`${result.searchId}-${result.url}`}
                              href={result.url}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-md border border-border bg-surface p-3 transition-colors hover:border-brand/40"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="text-sm font-semibold text-foreground">{result.company}</div>
                                  <div className="mt-0.5 text-sm text-muted">{result.title}</div>
                                </div>
                                <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-faint" />
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                <Badge>Search-expanded</Badge>
                                {result.ats && <Badge>{result.ats}</Badge>}
                                {result.matchedKeyword && <Badge tone="warn">{result.matchedKeyword}</Badge>}
                              </div>
                              {result.location && <div className="mt-2 text-xs text-faint">{result.location}</div>}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {cluster.pipelineMatches.length > 0 && (
                  <div className="mt-4 rounded-md border border-border bg-background/40 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Existing normalized pipeline matches</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {cluster.pipelineMatches.slice(0, 6).map((match) => (
                        <a
                          key={match.id}
                          href={`/postings/${match.id}`}
                          className="rounded-md border border-border bg-surface p-3 transition-colors hover:border-brand/40"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold text-foreground">{match.company}</div>
                              <div className="mt-0.5 text-sm text-muted">{match.title}</div>
                            </div>
                            <Badge tone={statusTone(match.pipelineState)}>{match.pipelineState || match.status}</Badge>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {match.score && <Badge tone={scoreTone(Number.parseFloat(match.score))}>{match.score}</Badge>}
                            {match.location && <Badge>{match.location}</Badge>}
                          </div>
                          {match.notes && <p className="mt-2 line-clamp-2 text-xs text-faint">{match.notes}</p>}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b border-border text-xs uppercase tracking-wide text-faint">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Company</th>
                        <th className="py-2 pr-3 font-medium">Role Variant</th>
                        <th className="py-2 pr-3 font-medium">Signal</th>
                        <th className="py-2 pr-3 font-medium">Source</th>
                        <th className="py-2 pr-3 font-medium">Link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sampleLeads.map((lead) => (
                        <tr key={lead.id} className="border-b border-border/70 align-top last:border-0">
                          <td className="py-2 pr-3 font-medium text-foreground">{lead.company}</td>
                          <td className="py-2 pr-3 text-muted">
                            {lead.title}
                            <div className="mt-0.5 text-xs text-faint">{[lead.location, lead.workModel].filter(Boolean).join(" · ")}</div>
                          </td>
                          <td className="py-2 pr-3">
                            <Badge tone={scoreTone(lead.triageScore)}>{lead.triageScore?.toFixed(1) ?? "—"}</Badge>
                            {lead.triageLabel && <div className="mt-1 max-w-xs text-xs text-muted">{lead.triageLabel}</div>}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted">
                            <div className="inline-flex items-center gap-1.5">
                              <Wand2 className="size-3.5 text-faint" />
                              {lead.sourceDetail === "linkedin_email_similar" ? "LinkedIn similar" : "LinkedIn alert"}
                            </div>
                            {lead.seedTitle && <div className="mt-1 text-faint">Seed: {lead.seedTitle}{lead.seedCompany ? ` at ${lead.seedCompany}` : ""}</div>}
                          </td>
                          <td className="py-2 pr-3">
                            {lead.url ? (
                              <a className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" href={lead.url} target="_blank" rel="noreferrer">
                                Open <ExternalLink className="size-3" />
                              </a>
                            ) : (
                              <span className="text-xs text-faint">No URL</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
