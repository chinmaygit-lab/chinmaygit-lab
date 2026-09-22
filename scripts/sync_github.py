#!/usr/bin/env python3
"""Build the public snapshot consumed by the GitHub Pages engineering lab.

The relationship graph is version-controlled in site/data/graph.json.
This script only enriches project nodes with live public GitHub state.
It intentionally fails soft so Pages can still deploy from the checked-in snapshot.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

USER = os.environ.get("PROFILE_USER", "chinmaygit-lab")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
OUT = Path(os.environ.get("PROFILE_SNAPSHOT_OUT", "site/data/profile.json"))

PROJECTS = [
    {
        "repo_name": "ConformalGuard",
        "id": "conformalguard",
        "display_name": "ConformalGuard",
        "fallback_summary": "Conformal prediction under distribution shift with reproducible robustness evaluation.",
    },
    {
        "repo_name": "retailpilot",
        "id": "retailpilot",
        "display_name": "RetailPilot",
        "fallback_summary": "Offline-first Android POS and inventory system with validation-focused engineering.",
    },
    {
        "repo_name": "social-saver-cognitive-engine",
        "id": "socialsaver",
        "display_name": "Social Saver",
        "fallback_summary": "Retrieval and resurfacing engine for saved URLs, notes, and unstructured content.",
    },
    {
        "repo_name": "Anomaly-Detection-Model",
        "id": "anomaly",
        "display_name": "Anomaly Detection",
        "fallback_summary": "Hybrid anomaly pipeline combining learned representations with classical detectors.",
    },
]


def api(path: str) -> Any:
    request = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"{USER}-profile-runtime",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    if TOKEN:
        request.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def optional_api(path: str, default: Any) -> Any:
    try:
        return api(path)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
        return default


def age(iso: str | None) -> str:
    if not iso:
        return "unknown"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return "unknown"
    delta = datetime.now(timezone.utc) - dt
    hours = max(0, int(delta.total_seconds() // 3600))
    if hours < 1:
        return "<1h ago"
    return f"{hours}h ago" if hours < 48 else f"{hours // 24}d ago"


def state_from_push(pushed_at: str | None) -> str:
    if not pushed_at:
        return "UNKNOWN"
    try:
        pushed = datetime.fromisoformat(pushed_at.replace("Z", "+00:00"))
    except ValueError:
        return "UNKNOWN"
    return "ACTIVE" if (datetime.now(timezone.utc) - pushed).days < 30 else "QUIET"


def latest_commit(repo_name: str) -> dict[str, str]:
    encoded = urllib.parse.quote(repo_name, safe="")
    commits = optional_api(f"/repos/{USER}/{encoded}/commits?per_page=1", [])
    if not commits:
        return {}
    item = commits[0]
    commit = item.get("commit") or {}
    return {
        "sha": str(item.get("sha", ""))[:7],
        "message": str(commit.get("message", "")).splitlines()[0][:140],
        "url": str(item.get("html_url", "")),
    }


def latest_release(repo_name: str) -> dict[str, str]:
    encoded = urllib.parse.quote(repo_name, safe="")
    item = optional_api(f"/repos/{USER}/{encoded}/releases/latest", {})
    if not item:
        return {}
    return {
        "tag": str(item.get("tag_name", "")),
        "name": str(item.get("name", "")),
        "url": str(item.get("html_url", "")),
        "published_at": str(item.get("published_at", "")),
    }


def latest_workflow(repo_name: str) -> dict[str, str]:
    encoded = urllib.parse.quote(repo_name, safe="")
    payload = optional_api(f"/repos/{USER}/{encoded}/actions/runs?per_page=1", {})
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not runs:
        return {}
    run = runs[0]
    return {
        "name": str(run.get("name", "")),
        "status": str(run.get("status", "")),
        "conclusion": str(run.get("conclusion") or ""),
        "url": str(run.get("html_url", "")),
        "updated_at": str(run.get("updated_at", "")),
    }


def project_snapshot(config: dict[str, str]) -> dict[str, Any]:
    repo_name = config["repo_name"]
    encoded = urllib.parse.quote(repo_name, safe="")
    try:
        repo = api(f"/repos/{USER}/{encoded}")
    except Exception:
        return {
            "id": config["id"],
            "repo_name": repo_name,
            "name": config["display_name"],
            "repo": f"https://github.com/{USER}/{repo_name}",
            "state": "UNKNOWN",
            "language": "—",
            "summary": config["fallback_summary"],
            "last_push": "unavailable",
            "latest_commit": {},
            "release": {},
            "workflow": {},
        }

    pushed = repo.get("pushed_at")
    return {
        "id": config["id"],
        "repo_name": repo_name,
        "name": config["display_name"],
        "repo": repo.get("html_url", f"https://github.com/{USER}/{repo_name}"),
        "state": state_from_push(pushed),
        "language": repo.get("language") or "—",
        "summary": repo.get("description") or config["fallback_summary"],
        "last_push": age(pushed),
        "pushed_at": pushed,
        "stars": int(repo.get("stargazers_count") or 0),
        "forks": int(repo.get("forks_count") or 0),
        "open_issues": int(repo.get("open_issues_count") or 0),
        "latest_commit": latest_commit(repo_name),
        "release": latest_release(repo_name),
        "workflow": latest_workflow(repo_name),
    }


def public_activity() -> list[dict[str, str]]:
    events = optional_api(f"/users/{USER}/events/public?per_page=30", [])
    activity: list[dict[str, str]] = []
    for event in events:
        event_type = str(event.get("type", "")).replace("Event", "")
        if event_type not in {"Push", "Release", "Create", "PullRequest"}:
            continue
        repo = str((event.get("repo") or {}).get("name", "")).split("/")[-1]
        payload = event.get("payload") or {}
        detail = "public event"
        if event_type == "Push":
            commits = payload.get("commits") or []
            if commits:
                detail = str(commits[-1].get("message", "pushed commits")).splitlines()[0][:120]
            else:
                detail = "pushed commits"
        elif event_type == "Release":
            detail = str((payload.get("release") or {}).get("tag_name", "release"))
        elif event_type == "Create":
            ref_type = str(payload.get("ref_type", "ref"))
            ref = str(payload.get("ref") or "")
            detail = f"created {ref_type}{f' {ref}' if ref else ''}"
        elif event_type == "PullRequest":
            pr = payload.get("pull_request") or {}
            detail = str(pr.get("title", "pull request"))[:120]
        activity.append({
            "type": event_type,
            "repo": repo,
            "detail": detail,
            "when": age(event.get("created_at")),
        })
        if len(activity) >= 8:
            break
    return activity


def main() -> None:
    projects = [project_snapshot(config) for config in PROJECTS]
    snapshot = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "workstream": os.environ.get("PROFILE_WORKSTREAM", "Building ConformalGuard reliability tooling and release quality"),
        "profile": f"https://github.com/{USER}",
        "projects": projects,
        "activity": public_activity(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} with {len(projects)} projects and {len(snapshot['activity'])} activity rows")


if __name__ == "__main__":
    main()
