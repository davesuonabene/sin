/**
 * @sin/graph-view
 * Modern, slim, high-performance SVG graph visualization for SIN canonical graphs.
 * Designed specifically for GAIA's sleek dark theme with zero rasterization overhead.
 */

export class GraphView {
  constructor(container, options = {}) {
    if (typeof container === 'string') {
      this.container = document.querySelector(container);
    } else {
      this.container = container;
    }
    if (!this.container) {
      throw new Error("GraphView container element not found.");
    }

    this.options = {
      theme: 'dark',
      nodeWidth: 184,
      nodeHeight: 38,
      onNodeSelect: null,
      ...options,
    };

    this.graph = null;
    this.positions = {};
    this.selectedNodeId = null;
    this.scale = 1.0;
    this.panX = 20;
    this.panY = 20;
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };

    this._initDom();
    this._attachEvents();
  }

  _initDom() {
    this.container.innerHTML = '';
    this.container.classList.add('sin-graph-view-wrapper');

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'sin-graph-svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');

    // Zoom/Pan root group
    this.viewportGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.viewportGroup.setAttribute('class', 'sin-graph-viewport');
    this.svg.appendChild(this.viewportGroup);

    this.wiresGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.wiresGroup.setAttribute('class', 'sin-graph-wires');
    this.viewportGroup.appendChild(this.wiresGroup);

    this.nodesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.nodesGroup.setAttribute('class', 'sin-graph-nodes');
    this.viewportGroup.appendChild(this.nodesGroup);

    this.container.appendChild(this.svg);
    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById('sin-graph-view-styles')) return;
    const style = document.createElement('style');
    style.id = 'sin-graph-view-styles';
    style.textContent = `
      .sin-graph-view-wrapper {
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 80px;
        background: #0d1117;
        overflow: hidden;
        user-select: none;
      }
      .sin-graph-svg {
        display: block;
        width: 100%;
        height: 100%;
        cursor: grab;
      }
      .sin-graph-svg:active {
        cursor: grabbing;
      }
      .sin-node-card {
        cursor: pointer;
        transition: opacity 0.15s ease;
      }
      .sin-node-card:hover rect.node-bg {
        stroke: #58a6ff !important;
      }
      .sin-node-card.selected rect.node-bg {
        stroke: #f5d799 !important;
        stroke-width: 1.5px !important;
      }
      .sin-node-card.muted {
        opacity: 0.4;
      }
      .sin-wire {
        fill: none;
        stroke-linecap: round;
        transition: stroke 0.15s ease, stroke-width 0.15s ease;
      }
      .sin-wire:hover {
        stroke: #ffffff !important;
        stroke-width: 2.5px !important;
      }
    `;
    document.head.appendChild(style);
  }

  _attachEvents() {
    this.svg.addEventListener('mousedown', (e) => {
      if (e.target.closest('.sin-node-card')) return;
      this.isDragging = true;
      this.dragStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.panX = e.clientX - this.dragStart.x;
      this.panY = e.clientY - this.dragStart.y;
      this._updateTransform();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      this.scale = Math.min(Math.max(this.scale * zoomFactor, 0.45), 1.6);
      this._updateTransform();
    }, { passive: false });

    this.svg.addEventListener('dblclick', (e) => {
      if (e.target.closest('.sin-node-card')) return;
      this.autoFit();
    });
  }

  _updateTransform() {
    this.viewportGroup.setAttribute(
      'transform',
      `translate(${this.panX}, ${this.panY}) scale(${this.scale})`
    );
  }

  setGraph(sinGraphDoc, positions = null) {
    this.graph = sinGraphDoc || { nodes: [], connections: [] };
    this.positions = positions ? { ...positions } : {};
    this._computeFallbackPositions();
    this.render();
    this.autoFit();
  }

  autoFit() {
    const nodes = this.graph?.nodes || [];
    if (!nodes.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      const pos = this.positions[node.id];
      if (!pos) continue;
      minX = Math.min(minX, pos[0]);
      minY = Math.min(minY, pos[1]);
      maxX = Math.max(maxX, pos[0] + this.options.nodeWidth);
      maxY = Math.max(maxY, pos[1] + this.options.nodeHeight);
    }

    if (!isFinite(minX)) return;

    const graphW = maxX - minX;
    const graphH = maxY - minY;
    const containerW = this.container.clientWidth || 600;
    const containerH = this.container.clientHeight || 120;

    const paddingX = 24;
    const paddingY = 16;
    const scaleX = (containerW - paddingX * 2) / Math.max(100, graphW);
    const scaleY = (containerH - paddingY * 2) / Math.max(40, graphH);
    this.scale = Math.min(Math.max(Math.min(scaleX, scaleY), 0.5), 1.05);

    this.panX = Math.round((containerW - graphW * this.scale) / 2 - minX * this.scale);
    this.panY = Math.round((containerH - graphH * this.scale) / 2 - minY * this.scale);

    this._updateTransform();
  }

  _computeFallbackPositions() {
    const nodes = this.graph.nodes || [];
    if (Object.keys(this.positions).length >= nodes.length) return;

    // Linear chain layout for master sample processing
    let curX = 40;
    const y = 35;

    for (const node of nodes) {
      if (this.positions[node.id]) continue;
      this.positions[node.id] = [curX, y];
      curX += 214;
    }
  }

  render() {
    this.wiresGroup.innerHTML = '';
    this.nodesGroup.innerHTML = '';
    if (!this.graph) return;

    const nodes = this.graph.nodes || [];
    const conns = this.graph.connections || [];

    // Draw wires first
    for (const conn of conns) {
      const fromPos = this.positions[conn.from];
      const toPos = this.positions[conn.to];
      if (!fromPos || !toPos) continue;

      const x1 = fromPos[0] + this.options.nodeWidth;
      const y1 = fromPos[1] + this.options.nodeHeight / 2;
      const x2 = toPos[0];
      const y2 = toPos[1] + this.options.nodeHeight / 2;

      const dx = Math.max(25, Math.abs(x2 - x1) * 0.45);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

      const color = conn.to === 'master' ? '#4ade80' : '#38bdf8';

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'sin-wire');
      path.setAttribute('d', d);
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-opacity', '0.75');
      path.setAttribute('data-from', conn.from);
      path.setAttribute('data-to', conn.to);
      this.wiresGroup.appendChild(path);

      // Port indicator dots
      const dot1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot1.setAttribute('cx', x1);
      dot1.setAttribute('cy', y1);
      dot1.setAttribute('r', '2.5');
      dot1.setAttribute('fill', color);
      this.wiresGroup.appendChild(dot1);

      const dot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot2.setAttribute('cx', x2);
      dot2.setAttribute('cy', y2);
      dot2.setAttribute('r', '2.5');
      dot2.setAttribute('fill', color);
      this.wiresGroup.appendChild(dot2);
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = this.positions[node.id] || [40, 35];
      const card = this._createNodeElement(node, pos[0], pos[1]);
      this.nodesGroup.appendChild(card);
    }

    this._updateTransform();
  }

  _createNodeElement(node, x, y) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `sin-node-card node-${node.type}`);
    g.setAttribute('id', `node-card-${node.id}`);
    g.setAttribute('transform', `translate(${x}, ${y})`);

    let badgeColor = '#38bdf8';
    let badgeText = 'SAMPLE';
    if (node.role === 'master' || node.id === 'master') {
      badgeColor = '#f59e0b';
      badgeText = 'MASTER';
    } else if (node.type === 'track') {
      badgeColor = '#4ade80';
      badgeText = 'BUS';
    }

    const props = node.properties || {};
    const title = props.node_name || node.name || node.id;

    // Check mute
    let isMuted = false;
    for (const mod of (props.chain || [])) {
      if (mod.id === 'mute' && mod.enabled) {
        isMuted = true;
        break;
      }
    }
    if (isMuted) g.classList.add('muted');

    const w = this.options.nodeWidth;
    const h = this.options.nodeHeight;

    this._setSvgInner(g, `
      <rect class="node-bg" width="${w}" height="${h}" rx="4" fill="#161b22" stroke="#30363d" stroke-width="1" />
      <rect x="0" y="0" width="3" height="${h}" rx="1" fill="${badgeColor}" />
      <text x="8" y="14" font-family="monospace" font-size="8" font-weight="700" fill="${badgeColor}" letter-spacing="0.5">
        ${badgeText}
      </text>
      <text class="node-title" x="48" y="14" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="10.5" font-weight="600" fill="#e6edf3">
        ${this._escape(this._truncate(title, 18))}
      </text>
      <text class="node-detail-tag" x="8" y="28" font-family="monospace" font-size="9" fill="#8b949e">
        ${this._getNodeDetail(node)}
      </text>
    `);

    g.addEventListener('click', (e) => {
      e.stopPropagation();
      this.highlightNode(node.id);
      if (typeof this.options.onNodeSelect === 'function') {
        this.options.onNodeSelect(node);
      }
    });

    return g;
  }

  _getNodeDetail(node) {
    const props = node.properties || {};
    if (node.type === 'sample') {
      const start = props.crop_start !== undefined ? Number(props.crop_start).toFixed(2) : '0.00';
      const end = props.crop_end !== undefined ? Number(props.crop_end).toFixed(2) : '1.00';
      const prefix = props.crop_label ? `${this._truncate(props.crop_label, 8)} ` : 'Crop ';
      let timeStr = '';
      if (props.crop_start_sec !== undefined && props.crop_end_sec !== undefined) {
        timeStr = ` (${Number(props.crop_start_sec).toFixed(1)}s-${Number(props.crop_end_sec).toFixed(1)}s)`;
      }
      return `${prefix}[${start}..${end}]${timeStr}`;
    }
    if (node.type === 'track') {
      if (node.role === 'master' || node.id === 'master') {
        return 'Stereo Master Out';
      }
      let vol = 1.0;
      let preDb = 0.0;
      for (const mod of (props.chain || [])) {
        if (mod.id === 'fader' && mod.params?.gain !== undefined) {
          vol = mod.params.gain;
        } else if (mod.id === 'pre' && mod.params) {
          if (mod.params.gain_db !== undefined) preDb = Number(mod.params.gain_db);
          else if (mod.params.gain !== undefined && mod.params.gain > 0) preDb = 20 * Math.log10(mod.params.gain);
        }
      }
      const preStr = preDb >= 0 ? `+${preDb.toFixed(1)}` : preDb.toFixed(1);
      return `Gain: ${preStr}dB · Vol: ${Math.round(vol * 100)}%`;
    }
    return '';
  }

  highlightNode(nodeId) {
    this.selectedNodeId = nodeId;
    const cards = this.nodesGroup.querySelectorAll('.sin-node-card');
    cards.forEach(card => {
      if (card.id === `node-card-${nodeId}`) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });

    // Dim or highlight wires
    const wires = this.wiresGroup.querySelectorAll('.sin-wire');
    wires.forEach(wire => {
      const from = wire.getAttribute('data-from');
      const to = wire.getAttribute('data-to');
      if (nodeId && (from === nodeId || to === nodeId)) {
        wire.style.strokeOpacity = '1.0';
        wire.style.strokeWidth = '2.5px';
      } else if (nodeId) {
        wire.style.strokeOpacity = '0.25';
        wire.style.strokeWidth = '1px';
      } else {
        wire.style.strokeOpacity = '0.75';
        wire.style.strokeWidth = '1.5px';
      }
    });
  }

  updateCrop(nodeId, startRatio, endRatio, startSec = null, endSec = null, label = null) {
    const node = this.graph?.nodes?.find(n => n.id === nodeId);
    if (!node) return;
    if (!node.properties) node.properties = {};
    node.properties.crop_start = Number(startRatio);
    node.properties.crop_end = Number(endRatio);
    if (startSec !== null) node.properties.crop_start_sec = Number(startSec);
    if (endSec !== null) node.properties.crop_end_sec = Number(endSec);
    if (label !== null) node.properties.crop_label = label;
    else delete node.properties.crop_label;

    const card = this.nodesGroup.querySelector(`#node-card-${nodeId}`);
    if (card) {
      const tag = card.querySelector('.node-detail-tag');
      if (tag) tag.textContent = this._getNodeDetail(node);
    }
  }

  updateNodeProperty(nodeId, propertyPath, value) {
    const card = this.nodesGroup.querySelector(`#node-card-${nodeId}`);
    if (!card) return;

    if (propertyPath.endsWith('mute.enabled')) {
      if (value) card.classList.add('muted');
      else card.classList.remove('muted');
    }

    const tag = card.querySelector('.node-detail-tag');
    if (tag) {
      const node = this.graph?.nodes?.find(n => n.id === nodeId);
      if (node) {
        if (propertyPath.includes('chain.fader.params.gain')) {
          const mod = (node.properties?.chain || []).find(m => m.id === 'fader');
          if (mod) mod.params = { ...mod.params, gain: Number(value) };
        } else if (propertyPath.includes('chain.pre.params.gain')) {
          const mod = (node.properties?.chain || []).find(m => m.id === 'pre');
          if (mod) mod.params = { ...mod.params, gain: Number(value) };
        } else if (propertyPath.includes('chain.mute.enabled')) {
          const mod = (node.properties?.chain || []).find(m => m.id === 'mute');
          if (mod) mod.enabled = Boolean(value);
        } else if (propertyPath.endsWith('crop_start')) {
          if (node.properties) node.properties.crop_start = Number(value);
        } else if (propertyPath.endsWith('crop_end')) {
          if (node.properties) node.properties.crop_end = Number(value);
        } else if (propertyPath.endsWith('crop_label')) {
          if (node.properties) node.properties.crop_label = value;
        }
        tag.textContent = this._getNodeDetail(node);
      }
    }
  }

  _setSvgInner(element, svgString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${svgString}</svg>`,
      'image/svg+xml'
    );
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      console.error('SVG parse error in GraphView:', parserError.textContent, svgString);
    }
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
    const children = Array.from(doc.documentElement.childNodes);
    for (const child of children) {
      element.appendChild(document.importNode(child, true));
    }
  }

  _truncate(str, maxLen = 18) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
  }

  _escape(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }
}
