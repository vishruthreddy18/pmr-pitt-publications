#!/usr/bin/env python3
"""
Scopus -> static JSON sync for the Pitt PM&R publications site.

This is the ONLY code that talks to Scopus. It reads sync/authors.json,
queries the Scopus Search API for each author ID, dedupes by EID, and writes
data/publications.json + data/meta.json.

Usage:
    export SCOPUS_API_KEY=...            # never commit this
    python sync/sync.py --test 6507050125   # key test: one author, writes nothing
    python sync/sync.py                     # full sync, writes data/ if changed
    python sync/sync.py --force             # skip the "suspiciously low count" check

Fail-safe rules: if anything goes wrong (HTTP errors after retries, an author
returning fewer records than Scopus says exist, a big drop vs. the last good
run), the script exits non-zero and does NOT touch data/.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
AUTHORS_FILE = ROOT / "sync" / "authors.json"
DATA_DIR = ROOT / "data"
PUBS_FILE = DATA_DIR / "publications.json"
META_FILE = DATA_DIR / "meta.json"

SEARCH_URL = "https://api.elsevier.com/content/search/scopus"
PAGE_SIZE = 25          # max allowed per request for view=COMPLETE
REQUEST_GAP = 0.25      # seconds between requests (~4/sec, below Scopus's per-second throttle)
MAX_RETRIES = 6
MIN_TOTAL_RATIO = 0.90  # refuse to publish if total drops below 90% of last good run


class SyncError(Exception):
    pass


# ---------------------------------------------------------------- HTTP layer

class Scopus:
    def __init__(self, api_key, insttoken=None):
        self.session = requests.Session()
        self.session.headers.update({"X-ELS-APIKey": api_key, "Accept": "application/json"})
        if insttoken:
            self.session.headers["X-ELS-Insttoken"] = insttoken
        self.view = "COMPLETE"   # downgraded to STANDARD if the key isn't entitled
        self.request_count = 0
        self.last_headers = {}

    def get(self, params):
        """GET with pacing and retries. Returns parsed JSON or raises SyncError."""
        for attempt in range(1, MAX_RETRIES + 1):
            time.sleep(REQUEST_GAP)
            try:
                r = self.session.get(SEARCH_URL, params={**params, "view": self.view}, timeout=30)
            except requests.RequestException as e:
                self._backoff(attempt, f"network error: {e}")
                continue

            self.request_count += 1
            self.last_headers = r.headers

            if r.status_code == 200:
                return r.json()

            # Not entitled to COMPLETE (typical off-campus): fall back once to STANDARD.
            if r.status_code in (401, 403) and self.view == "COMPLETE":
                print("  ! COMPLETE view not authorized for this key/network; using STANDARD")
                self.view = "STANDARD"
                continue

            if r.status_code == 429:
                # Remaining == 0 means the weekly quota is used up: retrying won't help.
                if r.headers.get("X-RateLimit-Remaining") == "0":
                    reset = r.headers.get("X-RateLimit-Reset", "?")
                    raise SyncError(f"Weekly quota exhausted (resets at epoch {reset})")
                self._backoff(attempt, "429 throttled", r.headers.get("Retry-After"))
                continue

            if r.status_code >= 500:
                self._backoff(attempt, f"server error {r.status_code}")
                continue

            raise SyncError(f"HTTP {r.status_code}: {r.text[:300]}")

        raise SyncError(f"Gave up after {MAX_RETRIES} attempts")

    @staticmethod
    def _backoff(attempt, reason, retry_after=None):
        wait = int(retry_after) if retry_after and retry_after.isdigit() else min(2 ** attempt, 60)
        print(f"  ! {reason}; retrying in {wait}s (attempt {attempt}/{MAX_RETRIES})")
        time.sleep(wait)


# ---------------------------------------------------------------- fetching

def fetch_author(api, au_id):
    """Return (raw entries, totalResults) for one Scopus author ID."""
    entries, start, total = [], 0, None
    while True:
        data = api.get({"query": f"AU-ID({au_id})", "start": start, "count": PAGE_SIZE})
        results = data.get("search-results", {})
        total = int(results.get("opensearch:totalResults", 0))
        page = results.get("entry", [])
        # An empty result set comes back as a single entry containing an "error" key.
        page = [e for e in page if "error" not in e]
        entries.extend(page)
        start += PAGE_SIZE
        if not page or start >= total:
            break
    return entries, total


def normalize(entry):
    """Turn one Scopus search entry into our compact record."""
    authors = []
    for a in sorted(entry.get("author", []), key=lambda a: int(a.get("@seq", 0) or 0)):
        if a.get("authname"):
            authors.append(a["authname"])
    first_author = authors[0] if authors else entry.get("dc:creator", "")

    link = next((l.get("@href") for l in entry.get("link", []) if l.get("@ref") == "scopus"), "")
    date = entry.get("prism:coverDate", "")

    return {
        "eid": entry.get("eid", ""),
        "title": entry.get("dc:title", ""),
        "first_author": first_author,
        "authors": authors,                  # empty when only STANDARD view is available
        "journal": entry.get("prism:publicationName", ""),
        "date": date,
        "year": int(date[:4]) if date[:4].isdigit() else None,
        "doi": entry.get("prism:doi", ""),
        "citations": int(entry.get("citedby-count") or 0),
        "type": entry.get("subtypeDescription", ""),
        "link": link,                        # Scopus URL incl. partnerID, kept as-is
        "faculty": [],                       # filled in by the caller
    }


# ---------------------------------------------------------------- key test

def run_test(api, au_id):
    print(f"Key test: AU-ID({au_id})")
    entries, total = fetch_author(api, au_id)
    records = [normalize(e) for e in entries]
    with_cites = sum(1 for e in entries if "citedby-count" in e)

    print(f"\n  view used          : {api.view}")
    print(f"  Scopus totalResults: {total}")
    print(f"  records fetched    : {len(records)}")
    print(f"  with citation count: {with_cites}  (sum = {sum(r['citations'] for r in records)})")
    print(f"  with full authors  : {sum(1 for r in records if r['authors'])}")
    print(f"  requests made      : {api.request_count}")
    for h in ("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"):
        print(f"  {h:<23}: {api.last_headers.get(h, '(not sent)')}")
    print("\n  sample records:")
    for r in sorted(records, key=lambda r: r["date"], reverse=True)[:3]:
        print("   ", json.dumps({k: r[k] for k in ("title", "year", "citations", "first_author", "journal", "link")}))

    if len(records) != total:
        print("\nWARNING: fetched count differs from totalResults")
        return 1
    return 0


# ---------------------------------------------------------------- full sync

def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_atomic(path, text):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def run_sync(api, force=False):
    authors = json.loads(AUTHORS_FILE.read_text())
    old_meta = load_json(META_FILE, {})
    old_counts = old_meta.get("per_author", {})

    by_eid = {}
    per_author = {}
    for person in authors:
        name = person["name"]
        count_for_person = set()
        for au_id in person["scopus_ids"]:
            print(f"{name} [{au_id}]")
            entries, total = fetch_author(api, au_id)
            if len(entries) != total:
                raise SyncError(f"{name} [{au_id}]: got {len(entries)} of {total} records")
            print(f"  {total} records")
            for e in entries:
                rec = normalize(e)
                if not rec["eid"]:
                    continue
                existing = by_eid.setdefault(rec["eid"], rec)
                if name not in existing["faculty"]:
                    existing["faculty"].append(name)
                count_for_person.add(rec["eid"])
        per_author[name] = len(count_for_person)

    pubs = sorted(by_eid.values(), key=lambda r: (r["date"], r["eid"]), reverse=True)

    # ---- sanity checks: never overwrite good data with bad data
    if not force:
        old_total = old_meta.get("total", 0)
        if old_total and len(pubs) < old_total * MIN_TOTAL_RATIO:
            raise SyncError(f"Total dropped from {old_total} to {len(pubs)}; refusing to publish")
        dropped = [n for n, c in per_author.items() if c == 0 and old_counts.get(n, 0) > 0]
        if dropped:
            raise SyncError(f"Authors suddenly have 0 records: {dropped}; refusing to publish")

    # One record per line keeps the file small AND makes git diffs readable.
    pubs_text = "[\n" + ",\n".join(json.dumps(p, ensure_ascii=False) for p in pubs) + "\n]\n"
    if PUBS_FILE.exists() and PUBS_FILE.read_text() == pubs_text:
        print(f"\nNo changes ({len(pubs)} publications). Nothing written.")
        return 0

    meta = {
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": len(pubs),
        "authors": [p["name"] for p in authors],
        "per_author": per_author,
        "scopus_view": api.view,
    }
    DATA_DIR.mkdir(exist_ok=True)
    write_atomic(PUBS_FILE, pubs_text)
    write_atomic(META_FILE, json.dumps(meta, indent=2) + "\n")
    print(f"\nWrote {len(pubs)} publications ({api.request_count} API requests).")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--test", metavar="AU_ID", help="fetch one author and print a report; writes nothing")
    parser.add_argument("--force", action="store_true", help="skip the low-count safety check")
    args = parser.parse_args()

    key = os.environ.get("SCOPUS_API_KEY")
    if not key:
        sys.exit("SCOPUS_API_KEY is not set")
    api = Scopus(key, os.environ.get("SCOPUS_INSTTOKEN"))

    try:
        sys.exit(run_test(api, args.test) if args.test else run_sync(api, args.force))
    except SyncError as e:
        print(f"\nSYNC FAILED, existing data left untouched: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
