# V4 — fully implemented system connection graph

This keeps the V4 architecture (profile README → GitHub Pages → Actions-synchronized public state) and makes the graph the primary interface.

## What is implemented

### 1. Three-layer provenance graph

The graph is not generated from visual guesses. Relationships are explicitly version-controlled in:

```text
site/data/graph.json
```

Node types:

- `project` — ConformalGuard, RetailPilot, Social Saver, Anomaly Detection
- `capability` — reliable ML, reproducibility, verification/CI, state integrity, backend systems, retrieval, security ML, etc.
- `evidence` — concrete benchmark/reporting/test/architecture/release artifacts
- `core` — the shared engineering loop

Edges have explicit semantics: `demonstrates`, `specializes`, `evidence`, `supports`, and `principle`.

### 2. Real graph interaction

Implemented in `site/app.js` with no framework dependency:

- click / keyboard-focus any node
- one-hop neighborhood focus
- inspector with direct relationships
- live project state in the inspector
- text search over labels, descriptions, and tags
- project/capability/evidence visibility toggles
- intent/lens filtering
- mouse/touch panning
- wheel zoom + accessible zoom buttons
- fit/reset controls
- shortest-path tracing between any two nodes
- URL deep-linking with `#node=...&lens=...`
- double-click evidence/project nodes to open the linked GitHub artifact

### 3. Graph-aware terminal

Commands:

```text
help
now
projects
graph reliability
focus ConformalGuard
path ConformalGuard -> Verification & CI
activity
why
```

### 4. Live repository enrichment

`site/data/graph.json` contains stable engineering relationships.

`scripts/sync_github.py` periodically enriches project nodes with:

- current repository activity state
- primary language
- last push
- latest commit
- latest release when present
- latest public Actions run when readable
- stars / forks / open issue count
- recent public activity

If any GitHub API endpoint is unavailable, the deployment still works from the checked-in snapshot.

## Deploy

Copy the contents of this package into:

```text
chinmaygit-lab/chinmaygit-lab
```

Then:

```powershell
git add README.md site scripts .github
git diff --check
git status --short
git commit -m "feat: add interactive system connection graph"
git push origin main
```

In GitHub:

1. Open **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Open **Actions → Profile Lab Runtime**.
4. Run it once manually.
5. Open `https://chinmaygit-lab.github.io/chinmaygit-lab/`.

## Validate locally

From the profile repository root:

```powershell
python scripts/validate_graph.py
python -m py_compile scripts/sync_github.py scripts/validate_graph.py
node --check site/app.js
python -m http.server 8000 --directory site
```

Then open:

```text
http://localhost:8000
```

## Edit the graph

To add a new capability or evidence artifact, edit only `site/data/graph.json`.

Every edge must reference existing node IDs. Keep project node IDs equal to the IDs used by `scripts/sync_github.py` so live state merges automatically.

Example:

```json
{
  "id": "ev-example",
  "kind": "evidence",
  "project": "conformalguard",
  "label": "Example evidence",
  "short": "EVIDENCE",
  "description": "What this artifact proves.",
  "url": "https://github.com/chinmaygit-lab/ConformalGuard",
  "tags": ["reliability"]
}
```

Then connect it:

```json
{"source":"ev-example","target":"conformalguard","relation":"evidence"},
{"source":"ev-example","target":"cap-reliability","relation":"supports"}
```

## Design rule

Do not add a capability unless at least one project demonstrates it. Prefer adding an evidence node that makes the claim inspectable.
