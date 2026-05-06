#!/usr/bin/env python3
"""
Fetch Cadw report HTML pages and save one JSON file per list_entry.

Input JSON file format (--input):
[
  { "listEntry": 9000000012, "url": "http://cadwpublic-api.azurewebsites.net/reports/listedbuilding/FullReport?lang=en&id=12" }
]

Output files (--output-dir):
  <listEntry>.json => { listEntry, url, finalUrl, status, ok, html, error }
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from curl_cffi import requests


def load_items(path: str) -> list[dict]:
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("--input must be a JSON array")
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        list_entry = item.get("listEntry")
        url = item.get("url")
        try:
            list_entry = int(list_entry)
        except Exception:
            continue
        if list_entry <= 0 or not isinstance(url, str) or not url.strip():
            continue
        out.append({"listEntry": list_entry, "url": url.strip()})
    return out


def fetch_one(
    item: dict,
    output_dir: pathlib.Path,
    impersonate: str,
    timeout: float,
    overwrite: bool,
) -> tuple[int, bool, bool]:
    list_entry = int(item["listEntry"])
    url = str(item["url"])
    out_path = output_dir / f"{list_entry}.json"
    if out_path.exists() and not overwrite:
        return list_entry, True, False

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
            impersonate=impersonate,
            default_headers=True,
            timeout=timeout,
        )
        payload["status"] = int(response.status_code)
        payload["ok"] = bool(response.ok)
        payload["finalUrl"] = str(getattr(response, "url", url))
        payload["html"] = response.text or ""
    except Exception as error:
        payload["error"] = str(error)
        request_failed = True

    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return list_entry, False, request_failed


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Cadw listing HTML into local JSON files.")
    parser.add_argument("--input", type=str, required=True, help="JSON file containing [{listEntry,url}]")
    parser.add_argument("--output-dir", type=str, default="scripts/.cadw-html", help="Output directory")
    parser.add_argument("--impersonate", type=str, default="safari", help="curl_cffi impersonation profile")
    parser.add_argument("--timeout", type=float, default=25.0, help="Request timeout in seconds")
    parser.add_argument("--delay-ms", type=int, default=150, help="Delay between queueing requests")
    parser.add_argument("--concurrency", type=int, default=4, help="Number of concurrent requests")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output files")
    args = parser.parse_args()

    items = load_items(args.input)
    if not items:
        parser.error("No valid items in --input.")

    output_dir = pathlib.Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    success = 0
    failed = 0
    skipped = 0
    concurrency = max(1, int(args.concurrency or 1))
    total = len(items)

    print(f"starting fetch for {total} Cadw listings (concurrency={concurrency})")

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = []
        for item in items:
            futures.append(
                executor.submit(
                    fetch_one,
                    item,
                    output_dir,
                    args.impersonate,
                    args.timeout,
                    args.overwrite,
                )
            )
            if args.delay_ms > 0:
                time.sleep(args.delay_ms / 1000)

        completed = 0
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

