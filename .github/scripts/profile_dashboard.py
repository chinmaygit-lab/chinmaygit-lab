#!/usr/bin/env python3
from __future__ import annotations
import json, os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "profile.config.json"
README_PATH = ROOT / "README.md"
LIVE_SVG_PATH = ROOT / "assets" / "live-status.svg"

DASH_START = "<!-- DASHBOARD:START -->"
DASH_END = "<!-- DASHBOARD:END -->"
ACT_START = "<!-- ACTIVITY:START -->"
ACT_END = "<!-- ACTIVITY:END -->"

def api(path: str):
    token = os.environ.get("GITHUB_TOKEN", "")
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "profile-command-center",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(f"https://api.github.com{path}", headers=headers)
    try:
        with urlopen(req, timeout=20) as response:
            return json.load(response)
    except HTTPError as exc:
        print(f"GitHub API warning for {path}: HTTP {exc.code}")
        return None

def parse_time(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

def age_label(value):
    dt = parse_time(value)
    if dt is None:
        return "unknown"
    delta = datetime.now(timezone.utc) - dt
    if delta.days == 0:
        hours = max(0, int(delta.total_seconds() // 3600))
        return "today" if hours < 1 else f"{hours}h ago"
    if delta.days == 1:
        return "1d ago"
    return f"{delta.days}d ago"

def state(value):
    dt = parse_time(value)
    if dt is None:
        return "UNKNOWN"
    days = (datetime.now(timezone.utc) - dt).days
    if days <= 7:
        return "ACTIVE"
    if days <= 30:
        return "RECENT"
    return "QUIET"

def esc(text):
    return str(text).replace("|", r"\|").replace("\n", " ").strip()

def replace_block(text, start, end, body):
    before, rest = text.split(start, 1)
    _, after = rest.split(end, 1)
    return f"{before}{start}\n{body.rstrip()}\n{end}{after}"

def latest_commit(username, repo, branch):
    data = api(f"/repos/{username}/{repo}/commits?sha={branch}&per_page=1")
    if not data:
        return None
    item = data[0]
    return {
        "message": item.get("commit", {}).get("message", "").splitlines()[0],
        "url": item.get("html_url", ""),
    }

def build_dashboard(config):
    username = config["username"]
    rows, statuses = [], []
    for item in config["featured_repositories"]:
        repo_name = item["repo"]
        repo = api(f"/repos/{username}/{repo_name}") or {}
        branch = repo.get("default_branch", "main")
        pushed_at = repo.get("pushed_at")
        lang = repo.get("language") or "—"
        repo_state = state(pushed_at)
        commit = latest_commit(username, repo_name, branch) or {}
        repo_url = repo.get("html_url") or f"https://github.com/{username}/{repo_name}"
        commit_text = esc(commit.get("message") or "—")
        commit_url = commit.get("url")
        commit_cell = f"[{commit_text}]({commit_url})" if commit_url else commit_text
        rows.append(
            f"| [{esc(item['label'])}]({repo_url}) | `{repo_state}` | "
            f"{esc(lang)} | {age_label(pushed_at)} | {commit_cell} |"
        )
        statuses.append((item["label"], repo_state, lang, age_label(pushed_at)))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "| System | State | Language | Last push | Latest commit |",
        "|---|---|---|---|---|",
        *rows,
        "",
        f"**Current workstream:** {config['current_focus']}  ",
        f"**Dashboard refreshed:** {now}",
    ]
    return "\n".join(lines), statuses, now

def activity_text(config):
    username = config["username"]
    limit = int(config.get("activity_limit", 5))
    events = api(f"/users/{username}/events/public?per_page=30") or []
    useful = []
    for event in events:
        typ = event.get("type")
        repo = event.get("repo", {}).get("name", "")
        created = age_label(event.get("created_at"))
        payload = event.get("payload") or {}
        if typ == "PushEvent":
            commits = payload.get("commits") or []
            msg = commits[-1].get("message", "").splitlines()[0] if commits else "pushed commits"
            useful.append(f"- **Push** · `{repo}` · {esc(msg)} · {created}")
        elif typ == "PullRequestEvent":
            title = (payload.get("pull_request") or {}).get("title", "pull request")
            useful.append(f"- **PR** · `{repo}` · {esc(title)} · {created}")
        elif typ == "IssuesEvent":
            title = (payload.get("issue") or {}).get("title", "issue")
            useful.append(f"- **Issue** · `{repo}` · {esc(title)} · {created}")
        elif typ == "ReleaseEvent":
            tag = (payload.get("release") or {}).get("tag_name", "release")
            useful.append(f"- **Release** · `{repo}` · {esc(tag)} · {created}")
        elif typ == "CreateEvent":
            useful.append(f"- **Created** · `{repo}` · {created}")
        if len(useful) >= limit:
            break
    return "\n".join(useful) if useful else "No recent public activity returned by the GitHub API."

def xml(value):
    return str(value).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace('"',"&quot;")

def write_live_svg(statuses, now):
    colors = {"ACTIVE":"#22c55e","RECENT":"#38bdf8","QUIET":"#94a3b8","UNKNOWN":"#f59e0b"}
    xs = [55,330,605,880]
    parts = []
    for x, (label, status, lang, age) in zip(xs, statuses):
        color = colors.get(status, "#f59e0b")
        parts.append(
            f'<circle cx="{x}" cy="45" r="7" fill="{color}"/>'
            f'<text x="{x+16}" y="51" fill="#e5eefb" font-family="monospace" font-size="15">{xml(label)}</text>'
            f'<text x="{x}" y="84" fill="#8ba3be" font-family="monospace" font-size="13">{xml(status)} · {xml(lang)} · {xml(age)}</text>'
        )
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="130" viewBox="0 0 1200 130">'
        '<rect width="1200" height="130" rx="18" fill="#0b1220" stroke="#24364f"/>'
        + "".join(parts) +
        f'<text x="55" y="116" fill="#52677f" font-family="monospace" font-size="11">refreshed {xml(now)}</text>'
        '</svg>'
    )
    LIVE_SVG_PATH.write_text(svg, encoding="utf-8")

def main():
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    readme = README_PATH.read_text(encoding="utf-8")
    dashboard, statuses, now = build_dashboard(config)
    readme = replace_block(readme, DASH_START, DASH_END, dashboard)
    readme = replace_block(readme, ACT_START, ACT_END, activity_text(config))
    README_PATH.write_text(readme, encoding="utf-8")
    write_live_svg(statuses, now)
    print("Profile dashboard refreshed.")

if __name__ == "__main__":
    main()
