#!/usr/bin/env python3
"""Validate the engineering relationship graph before deployment."""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

GRAPH = Path(sys.argv[1] if len(sys.argv) > 1 else "site/data/graph.json")
ALLOWED_KINDS = {"core", "project", "capability", "evidence"}
ALLOWED_RELATIONS = {"principle", "demonstrates", "specializes", "evidence", "supports"}


def fail(message: str) -> None:
    raise SystemExit(f"graph validation failed: {message}")


def main() -> None:
    data = json.loads(GRAPH.read_text(encoding="utf-8"))
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []
    if not nodes:
        fail("nodes must not be empty")

    ids = [node.get("id") for node in nodes]
    if any(not node_id for node_id in ids):
        fail("every node needs a non-empty id")
    if len(ids) != len(set(ids)):
        fail("node ids must be unique")

    by_id = {node["id"]: node for node in nodes}
    core_id = (data.get("meta") or {}).get("core_node")
    if core_id not in by_id or by_id[core_id].get("kind") != "core":
        fail("meta.core_node must point to a core node")

    for node in nodes:
        kind = node.get("kind")
        if kind not in ALLOWED_KINDS:
            fail(f"{node['id']}: invalid kind {kind!r}")
        if not str(node.get("label", "")).strip():
            fail(f"{node['id']}: missing label")
        url = node.get("url")
        if url:
            parsed = urlparse(url)
            if parsed.scheme != "https" or parsed.netloc != "github.com":
                fail(f"{node['id']}: evidence URLs must use https://github.com")
        if kind == "evidence" and node.get("project") not in by_id:
            fail(f"{node['id']}: evidence project does not exist")

    seen_edges: set[tuple[str, str, str]] = set()
    neighbors: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for index, edge in enumerate(edges):
        source, target, relation = edge.get("source"), edge.get("target"), edge.get("relation")
        if source not in by_id or target not in by_id:
            fail(f"edge {index}: source/target must reference existing nodes")
        if source == target:
            fail(f"edge {index}: self-edge is not allowed")
        if relation not in ALLOWED_RELATIONS:
            fail(f"edge {index}: invalid relation {relation!r}")
        key = (source, target, relation)
        reverse = (target, source, relation)
        if key in seen_edges or reverse in seen_edges:
            fail(f"edge {index}: duplicate relationship {source} {relation} {target}")
        seen_edges.add(key)
        neighbors[source].append((target, relation))
        neighbors[target].append((source, relation))

    projects = [node for node in nodes if node["kind"] == "project"]
    for project in projects:
        linked = [by_id[node_id] for node_id, _ in neighbors[project["id"]]]
        if not any(node["kind"] == "capability" for node in linked):
            fail(f"{project['id']}: project needs a capability connection")
        if not any(node["kind"] == "evidence" for node in linked):
            fail(f"{project['id']}: project needs an evidence connection")

    evidence_nodes = [node for node in nodes if node["kind"] == "evidence"]
    for evidence in evidence_nodes:
        project_id = evidence["project"]
        relations = neighbors[evidence["id"]]
        if (project_id, "evidence") not in relations:
            fail(f"{evidence['id']}: must have an evidence edge to its declared project")
        if not any(by_id[node_id]["kind"] == "capability" and relation == "supports" for node_id, relation in relations):
            fail(f"{evidence['id']}: must support at least one capability")

    capabilities = [node for node in nodes if node["kind"] == "capability"]
    for capability in capabilities:
        linked = [by_id[node_id] for node_id, _ in neighbors[capability["id"]]]
        if not any(node["kind"] == "project" for node in linked):
            fail(f"{capability['id']}: capability must be demonstrated by a project")

    print(f"graph OK: {len(nodes)} nodes, {len(edges)} edges, {len(projects)} projects, {len(evidence_nodes)} evidence nodes")


if __name__ == "__main__":
    main()
