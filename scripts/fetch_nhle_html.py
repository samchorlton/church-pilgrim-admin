#!/usr/bin/env python3
"""
Fetch NHLE listing HTML with curl_cffi and save files for the Node pipeline.

Outputs one JSON file per listing ID in --output-dir:
  <listEntry>.json => { listEntry, url, finalUrl, status, ok, html, error }
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterable

from curl_cffi import requests


def parse_ids_from_csv(value: str) -> list[int]:
    out: list[int] = []
    for part in (value or "").split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            continue
        out.append(int(part))
    return out


def parse_ids_from_json_file(path: str) -> list[int]:
    if not path:
        return []
    p = pathlib.Path(path)
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("--input must be a JSON array of listing IDs")
    out: list[int] = []
    for item in data:
        try:
            value = int(item)
        except Exception:
            continue
        if value > 0:
            out.append(value)
    return out


def dedupe_sorted(values: Iterable[int]) -> list[int]:
    return sorted(set(v for v in values if isinstance(v, int) and v > 0))


def listing_url(list_entry: int) -> str:
    return f"https://historicengland.org.uk/listing/the-list/list-entry/{list_entry}?section=official-list-entry"

def fetch_one(
    list_entry: int,
    output_dir: pathlib.Path,
    headers: dict[str, str],
    impersonate: str,
    timeout: float,
    overwrite: bool,
) -> tuple[int, bool, bool]:
    out_path = output_dir / f"{list_entry}.json"
    if out_path.exists() and not overwrite:
        return list_entry, True, False

    url = listing_url(list_entry)
    payload = {
        "listEntry": list_entry,
        "url": url,
        "finalUrl": url,
        "status": None,
        "ok": False,
        "html": "",
        "error": None,
    }
    request_failed = False

    try:
        response = requests.get(
            url,
            headers=headers,
            impersonate=impersonate,
            default_headers=True,
            timeout=timeout,
        )
        text = response.text or ""
        payload["status"] = int(response.status_code)
        payload["ok"] = bool(response.ok)
        payload["finalUrl"] = str(getattr(response, "url", url))
        payload["html"] = text
    except Exception as error:
        payload["error"] = str(error)
        request_failed = True

    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return list_entry, False, request_failed


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch NHLE listing HTML into local JSON files.")
    parser.add_argument("--listing", type=int, default=0, help="Single listing ID")
    parser.add_argument("--listings", type=str, default="", help="Comma-separated listing IDs")
    parser.add_argument("--input", type=str, default="", help="JSON file containing listing IDs array")
    parser.add_argument("--output-dir", type=str, default="scripts/.nhle-html", help="Output directory")
    parser.add_argument("--impersonate", type=str, default="safari", help="curl_cffi impersonation profile")
    parser.add_argument("--timeout", type=float, default=25.0, help="Request timeout (seconds)")
    parser.add_argument("--delay-ms", type=int, default=250, help="Delay between requests (ms)")
    parser.add_argument("--concurrency", type=int, default=1, help="Number of concurrent requests")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output files")
    args = parser.parse_args()

    ids = []
    if args.listing and args.listing > 0:
        ids.append(args.listing)
    ids.extend(parse_ids_from_csv(args.listings))
    ids.extend(parse_ids_from_json_file(args.input))
    list_entries = dedupe_sorted(ids)
    if not list_entries:
        parser.error("No valid listing IDs. Use --listing, --listings, or --input.")

    output_dir = pathlib.Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    headers = {
        "User-Agent": "my-curl-scraper/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Referer": "https://historicengland.org.uk/",
    }

    success = 0
    failed = 0
    skipped = 0

    concurrency = max(1, int(args.concurrency or 1))

    print(f"starting fetch for {len(list_entries)} listings (concurrency={concurrency})")
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = []
        for list_entry in list_entries:
            futures.append(
                executor.submit(
                    fetch_one,
                    list_entry,
                    output_dir,
                    headers,
                    args.impersonate,
                    args.timeout,
                    args.overwrite,
                )
            )
            if args.delay_ms > 0:
                time.sleep(args.delay_ms / 1000)

        completed = 0
        total = len(list_entries)
        for future in as_completed(futures):
            list_entry, was_skipped, request_failed = future.result()
            completed += 1
            if was_skipped:
                skipped += 1
                print(f"[{completed}/{total}] skip {list_entry} (exists)")
                continue

            out_path = output_dir / f"{list_entry}.json"
            try:
                payload = json.loads(out_path.read_text(encoding="utf-8"))
            except Exception:
                payload = {}

            status = payload.get("status")
            html = str(payload.get("html") or "")
            if request_failed:
                failed += 1
                print(f"[{completed}/{total}] {list_entry} => ERROR: {payload.get('error')}")
            else:
                success += 1
                print(f"[{completed}/{total}] {list_entry} => {status} ({len(html)} bytes)")

    print(f"done. success={success}, failed={failed}, skipped={skipped}, output={output_dir}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
