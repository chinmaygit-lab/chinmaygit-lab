(() => {
  'use strict';

  const PROFILE_FALLBACK = {
    generated_at: new Date(0).toISOString(),
    workstream: 'Public engineering systems',
    projects: [],
    activity: []
  };

  const LENSES = [
    ['all', 'Everything'],
    ['reliability', 'Reliability'],
    ['backend', 'Backend'],
    ['product', 'Product'],
    ['security', 'Security'],
    ['ml', 'Applied ML'],
    ['testing', 'Verification']
  ];

  const GRAPH_BOUNDS = { width: 1100, height: 700 };
  const PROJECT_RADIUS = 285;
  const CAPABILITY_RADIUS = 170;
  const EVIDENCE_ORBIT = 110;
  const MIN_SCALE = 0.62;
  const MAX_SCALE = 2.2;

  let profile = PROFILE_FALLBACK;
  let graphData = { nodes: [], edges: [], meta: {} };
  let nodeById = new Map();
  let adjacency = new Map();
  let activeLens = 'all';
  let selectedId = null;
  let tracePath = [];
  let searchTerm = '';
  let visibleKinds = new Set(['core', 'project', 'capability', 'evidence']);
  let transform = { x: 0, y: 0, scale: 1 };
  let dragState = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function relative(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()) || date.getTime() === 0) return 'snapshot fallback';
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function lensLabel(id) {
    return LENSES.find(([key]) => key === id)?.[1] || 'Everything';
  }

  function matchesLens(node) {
    if (activeLens === 'all') return true;
    return (node.tags || []).includes(activeLens);
  }

  function matchesSearch(node) {
    if (!searchTerm) return true;
    const haystack = [node.label, node.short, node.description, ...(node.tags || [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(searchTerm);
  }

  function projectLive(node) {
    if (node.kind !== 'project') return null;
    const repo = String(node.repo_name || '').toLowerCase();
    return profile.projects.find((project) =>
      String(project.repo_name || project.name || '').toLowerCase() === repo || project.id === node.id
    ) || null;
  }

  function buildGraphIndex() {
    nodeById = new Map(graphData.nodes.map((node) => [node.id, node]));
    adjacency = new Map(graphData.nodes.map((node) => [node.id, []]));
    graphData.edges.forEach((edge, index) => {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return;
      adjacency.get(edge.source).push({ id: edge.target, edgeIndex: index, relation: edge.relation });
      adjacency.get(edge.target).push({ id: edge.source, edgeIndex: index, relation: edge.relation });
    });
  }

  function graphLayout() {
    const cx = GRAPH_BOUNDS.width / 2;
    const cy = GRAPH_BOUNDS.height / 2;
    const positions = new Map();
    const core = nodeById.get(graphData.meta.core_node || 'engineering-core');
    if (core) positions.set(core.id, { x: cx, y: cy });

    const capabilities = graphData.nodes.filter((node) => node.kind === 'capability');
    capabilities.forEach((node, index) => {
      const angle = (Math.PI * 2 * index / capabilities.length) - Math.PI / 2;
      positions.set(node.id, {
        x: cx + CAPABILITY_RADIUS * Math.cos(angle),
        y: cy + CAPABILITY_RADIUS * Math.sin(angle)
      });
    });

    const projects = graphData.nodes.filter((node) => node.kind === 'project');
    projects.forEach((node, index) => {
      const angleDeg = Number.isFinite(node.angle) ? node.angle : (index * 360 / Math.max(1, projects.length));
      const angle = angleDeg * Math.PI / 180;
      positions.set(node.id, {
        x: cx + PROJECT_RADIUS * Math.cos(angle),
        y: cy + PROJECT_RADIUS * Math.sin(angle)
      });
    });

    const evidenceByProject = new Map();
    graphData.nodes.filter((node) => node.kind === 'evidence').forEach((node) => {
      if (!evidenceByProject.has(node.project)) evidenceByProject.set(node.project, []);
      evidenceByProject.get(node.project).push(node);
    });

    evidenceByProject.forEach((evidenceNodes, projectId) => {
      const project = nodeById.get(projectId);
      const projectPosition = positions.get(projectId);
      if (!project || !projectPosition) return;
      const baseAngle = (Number(project.angle) || 0) * Math.PI / 180;
      const count = evidenceNodes.length;
      const spread = Math.min(Math.PI * 0.72, Math.max(Math.PI * 0.34, count * 0.19));
      evidenceNodes.forEach((node, index) => {
        const local = count === 1 ? 0 : (-spread / 2 + spread * index / (count - 1));
        const angle = baseAngle + local;
        positions.set(node.id, {
          x: projectPosition.x + EVIDENCE_ORBIT * Math.cos(angle),
          y: projectPosition.y + EVIDENCE_ORBIT * Math.sin(angle)
        });
      });
    });

    return positions;
  }

  function visibleNodeIds() {
    const ids = new Set();
    const kindIsVisible = (node) => node && (node.kind === 'core' || visibleKinds.has(node.kind));
    graphData.nodes.forEach((node) => {
      if (!kindIsVisible(node)) return;
      if (matchesSearch(node)) ids.add(node.id);
    });

    if (searchTerm) {
      const expanded = new Set(ids);
      ids.forEach((id) => (adjacency.get(id) || []).forEach((neighbor) => {
        if (kindIsVisible(nodeById.get(neighbor.id))) expanded.add(neighbor.id);
      }));
      return expanded;
    }
    return ids;
  }

  function focusSet() {
    if (tracePath.length) return new Set(tracePath);
    if (!selectedId || !nodeById.has(selectedId)) return null;
    const set = new Set([selectedId]);
    (adjacency.get(selectedId) || []).forEach((neighbor) => set.add(neighbor.id));
    return set;
  }

  function edgeInTrace(edge) {
    if (tracePath.length < 2) return false;
    for (let index = 0; index < tracePath.length - 1; index += 1) {
      const a = tracePath[index];
      const b = tracePath[index + 1];
      if ((edge.source === a && edge.target === b) || (edge.source === b && edge.target === a)) return true;
    }
    return false;
  }

  function renderGraph() {
    const svg = $('#graph');
    const positions = graphLayout();
    const allowed = visibleNodeIds();
    const focused = focusSet();
    const projectStates = new Map(profile.projects.map((project) => [project.id, project.state]));
    const parts = [];

    parts.push(`<g id="viewport" transform="translate(${transform.x} ${transform.y}) scale(${transform.scale})">`);
    parts.push('<g class="edges-layer">');
    graphData.edges.forEach((edge) => {
      if (!allowed.has(edge.source) || !allowed.has(edge.target)) return;
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return;
      const inTrace = edgeInTrace(edge);
      const selectedEdge = selectedId && (edge.source === selectedId || edge.target === selectedId);
      const lensEdge = activeLens !== 'all' && (matchesLens(nodeById.get(edge.source)) || matchesLens(nodeById.get(edge.target)));
      const dimmed = focused && !focused.has(edge.source) && !focused.has(edge.target);
      const cls = [
        'edge', `edge-${esc(edge.relation || 'related')}`,
        inTrace ? 'trace' : '', selectedEdge ? 'selected-edge' : '', lensEdge ? 'lens-edge' : '', dimmed ? 'dimmed' : ''
      ].filter(Boolean).join(' ');
      parts.push(`<line class="${cls}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}"><title>${esc(edge.relation || 'related')}</title></line>`);
    });
    parts.push('</g><g class="nodes-layer">');

    graphData.nodes.forEach((node) => {
      if (!allowed.has(node.id)) return;
      const pos = positions.get(node.id);
      if (!pos) return;
      const inFocus = !focused || focused.has(node.id);
      const lensHit = matchesLens(node);
      const isSelected = selectedId === node.id;
      const inTrace = tracePath.includes(node.id);
      const classes = [
        'node', `node-${node.kind}`, isSelected ? 'selected' : '', inTrace ? 'trace-node' : '',
        (!inFocus || (activeLens !== 'all' && !lensHit)) ? 'dimmed' : ''
      ].filter(Boolean).join(' ');
      const live = projectLive(node);
      const state = live?.state || projectStates.get(node.id) || '';
      const tabindex = node.kind === 'core' ? '-1' : '0';
      const common = `class="${classes}" data-node-id="${esc(node.id)}" tabindex="${tabindex}" role="button" aria-label="${esc(`${node.kind}: ${node.label}`)}"`;

      if (node.kind === 'core') {
        parts.push(`<g ${common}><circle cx="${pos.x}" cy="${pos.y}" r="68"/><text class="node-label" x="${pos.x}" y="${pos.y - 4}" text-anchor="middle">ENGINEERING</text><text class="node-sub" x="${pos.x}" y="${pos.y + 16}" text-anchor="middle">CORE</text></g>`);
      } else if (node.kind === 'project') {
        const stateText = state || 'PROJECT';
        parts.push(`<g ${common}><rect x="${pos.x - 87}" y="${pos.y - 36}" rx="15" width="174" height="72"/><circle class="state-dot ${esc(String(stateText).toLowerCase())}" cx="${pos.x - 69}" cy="${pos.y - 20}" r="5"/><text class="node-label project-label" x="${pos.x}" y="${pos.y - 2}" text-anchor="middle">${esc(node.short || node.label)}</text><text class="node-sub" x="${pos.x}" y="${pos.y + 18}" text-anchor="middle">${esc(stateText)}</text></g>`);
      } else if (node.kind === 'capability') {
        parts.push(`<g ${common}><circle cx="${pos.x}" cy="${pos.y}" r="49"/><text class="node-label" x="${pos.x}" y="${pos.y + 4}" text-anchor="middle">${esc(node.short || node.label)}</text></g>`);
      } else {
        parts.push(`<g ${common}><rect x="${pos.x - 65}" y="${pos.y - 25}" rx="10" width="130" height="50"/><text class="node-label evidence-label" x="${pos.x}" y="${pos.y + 4}" text-anchor="middle">${esc(node.short || node.label)}</text></g>`);
      }
    });

    parts.push('</g></g>');
    svg.innerHTML = parts.join('');
    attachGraphNodeHandlers();
    renderGraphStats(allowed);
  }

  function attachGraphNodeHandlers() {
    $$('#graph [data-node-id]').forEach((element) => {
      const activate = () => selectNode(element.dataset.nodeId, { updateHash: true });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        activate();
      });
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      element.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const node = nodeById.get(element.dataset.nodeId);
        if (node?.url) window.open(node.url, '_blank', 'noopener,noreferrer');
      });
    });
  }

  function renderGraphStats(allowed) {
    const nodes = graphData.nodes.filter((node) => allowed.has(node.id));
    const projects = nodes.filter((node) => node.kind === 'project').length;
    const capabilities = nodes.filter((node) => node.kind === 'capability').length;
    const evidence = nodes.filter((node) => node.kind === 'evidence').length;
    $('#graphStats').innerHTML = `<span>${projects} projects</span><span>${capabilities} capabilities</span><span>${evidence} evidence nodes</span>`;
  }

  function selectNode(id, options = {}) {
    if (!nodeById.has(id)) return false;
    selectedId = id;
    tracePath = [];
    renderInspector();
    renderGraph();
    if (options.updateHash) history.replaceState(null, '', `#node=${encodeURIComponent(id)}&lens=${encodeURIComponent(activeLens)}`);
    return true;
  }

  function renderInspector() {
    const node = nodeById.get(selectedId) || nodeById.get(graphData.meta.core_node || 'engineering-core');
    if (!node) return;
    $('#inspectorTitle').textContent = node.label;
    $('#inspectorKind').textContent = node.kind.toUpperCase();
    $('#inspectorDescription').textContent = node.description || '';

    const neighbors = (adjacency.get(node.id) || [])
      .map(({ id, relation }) => ({ node: nodeById.get(id), relation }))
      .filter((item) => item.node)
      .sort((a, b) => a.node.kind.localeCompare(b.node.kind) || a.node.label.localeCompare(b.node.label));

    $('#neighborList').innerHTML = neighbors.length ? neighbors.map(({ node: neighbor, relation }) =>
      `<button type="button" class="neighbor" data-focus-node="${esc(neighbor.id)}"><span>${esc(neighbor.label)}</span><small>${esc(relation)}</small></button>`
    ).join('') : '<span class="muted">No direct connections.</span>';
    $$('[data-focus-node]').forEach((button) => button.addEventListener('click', () => selectNode(button.dataset.focusNode, { updateHash: true })));

    const link = $('#inspectorLink');
    if (node.url) {
      link.href = node.url;
      link.textContent = node.kind === 'project' ? 'Open repository ↗' : 'Open evidence ↗';
      link.classList.remove('hidden');
    } else {
      link.removeAttribute('href');
      link.classList.add('hidden');
    }

    const liveBox = $('#inspectorLive');
    const live = projectLive(node);
    if (live) {
      const workflow = live.workflow || {};
      const release = live.release || {};
      const latest = live.latest_commit || {};
      liveBox.innerHTML = `
        <p class="mini-label">LIVE REPOSITORY STATE</p>
        <dl>
          <div><dt>State</dt><dd>${esc(live.state || 'UNKNOWN')}</dd></div>
          <div><dt>Language</dt><dd>${esc(live.language || '—')}</dd></div>
          <div><dt>Last push</dt><dd>${esc(live.last_push || 'unknown')}</dd></div>
          <div><dt>Commit</dt><dd>${esc(latest.message || 'not available')}</dd></div>
          <div><dt>Workflow</dt><dd>${esc(workflow.conclusion || workflow.status || 'not available')}</dd></div>
          <div><dt>Release</dt><dd>${esc(release.tag || 'none detected')}</dd></div>
        </dl>`;
      liveBox.classList.remove('hidden');
    } else {
      liveBox.innerHTML = '';
      liveBox.classList.add('hidden');
    }
  }

  function shortestPath(startId, endId) {
    if (!nodeById.has(startId) || !nodeById.has(endId)) return [];
    if (startId === endId) return [startId];
    const queue = [startId];
    const previous = new Map([[startId, null]]);
    while (queue.length) {
      const current = queue.shift();
      for (const neighbor of adjacency.get(current) || []) {
        if (previous.has(neighbor.id)) continue;
        previous.set(neighbor.id, current);
        if (neighbor.id === endId) {
          const path = [endId];
          let cursor = current;
          while (cursor) {
            path.push(cursor);
            cursor = previous.get(cursor);
          }
          return path.reverse();
        }
        queue.push(neighbor.id);
      }
    }
    return [];
  }

  function renderTraceSelects() {
    const nodes = graphData.nodes.filter((node) => node.kind !== 'core');
    const options = nodes.map((node) => `<option value="${esc(node.id)}">${esc(node.label)} · ${esc(node.kind)}</option>`).join('');
    $('#traceFrom').innerHTML = options;
    $('#traceTo').innerHTML = options;
    $('#traceFrom').value = 'conformalguard';
    $('#traceTo').value = 'cap-testing';
  }

  function runTrace(startId, endId) {
    const path = shortestPath(startId, endId);
    tracePath = path;
    selectedId = null;
    if (!path.length) {
      $('#traceResult').textContent = 'No connection exists between those nodes in the current graph.';
    } else {
      const labels = path.map((id) => nodeById.get(id)?.label || id);
      $('#traceResult').innerHTML = labels.map((label, index) => `${index ? '<span class="path-arrow">→</span>' : ''}<button type="button" class="path-node" data-focus-node="${esc(path[index])}">${esc(label)}</button>`).join('');
      $$('[data-focus-node]').forEach((button) => button.addEventListener('click', () => selectNode(button.dataset.focusNode, { updateHash: true })));
    }
    renderGraph();
    return path;
  }

  function clearTrace() {
    tracePath = [];
    selectedId = null;
    $('#traceResult').textContent = 'Choose two nodes to reveal their shortest connection.';
    renderInspector();
    renderGraph();
  }

  function renderChips() {
    $('#lensChips').innerHTML = LENSES.map(([id, label]) =>
      `<button type="button" class="chip ${id === activeLens ? 'active' : ''}" data-lens="${id}">${esc(label)}</button>`
    ).join('');
    $$('[data-lens]').forEach((button) => button.addEventListener('click', () => {
      activeLens = button.dataset.lens;
      selectedId = null;
      tracePath = [];
      renderAll();
      history.replaceState(null, '', `#node=${encodeURIComponent(selectedId)}&lens=${encodeURIComponent(activeLens)}`);
    }));
  }

  function scoreProject(project) {
    const graphNode = nodeById.get(project.id);
    if (!graphNode) return 0;
    if (activeLens === 'all') return project.state === 'ACTIVE' ? 4 : 2;
    let score = (graphNode.tags || []).includes(activeLens) ? 4 : 0;
    const linkedCapabilities = (adjacency.get(graphNode.id) || [])
      .map((neighbor) => nodeById.get(neighbor.id))
      .filter((node) => node?.kind === 'capability');
    if (linkedCapabilities.some((node) => (node.tags || []).includes(activeLens))) score += 2;
    if (project.state === 'ACTIVE') score += 1;
    return score;
  }

  function renderStatus() {
    $('#workstream').textContent = profile.workstream || 'Current public work';
    $('#syncText').textContent = `public snapshot · ${relative(profile.generated_at)}`;
    $('#projectStatus').innerHTML = profile.projects.map((project) => {
      const latest = project.latest_commit?.message ? ` · ${esc(project.latest_commit.message)}` : '';
      return `<button type="button" class="status-item ${project.state === 'ACTIVE' ? 'active' : ''}" data-status-project="${esc(project.id)}"><strong>${esc(project.name)}</strong><span class="status-meta">${esc(project.state)} · ${esc(project.language)} · ${esc(project.last_push || '')}${latest}</span></button>`;
    }).join('');
    $$('[data-status-project]').forEach((button) => button.addEventListener('click', () => {
      selectNode(button.dataset.statusProject, { updateHash: true });
      $('#graphCanvasWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

  function renderEvidenceCards() {
    const ordered = [...profile.projects].sort((a, b) => scoreProject(b) - scoreProject(a));
    $('#lensLabel').textContent = lensLabel(activeLens);
    $('#evidenceCards').innerHTML = ordered.map((project) => {
      const score = scoreProject(project);
      const graphNode = nodeById.get(project.id);
      const linkedEvidence = (adjacency.get(project.id) || [])
        .map((neighbor) => nodeById.get(neighbor.id))
        .filter((node) => node?.kind === 'evidence');
      const evidenceSummary = linkedEvidence.slice(0, 3).map((node) => node.label).join(' · ');
      return `<article class="card ${score === 0 ? 'secondary-card' : ''}">
        <button type="button" class="card-main" data-card-project="${esc(project.id)}">
          <div class="score">${activeLens === 'all' ? (project.state === 'ACTIVE' ? 'ACTIVE SYSTEM' : 'PORTFOLIO SYSTEM') : (score ? `MATCH ${'●'.repeat(Math.min(5, score))}` : 'SECONDARY')}</div>
          <h3>${esc(graphNode?.label || project.name)}</h3>
          <p>${esc(graphNode?.description || project.summary)}</p>
          <div class="status-meta">${esc(evidenceSummary || 'Repository evidence')}</div>
        </button>
        <a href="${esc(project.repo)}" target="_blank" rel="noreferrer" class="card-link">repository ↗</a>
      </article>`;
    }).join('');
    $$('[data-card-project]').forEach((button) => button.addEventListener('click', () => {
      selectNode(button.dataset.cardProject, { updateHash: true });
      $('#graphCanvasWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

  function renderActivity() {
    $('#activity').innerHTML = (profile.activity || []).slice(0, 8).map((item) =>
      `<div class="activity-row"><span class="activity-type">${esc(item.type)}</span><span><strong>${esc(item.repo)}</strong> · ${esc(item.detail)}</span><span class="activity-time">${esc(item.when)}</span></div>`
    ).join('') || '<p class="muted">No public activity in the snapshot.</p>';
  }

  function renderSimulator() {
    const shift = Number($('#shift').value);
    const target = Number($('#target').value);
    $('#shiftValue').textContent = `${shift}%`;
    $('#targetValue').textContent = `${target}%`;
    const degradation = Math.pow(shift / 100, 1.35) * (12 + (100 - target) * 0.35);
    const coverage = Math.max(45, Math.min(99, target - degradation));
    $('#coverageValue').textContent = `${coverage.toFixed(1)}%`;
    $('#coverageBar').style.width = `${coverage}%`;
    const gap = target - coverage;
    $('#simExplanation').textContent = gap < 1.5
      ? 'Low shift: the illustrative system remains near its target.'
      : gap < 5
        ? 'Coverage is beginning to drift. This is where diagnostics and recalibration matter.'
        : 'Large shift: nominal guarantees can become misleading if deployment data no longer matches calibration assumptions.';
  }

  function terminalWrite(command, output) {
    const log = $('#terminalLog');
    log.insertAdjacentHTML('beforeend', `<p class="term-row"><span class="term-cmd">› ${esc(command)}</span><br><span class="term-out">${esc(output)}</span></p>`);
    log.scrollTop = log.scrollHeight;
  }

  function findNode(term) {
    const needle = term.trim().toLowerCase();
    if (!needle) return null;
    const exact = graphData.nodes.find((node) => node.id.toLowerCase() === needle || node.label.toLowerCase() === needle);
    if (exact) return exact;
    return graphData.nodes.find((node) => [node.label, node.short, ...(node.tags || [])].join(' ').toLowerCase().includes(needle)) || null;
  }

  function runCommand(raw) {
    const command = raw.trim();
    if (!command) return;
    const lower = command.toLowerCase();
    const [base, ...rest] = lower.split(/\s+/);
    let output = '';

    if (base === 'help') {
      output = 'help · now · projects · graph <term> · focus <node> · path <a> -> <b> · activity · why';
    } else if (base === 'now') {
      output = profile.workstream;
    } else if (base === 'projects') {
      output = profile.projects.map((project) => `${project.name} [${project.state}]`).join(' | ');
    } else if (base === 'activity') {
      output = (profile.activity || []).slice(0, 5).map((item) => `${item.type}: ${item.repo} — ${item.detail} (${item.when})`).join('\n') || 'No activity in snapshot.';
    } else if (base === 'why') {
      output = 'Capabilities are only shown as valuable when projects and inspectable artifacts support them. The graph is a provenance map, not a skill list.';
    } else if (base === 'graph') {
      const term = rest.join(' ');
      const matches = graphData.nodes.filter((node) => [node.label, node.short, node.description, ...(node.tags || [])].join(' ').toLowerCase().includes(term));
      output = matches.length ? matches.slice(0, 8).map((node) => `${node.label} [${node.kind}]`).join(' | ') : `No graph nodes matched: ${term}`;
    } else if (base === 'focus') {
      const node = findNode(rest.join(' '));
      if (node) {
        selectNode(node.id, { updateHash: true });
        output = `Focused ${node.label}.`;
      } else output = 'Node not found.';
    } else if (base === 'path') {
      const expression = command.slice(4).trim();
      const parts = expression.split(/\s*->\s*/);
      if (parts.length !== 2) {
        output = 'Usage: path conformalguard -> verification';
      } else {
        const from = findNode(parts[0]);
        const to = findNode(parts[1]);
        if (!from || !to) output = 'Could not resolve one or both nodes.';
        else {
          const path = runTrace(from.id, to.id);
          output = path.length ? path.map((id) => nodeById.get(id)?.label || id).join(' -> ') : 'No path found.';
        }
      }
    } else {
      output = `Unknown command: ${command}. Try help.`;
    }
    terminalWrite(command, output);
  }

  function applyTransform() {
    const viewport = $('#viewport');
    if (viewport) viewport.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
  }

  function zoomBy(factor, center = { x: GRAPH_BOUNDS.width / 2, y: GRAPH_BOUNDS.height / 2 }) {
    const oldScale = transform.scale;
    const newScale = clamp(oldScale * factor, MIN_SCALE, MAX_SCALE);
    if (newScale === oldScale) return;
    const ratio = newScale / oldScale;
    transform.x = center.x - (center.x - transform.x) * ratio;
    transform.y = center.y - (center.y - transform.y) * ratio;
    transform.scale = newScale;
    applyTransform();
  }

  function fitGraph() {
    transform = { x: 0, y: 0, scale: 1 };
    applyTransform();
  }

  function svgPointFromEvent(event) {
    const svg = $('#graph');
    const rect = svg.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width * GRAPH_BOUNDS.width,
      y: (event.clientY - rect.top) / rect.height * GRAPH_BOUNDS.height
    };
  }

  function attachPanZoom() {
    const svg = $('#graph');
    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = svgPointFromEvent(event);
      zoomBy(event.deltaY < 0 ? 1.12 : 0.89, point);
    }, { passive: false });

    svg.addEventListener('pointerdown', (event) => {
      if (event.target.closest('[data-node-id]')) return;
      svg.setPointerCapture(event.pointerId);
      dragState = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
      svg.classList.add('panning');
    });
    svg.addEventListener('pointermove', (event) => {
      if (!dragState || dragState.id !== event.pointerId) return;
      const rect = svg.getBoundingClientRect();
      transform.x = dragState.tx + (event.clientX - dragState.x) / rect.width * GRAPH_BOUNDS.width;
      transform.y = dragState.ty + (event.clientY - dragState.y) / rect.height * GRAPH_BOUNDS.height;
      applyTransform();
    });
    const finish = (event) => {
      if (!dragState || dragState.id !== event.pointerId) return;
      dragState = null;
      svg.classList.remove('panning');
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
    svg.addEventListener('click', (event) => {
      if (event.target === svg || event.target.classList.contains('edges-layer')) {
        selectedId = null;
        tracePath = [];
        renderInspector();
        renderGraph();
      }
    });
  }

  function parseInitialHash() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const node = params.get('node');
    const lens = params.get('lens');
    if (lens && LENSES.some(([id]) => id === lens)) activeLens = lens;
    if (node && nodeById.has(node)) selectedId = node;
  }

  function renderAll() {
    renderChips();
    renderStatus();
    renderEvidenceCards();
    renderActivity();
    renderGraph();
    renderInspector();
  }

  function attachControls() {
    $('#shift').addEventListener('input', renderSimulator);
    $('#target').addEventListener('input', renderSimulator);

    $('#graphSearch').addEventListener('input', (event) => {
      searchTerm = event.target.value.trim().toLowerCase();
      renderGraph();
    });

    $$('.kind-filter input[type="checkbox"]').forEach((checkbox) => checkbox.addEventListener('change', () => {
      visibleKinds = new Set(['core', ...$$('.kind-filter input[type="checkbox"]:checked').map((input) => input.value)]);
      renderGraph();
    }));

    $('#zoomIn').addEventListener('click', () => zoomBy(1.18));
    $('#zoomOut').addEventListener('click', () => zoomBy(0.84));
    $('#fitGraph').addEventListener('click', fitGraph);
    $('#resetGraph').addEventListener('click', () => {
      activeLens = 'all';
      selectedId = null;
      tracePath = [];
      searchTerm = '';
      visibleKinds = new Set(['core', 'project', 'capability', 'evidence']);
      transform = { x: 0, y: 0, scale: 1 };
      $('#graphSearch').value = '';
      $$('.kind-filter input[type="checkbox"]').forEach((input) => { input.checked = true; });
      $('#traceResult').textContent = 'Choose two nodes to reveal their shortest connection.';
      renderAll();
    });

    $('#traceButton').addEventListener('click', () => runTrace($('#traceFrom').value, $('#traceTo').value));
    $('#clearTrace').addEventListener('click', clearTrace);

    $('#terminalForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('#terminalInput');
      runCommand(input.value);
      input.value = '';
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        event.preventDefault();
        $('#terminalInput').focus();
      }
      if (event.key === 'Escape' && document.activeElement === $('#terminalInput')) {
        $('#terminalInput').blur();
      }
    });

    attachPanZoom();
  }

  async function loadJson(path, fallback) {
    try {
      const response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      console.warn(`Could not load ${path}`, error);
      return fallback;
    }
  }

  async function init() {
    [profile, graphData] = await Promise.all([
      loadJson('./data/profile.json', PROFILE_FALLBACK),
      loadJson('./data/graph.json', { nodes: [], edges: [], meta: {} })
    ]);

    buildGraphIndex();
    parseInitialHash();
    renderTraceSelects();
    renderAll();
    renderSimulator();
    attachControls();
    terminalWrite('boot', `Graph runtime ready: ${graphData.nodes.length} nodes / ${graphData.edges.length} relationships.`);
  }

  init();
})();
