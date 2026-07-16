"use client";

import { useEffect, useState } from "react";
import { companyDomain, companyInitials, monogramHue } from "@/lib/company";
import { cn } from "@/lib/cn";

const CONFIG_KEY = "career-ops:config";
const LOGO_CACHE_KEY = "career-ops:logo-cache:v1";
const LOGO_CACHE_TTL = 180 * 24 * 60 * 60 * 1000;

type LogoCacheEntry = { ok: boolean; ts: number };

function readLogoCache(domain: string): LogoCacheEntry | null {
  try {
    const raw = localStorage.getItem(LOGO_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : null;
    const entry = cache?.[domain] as LogoCacheEntry | undefined;
    if (!entry || Date.now() - entry.ts > LOGO_CACHE_TTL) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeLogoCache(domain: string, ok: boolean) {
  try {
    const raw = localStorage.getItem(LOGO_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[domain] = { ok, ts: Date.now() };
    localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota / private mode */
  }
}

// A small company mark: the real favicon on a white tile when logos are enabled
// and resolvable, otherwise a deterministic colored monogram. The monogram is
// the always-rendered base layer (SSR-safe + offline floor); the logo fades in
// on top once loaded, and any failure (404/offline/disabled) just leaves the
// monogram showing. See lib/company.ts + /api/logo.
export function CompanyLogo({
  name,
  size = 20,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const [enabled, setEnabled] = useState(false); // monogram-only until config known
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [knownOk, setKnownOk] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      const v = raw ? JSON.parse(raw) : null;
      setEnabled(v?.logos !== false); // default ON unless explicitly disabled
    } catch {
      setEnabled(true);
    }
  }, []);

  const domain = companyDomain(name);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setKnownOk(false);
    if (!domain) return;
    const cached = readLogoCache(domain);
    if (!cached) return;
    if (cached.ok) setKnownOk(true);
    else setFailed(true);
  }, [domain]);

  const hue = monogramHue(name);
  const radius = Math.max(4, Math.round(size * 0.28));
  const showImg = enabled && !!domain && !failed;

  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-black/5 dark:ring-white/10", className)}
      style={{ width: size, height: size, borderRadius: radius }}
      aria-hidden="true"
    >
      <span
        className="absolute inset-0 flex items-center justify-center font-semibold leading-none text-white"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 28) % 360} 52% 38%))`,
          fontSize: Math.round(size * 0.42),
          letterSpacing: "-0.02em",
        }}
      >
        {companyInitials(name)}
      </span>
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/logo?domain=${encodeURIComponent(domain!)}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoaded(true);
            if (domain) writeLogoCache(domain, true);
          }}
          onError={() => {
            setFailed(true);
            if (domain) writeLogoCache(domain, false);
          }}
          className="absolute inset-0 h-full w-full bg-white object-contain transition-opacity duration-200"
          style={{ opacity: loaded || knownOk ? 1 : 0, padding: Math.max(1, Math.round(size * 0.1)) }}
        />
      )}
    </span>
  );
}
