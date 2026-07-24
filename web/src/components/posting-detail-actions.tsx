"use client";

import { useRouter } from "next/navigation";
import { Archive, BookmarkCheck, ExternalLink, Loader2, RotateCcw, Sparkles } from "lucide-react";
import type { PipelinePosting } from "@/lib/career-ops";
import { useJobs } from "@/components/jobs/job-store";
import { Button } from "@/components/ui/button";

export function PostingDetailActions({ posting }: { posting: PipelinePosting }) {
  const router = useRouter();
  const { jobs, startJob } = useJobs();
  const runningEval = jobs.find((j) => j.kind === "evaluate" && j.input === posting.url && j.status === "running");
  const isExpired = posting.status === "expired" || posting.pipelineState === "expired";

  const movePosting = async (state: "pending" | "shortlisted" | "discarded", restore = false) => {
    const res = await fetch("/api/postings/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: posting.id, url: posting.url, state, restore }),
    });
    if (res.ok) {
      window.dispatchEvent(new CustomEvent("co-pipeline-changed"));
      router.refresh();
    }
  };

  const evaluate = () => {
    const id = startJob({
      title: `Evaluate · ${posting.company}`,
      subtitle: posting.role,
      kind: "evaluate",
      input: posting.url,
      page: `/postings/${posting.id}`,
    });
    if (id) router.push(`/jobs/${id}`);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={posting.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center gap-2 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors duration-100 hover:bg-brand-200"
      >
        Open posting <ExternalLink className="size-4" />
      </a>
      {isExpired ? (
        <Button type="button" variant="secondary" onClick={() => void movePosting("pending", true)}>
          <RotateCcw className="size-4" /> Restore
        </Button>
      ) : (
        <>
          <Button type="button" variant="secondary" onClick={evaluate} disabled={!!runningEval}>
            {runningEval ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {runningEval ? "Evaluating" : "Evaluate"}
          </Button>
          {posting.pipelineState !== "shortlisted" && (
            <Button type="button" variant="outline" onClick={() => void movePosting("shortlisted")}>
              <BookmarkCheck className="size-4" /> Shortlist
            </Button>
          )}
          {posting.pipelineState !== "discarded" && (
            <Button type="button" variant="ghost" onClick={() => void movePosting("discarded")}>
              <Archive className="size-4" /> Discard
            </Button>
          )}
        </>
      )}
    </div>
  );
}
