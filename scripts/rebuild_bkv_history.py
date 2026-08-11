#!/usr/bin/env python3
"""Queue historical BKV records through the Rust algorithm service.

This is deliberately a control-plane batch tool. It never opens a BKV share or
accepts a local source path; the algorithm service resolves the retained
provenance and performs the bounded materialization/publish operation. Use a
small ``--limit`` first to size SMB load before scheduling a larger backfill.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def _record_ids(input_root: Path) -> list[str]:
    records_root = input_root / "records"
    if not records_root.is_dir():
        raise ValueError(f"history input root is unavailable: {records_root}")
    return sorted(
        {
            entry.name
            for entry in records_root.iterdir()
            if entry.is_dir() and entry.name.isdigit() and (entry / "record.json").is_file()
        },
        key=int,
    )


def _has_artifacts(input_root: Path, record_id: str) -> bool:
    try:
        value = json.loads(
            (input_root / "records" / record_id / "record.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError, json.JSONDecodeError):
        return False
    captures = value.get("captureFiles")
    return isinstance(captures, list) and bool(captures)


def _request(origin: str, record_id: str, timeout: float) -> dict[str, Any]:
    body = json.dumps({"recordId": record_id}).encode("utf-8")
    request = urllib.request.Request(
        f"{origin.rstrip('/')}/internal/v1/reconstruct?recordId={record_id}",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
            value = json.loads(payload)
            return value if isinstance(value, dict) else {"response": value}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        return {"accepted": False, "recordId": record_id, "status": error.code, "error": detail}
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return {"accepted": False, "recordId": record_id, "error": str(error)}


def rebuild(
    input_root: Path,
    origin: str,
    limit: int | None,
    after: int | None,
    timeout: float,
    pause: float,
    include_materialized: bool,
    latest: bool,
    workers: int,
    retries: int,
) -> dict[str, Any]:
    input_root = input_root.resolve()
    ids = _record_ids(input_root)
    if after is not None:
        ids = [record_id for record_id in ids if int(record_id) > after]
    if not include_materialized:
        ids = [record_id for record_id in ids if not _has_artifacts(input_root, record_id)]
    if latest:
        ids.reverse()
    if limit is not None:
        ids = ids[:limit]
    results: list[dict[str, Any]] = []
    started = time.time()
    def request_one(record_id: str) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for attempt in range(retries + 1):
            result = _request(origin, record_id, timeout)
            if result.get("status") == "ready":
                break
            result["attempt"] = attempt + 1
            if attempt < retries:
                time.sleep(min(2**attempt, 8))
        if pause > 0:
            time.sleep(pause)
        return result

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="bkv-rebuild") as pool:
        pending = {pool.submit(request_one, record_id): record_id for record_id in ids}
        for future in as_completed(pending):
            record_id = pending[future]
            try:
                result = future.result()
            except Exception as error:  # keep the remaining resumable batch running
                result = {"accepted": False, "recordId": record_id, "error": str(error)}
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    return {
        "schema": "steel.bkv-history-rebuild.v1",
        "inputRoot": str(input_root),
        "algorithmOrigin": origin,
        "selected": len(ids),
        "ready": sum(1 for result in results if result.get("status") == "ready"),
        "failed": sum(1 for result in results if result.get("accepted") is False),
        "elapsedSeconds": round(time.time() - started, 3),
        "results": results,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--algorithm-origin", default="http://127.0.0.1:4875")
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--after", type=int)
    parser.add_argument(
        "--latest",
        action="store_true",
        help="select newest record ids first (combine with --limit for a bounded recent backfill)",
    )
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--pause", type=float, default=0.1)
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="parallel record requests (1-6); each record already uses six bounded camera workers",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="retry transient reconstruction or local HTTP failures per record",
    )
    parser.add_argument(
        "--include-materialized",
        action="store_true",
        help="also send records whose standard input already contains captureFiles",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit is not None and args.limit < 1:
        raise SystemExit("--limit must be positive")
    if args.timeout <= 0 or args.pause < 0:
        raise SystemExit("--timeout must be positive and --pause cannot be negative")
    if args.workers < 1 or args.workers > 6:
        raise SystemExit("--workers must be between 1 and 6")
    if args.retries < 0 or args.retries > 10:
        raise SystemExit("--retries must be between 0 and 10")
    inventory = rebuild(
        args.input_root,
        args.algorithm_origin,
        args.limit,
        args.after,
        args.timeout,
        args.pause,
        args.include_materialized,
        args.latest,
        args.workers,
        args.retries,
    )
    if args.inventory:
        args.inventory.parent.mkdir(parents=True, exist_ok=True)
        args.inventory.write_text(
            json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(inventory, ensure_ascii=False))
    return 0 if inventory["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
