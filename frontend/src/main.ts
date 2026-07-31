import './style.css';
import { DockviewComponent, type IDockviewPanel } from 'dockview-core';
import { LGraph, LGraphCanvas, LiteGraph } from 'litegraph.js';
import './nodes/TrackNode';
import './nodes/SampleNode';
import './nodes/SequenceNode';
import './nodes/SamplePoolNode';
import './nodes/ArrangementNode';
import './nodes/ModulatorNode';
import { PropertiesWindow } from './ui/PropertiesWindow';
import { NodePopupMenu } from './ui/NodePopupMenu';
import { LibraryPanel } from './ui/LibraryPanel';

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Could not find #app element');

appElement.className = 'dockview-theme-light';

// Instantiate Node Type Popup Menu
const popupMenu = new NodePopupMenu();

// --- Toolbar UI (holds master player when audio is rendered) ---
const toolbar = document.createElement('div');
toolbar.style.position = 'absolute';
toolbar.style.top = '10px';
toolbar.style.left = '10px';
toolbar.style.zIndex = '1000';
toolbar.style.display = 'none'; // Hidden by default for a clean screen
toolbar.style.gap = '10px';
toolbar.style.alignItems = 'center';
toolbar.style.background = 'rgba(255, 255, 255, 0.9)';
toolbar.style.padding = '8px 12px';
toolbar.style.borderRadius = '8px';
toolbar.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
toolbar.style.backdropFilter = 'blur(4px)';

const masterPlayer = document.createElement('audio');
masterPlayer.id = 'master-player';
masterPlayer.controls = true;
masterPlayer.style.display = 'none';
masterPlayer.style.height = '36px';

const tempFilesSelect = document.createElement('select');
tempFilesSelect.id = 'temp-files-select';
tempFilesSelect.style.padding = '6px';
tempFilesSelect.style.borderRadius = '4px';
tempFilesSelect.style.border = '1px solid #ccc';
tempFilesSelect.style.background = '#fff';
tempFilesSelect.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    if (val) {
        masterPlayer.src = `${val}?t=${Date.now()}`;
        masterPlayer.play().catch(e => console.error("Play failed", e));
    }
});

const exportBtn = document.createElement('button');
exportBtn.id = 'export-btn';
exportBtn.textContent = "Download";
exportBtn.style.marginLeft = '10px';
exportBtn.style.padding = '6px 10px';
exportBtn.style.background = '#10b981';
exportBtn.style.color = '#fff';
exportBtn.style.border = 'none';
exportBtn.style.cursor = 'pointer';
exportBtn.style.borderRadius = '4px';
exportBtn.style.fontSize = '12px';

exportBtn.addEventListener('click', async () => {
    const selectedOption = tempFilesSelect.options[tempFilesSelect.selectedIndex];
    if (!selectedOption) return;

    const filename = selectedOption.textContent;
    if (!filename) return;

    try {
        const res = await fetch('/api/renders/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const data = await res.json();
        if (data.status === 'success' && data.file_url) {
            // Trigger actual download in browser
            const a = document.createElement('a');
            a.href = data.file_url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Refresh temp list
            await updateTempRendersList();
        } else {
            alert("Export failed: " + (data.detail || 'Unknown error'));
        }
    } catch (err) {
        console.error(err);
        alert("Export failed");
    }
});

toolbar.appendChild(tempFilesSelect);
toolbar.appendChild(masterPlayer);
toolbar.appendChild(exportBtn);
appElement.appendChild(toolbar);

async function updateTempRendersList(selectFilename?: string) {
    try {
        const res = await fetch('/api/renders/temp');
        const data = await res.json();

        tempFilesSelect.innerHTML = ''; // clear options

        if (data.files && data.files.length > 0) {
            toolbar.style.display = 'flex';
            data.files.forEach((f: any) => {
                const opt = document.createElement('option');
                opt.value = f.url;
                opt.textContent = f.filename;
                tempFilesSelect.appendChild(opt);
            });

            if (selectFilename) {
                for (let i = 0; i < tempFilesSelect.options.length; i++) {
                    if (tempFilesSelect.options[i].textContent === selectFilename) {
                        tempFilesSelect.selectedIndex = i;
                        break;
                    }
                }
            }

            // Update player src to currently selected
            const selectedOpt = tempFilesSelect.options[tempFilesSelect.selectedIndex];
            if (selectedOpt) {
                masterPlayer.src = `${selectedOpt.value}?t=${Date.now()}`;
                masterPlayer.style.display = 'block';
            }
        } else {
            // No files left
            toolbar.style.display = 'none';
            masterPlayer.pause();
            masterPlayer.src = '';
        }
    } catch (err) {
        console.error("Failed to update temp renders list", err);
    }
}

// Initial fetch
updateTempRendersList();
// ------------------

LiteGraph.NODE_TITLE_HEIGHT = 44;
LiteGraph.NODE_TITLE_TEXT_Y = 27;
LiteGraph.NODE_SLOT_HEIGHT = 0;
LiteGraph.NODE_WIDGET_HEIGHT = 0;
LiteGraph.NODE_WIDTH = 200;
LiteGraph.NODE_MIN_WIDTH = 200;
LiteGraph.NODE_COLLAPSED_RADIUS = 0;
LiteGraph.NODE_COLLAPSED_WIDTH = 80;
LiteGraph.NODE_TEXT_SIZE = 13;
LiteGraph.NODE_SUBTEXT_SIZE = 0;
LiteGraph.NODE_DEFAULT_SHAPE = "box" as any;

// Cable Breaker cursor SVG Data URI
const BREAKER_CURSOR = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23ef4444' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='6' cy='6' r='3'/><circle cx='6' cy='18' r='3'/><line x1='8.5' y1='7.5' x2='18' y2='17'/><line x1='8.5' y1='16.5' x2='18' y2='7'/></svg>") 12 12, pointer`;

let hoveredLink: any = null;

function getDistanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
}

// Monkey-patch LGraphNode.prototype.connect to redirect connections to free slots
// Or dynamically allocate a new input slot if all existing slots are occupied.
const originalConnect = (LiteGraph as any).LGraphNode.prototype.connect;
(LiteGraph as any).LGraphNode.prototype.connect = function (slot: any, target_node: any, target_slot: any) {
    let t_node = target_node;
    if (t_node && t_node.constructor === Number) {
        t_node = this.graph.getNodeById(t_node);
    }
    if (t_node && t_node.inputs) {
        let freeSlotIndex = -1;
        for (let i = 0; i < t_node.inputs.length; i++) {
            if (t_node.inputs[i].link == null) {
                freeSlotIndex = i;
                break;
            }
        }
        if (freeSlotIndex !== -1) {
            target_slot = freeSlotIndex;
        } else {
            // Allocate a new slot on the fly if all are occupied
            if (typeof t_node.addInput === 'function') {
                t_node.addInput("Input", "audio");
                target_slot = t_node.inputs.length - 1;
            }
        }
    }
    return originalConnect.call(this, slot, target_node, target_slot);
};

// Monkey-patch LGraphCanvas.prototype.processMouseUp for Cable to Nothing node selector
const originalProcessMouseUp = (LiteGraph as any).LGraphCanvas.prototype.processMouseUp;
(LiteGraph as any).LGraphCanvas.prototype.processMouseUp = function (e: MouseEvent) {
    const connectingNode = this.connecting_node;
    const connectingOutput = (this as any).connecting_output;
    const connectingInput = (this as any).connecting_input;
    const connectingSlotObj = (this as any).connecting_slot;
    const nodeOver = this.node_over;

    const res = originalProcessMouseUp.call(this, e);

    // If dragging a connection wire and released over empty space (no node_over)
    if (connectingNode && !nodeOver) {
        const offset = this.convertEventToCanvasOffset(e);
        const canvasPos: [number, number] = [offset[0], offset[1]];
        const clientX = e.clientX;
        const clientY = e.clientY;

        let isOutput = true;
        let slotIndex = 0;

        if (connectingInput != null) {
            isOutput = false;
            if (connectingNode.inputs) {
                const idx = connectingNode.inputs.indexOf(connectingInput);
                if (idx !== -1) slotIndex = idx;
            }
        } else if (connectingOutput != null) {
            isOutput = true;
            if (connectingNode.outputs) {
                const idx = connectingNode.outputs.indexOf(connectingOutput);
                if (idx !== -1) slotIndex = idx;
            }
        } else if (typeof connectingSlotObj === 'number') {
            slotIndex = connectingSlotObj;
            if (connectingNode.inputs && connectingNode.inputs[slotIndex] === connectingSlotObj) {
                isOutput = false;
            }
        }

        popupMenu.show(clientX, clientY, (nodeType) => {
            const newNode = addRootNode(nodeType, canvasPos);
            if (newNode && connectingNode) {
                if (isOutput) {
                    connectingNode.connect(slotIndex, newNode, 0);
                } else {
                    newNode.connect(0, connectingNode, slotIndex);
                }
                if (this.graph) {
                    syncGraphHierarchy(this.graph);
                    updateGraphNodeCollapsing();
                }
                this.setDirty(true, true);
            }
        });
    }

    return res;
};

// Monkey-patch LGraphCanvas.prototype.drawNode to suppress node box in collapsed dot mode
const originalDrawNode = (LiteGraph as any).LGraphCanvas.prototype.drawNode;
(LiteGraph as any).LGraphCanvas.prototype.drawNode = function (node: any, ctx: CanvasRenderingContext2D) {
    if (node && (node.flags?.hidden || (node as any).collapsedDotMode)) {
        return;
    }
    return originalDrawNode.call(this, node, ctx);
};

// Monkey-patch LGraphCanvas.prototype.getNodeOnPos for collapsed dot hit testing
const originalGetNodeOnPos = (LiteGraph as any).LGraphCanvas.prototype.getNodeOnPos;
(LiteGraph as any).LGraphCanvas.prototype.getNodeOnPos = function (x: number, y: number, nodes_list: any[], margin: number) {
    const targetList = nodes_list || (this.graph ? (this.graph as any)._nodes : null);
    if (targetList) {
        for (let i = targetList.length - 1; i >= 0; i--) {
            const n = targetList[i];
            if (!n || n.flags?.hidden) continue;
            if ((n as any).collapsedDotMode) {
                const modWidth = n.size ? n.size[0] : 180;
                const dotX = n.pos[0] + modWidth * 0.5;
                const dotY = n.pos[1] + 10;
                const dist = Math.hypot(x - dotX, y - dotY);
                if (dist <= 16) {
                    return n;
                }
            }
        }
    }
    const filteredList = nodes_list ? nodes_list.filter((n: any) => !(n && (n.flags?.hidden || (n as any).collapsedDotMode))) : undefined;
    return originalGetNodeOnPos.call(this, x, y, filteredList, margin);
};

// Custom renderLink override:
// 1. Keeps slate color when moving nodes (prevents white highlight flash)
// 2. Removes center anchor dots
// 3. Renders full unbroken straight lines from Point A to Point B without input/output stub breaks
// 4. Highlights cable in bright red (#ef4444) when hovered by Breaker cursor
(LiteGraph as any).LGraphCanvas.prototype.renderLink = function (
    ctx: CanvasRenderingContext2D,
    a: [number, number],
    b: [number, number],
    link: any,
    _skip_border?: boolean,
    _flow?: boolean,
    color?: string
) {
    if (link) {
        this.visible_links.push(link);
    }

    const isHovered = hoveredLink && link && link.id === hoveredLink.id;
    const lineColor = isHovered ? "#ef4444" : (color || (link && link.color) || "#94a3b8");

    ctx.save();
    ctx.lineWidth = isHovered ? (this.connections_width || 2) + 1.5 : (this.connections_width || 2);
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = lineColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Direct 1-to-1 full unbroken straight line
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();

    ctx.restore();
};

// Direct linear connections (Single straight line A -> B without turns)
LiteGraph.LINEAR_LINK = 1;
LiteGraph.LINK_COLOR = "#94a3b8"; // Light slate
LiteGraph.CONNECTING_LINK_COLOR = "#94a3b8";
LiteGraph.EVENT_LINK_COLOR = "#94a3b8";
LiteGraph.NODE_TEXT_COLOR = "#ffffff";
LiteGraph.NODE_TITLE_COLOR = "#ffffff";

export interface TrackNodeData {
    id: number;
    type: "track" | "sample" | "sequence" | "sample_pool" | "arrangement" | "modulator";
    name: string;
    filepath: string;
    original_bpm: number;
    target_bpm?: number;
    key?: string;
    start_beat: number;
    bpm?: number;
    mix_mode: string;
    sequence?: number[];
    step_length?: number;
    total_bars?: number;
    probability?: number;
    filters?: any;
    playbackMode?: string;
    seed?: number;
    refresh_mode?: string;
    chain?: any[];
    modulators?: number[];
    parentId: number | null;
    children: number[];
}

export function extractMetadataFromPath(filepath: string): { bpm: number | null; key: string | null } {
    if (!filepath) return { bpm: null, key: null };
    const cleanText = filepath.replace(/[/_\\-]/g, ' ');

    const bpmMatch = cleanText.match(/(?<!\d)(\d{2,3})\s*bpm\b/i);
    const bpm = bpmMatch ? parseInt(bpmMatch[1], 10) : null;

    let key: string | null = null;
    const camelotMatch = cleanText.match(/\b(1[0-2]|[1-9])[ab]\b/i);
    if (camelotMatch) {
        key = camelotMatch[0].toUpperCase();
    } else {
        const standardMatch = cleanText.match(/\b([a-g][#b]?\s*(?:min|maj|minor|major|m(?![ix])))\b/i);
        if (standardMatch) {
            const raw = standardMatch[0].trim();
            key = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        }
    }
    return { bpm, key };
}

const trackNodes = new Map<number, TrackNodeData>();
(window as any).trackNodes = trackNodes;

let activeParamNodeId: number | null = null;

function closeAllParamWindows(exceptNodeId?: number) {
    const dv = (window as any).dockview;
    if (!dv) return;
    const panels = dv.panels || [];
    for (const p of panels) {
        if (p.id && p.id.startsWith('properties_')) {
            const idNum = parseInt(p.id.replace('properties_', ''), 10);
            if (exceptNodeId == null || idNum !== exceptNodeId) {
                p.api.close();
            }
        }
    }
}

function isNodeInSubtree(nodeId: number, targetId: number): boolean {
    if (nodeId === targetId) return true;
    const data = trackNodes.get(nodeId);
    if (!data || !data.children) return false;
    for (const childId of data.children) {
        if (isNodeInSubtree(childId, targetId)) return true;
    }
    return false;
}

function isChildParamShown(parentId: number): boolean {
    if (activeParamNodeId === null) return false;
    const parentData = trackNodes.get(parentId);
    if (!parentData || !parentData.children) return false;
    for (const childId of parentData.children) {
        if (isNodeInSubtree(childId, activeParamNodeId)) return true;
    }
    return false;
}

function syncBpmInheritance(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 10) {
        changed = false;
        iterations++;
        for (const [nodeId, data] of trackNodes.entries()) {
            if (data.parentId != null) {
                const parentData = trackNodes.get(data.parentId);
                const parentNodeObj = targetGraph.getNodeById(data.parentId);
                const parentTargetBpm = parentData?.target_bpm ?? parentData?.bpm ?? parentNodeObj?.properties?.target_bpm ?? parentNodeObj?.properties?.bpm ?? 120;
                
                if (data.target_bpm !== parentTargetBpm || data.bpm !== parentTargetBpm) {
                    data.target_bpm = parentTargetBpm;
                    data.bpm = parentTargetBpm;
                    changed = true;
                    
                    const nodeObj = targetGraph.getNodeById(nodeId);
                    if (nodeObj && nodeObj.properties) {
                        nodeObj.properties.target_bpm = parentTargetBpm;
                        nodeObj.properties.bpm = parentTargetBpm;
                    }
                }
            }
        }
    }
}

(window as any).syncBpmInheritance = () => syncBpmInheritance();

function syncGraphHierarchy(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;

    for (const data of trackNodes.values()) {
        data.parentId = null;
        data.children = [];
    }

    if ((targetGraph as any).links) {
        const links = (targetGraph as any).links;
        for (const linkId in links) {
            const link = links[linkId];
            if (!link) continue;

            const childId = link.origin_id;
            const parentId = link.target_id;

            const childData = trackNodes.get(childId);
            const parentData = trackNodes.get(parentId);

            if (childData) {
                childData.parentId = parentId;
            }
            if (parentData) {
                if (!parentData.children.includes(childId)) {
                    parentData.children.push(childId);
                }
            }
        }
    }

    syncBpmInheritance(targetGraph);
}

window.addEventListener('graph-connections-changed', () => {
    syncGraphHierarchy();
    updateGraphNodeCollapsing();
});

function updateGraphNodeCollapsing() {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    syncGraphHierarchy(graph);

    const canvas = (window as any).editorCanvas as LGraphCanvas;
    const selectedMap = canvas?.selected_nodes || {};

    for (const [nodeId, data] of trackNodes.entries()) {
        const lgraphNode = graph.getNodeById(nodeId);
        if (!lgraphNode) continue;

        if (data.type === "modulator" || lgraphNode.type === "Audio/Modulator") {
            const parentId = data.parentId || lgraphNode.properties?.parentId;

            const isParentSelected = parentId != null && Boolean(selectedMap[parentId]);
            const isSelfSelected = Boolean(selectedMap[nodeId]);

            if (isParentSelected || isSelfSelected) {
                lgraphNode.flags.collapsed = false;
                (lgraphNode as any).flags.hidden = false;
                (lgraphNode as any).collapsedDotMode = false;
            } else {
                lgraphNode.flags.collapsed = true;
                (lgraphNode as any).flags.hidden = false;
                (lgraphNode as any).collapsedDotMode = true;

                if (activeParamNodeId === nodeId) {
                    closeAllParamWindows();
                }
            }
        } else if (data.parentId === null) {
            lgraphNode.flags.collapsed = false;
            (lgraphNode as any).flags.hidden = false;
        } else {
            const isSelfWindowOpen = (activeParamNodeId === nodeId);
            const isSelfChildParamOpen = isChildParamShown(nodeId);

            if (isSelfWindowOpen || isSelfChildParamOpen) {
                lgraphNode.flags.collapsed = false;
                (lgraphNode as any).flags.hidden = false;
            } else {
                lgraphNode.flags.collapsed = true;
                (lgraphNode as any).flags.hidden = false;
            }
        }
    }

    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
}

function openParamWindow(node: any) {
    if (!node || node.id == null) return;
    if (node.type !== "Audio/Track" && node.type !== "Audio/Sample" && node.type !== "Audio/Sequence" && node.type !== "Audio/SamplePool" && node.type !== "Audio/Arrangement" && node.type !== "Audio/Modulator") return;

    const dv = (window as any).dockview;

    // Ensure at most ONE param window is open at any time
    closeAllParamWindows(node.id);

    (window as any)._currentlySelectedNode = node;
    activeParamNodeId = node.id;

    updateGraphNodeCollapsing();

    if (!dv) return;

    const panelId = `properties_${node.id}`;
    let panel = dv.getGroupPanel(panelId) as IDockviewPanel | undefined;

    if (panel) {
        panel.api.setActive();
        return;
    }

    panel = dv.addPanel({
        id: panelId,
        component: 'properties-panel',
        title: `Node Properties`,
        params: {
            nodeId: node.id
        }
    });

    if (panel) {
        const width = node.type === "Audio/Sequence" ? 540 : 380;
        const height = 440;
        const rightX = Math.max(20, window.innerWidth - width - 40);
        const topY = 40;

        dv.addFloatingGroup(panel as any, {
            x: rightX,
            y: topY,
            width: width,
            height: height
        });
    }
}

window.addEventListener('open-add-menu', (e: any) => {
    const parentId = e.detail?.parentId;
    const x = e.detail?.x || 100;
    const y = e.detail?.y || 100;
    popupMenu.show(x, y, (nodeType) => {
        if (parentId != null) {
            addChildNode(parentId, nodeType);
        } else {
            addRootNode(nodeType);
        }
    });
});

window.addEventListener('add-child-node', (e: any) => {
    const parentId = e.detail?.parentId;
    const nodeType = e.detail?.nodeType || "sample";
    if (parentId != null) {
        addChildNode(parentId, nodeType);
    }
});

window.addEventListener('add-modulator-node', (e: any) => {
    const parentId = e.detail?.parentId;
    if (parentId != null) {
        addModulatorNode(parentId);
    }
});

function addModulatorNode(parentId: number) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const parentNode = graph.getNodeById(parentId);
    if (!parentNode) return;

    const parentData = trackNodes.get(parentId);

    let modCount = 0;
    for (const data of trackNodes.values()) {
        if (data.type === "modulator" && data.parentId === parentId) {
            modCount++;
        }
    }

    const modNode = LiteGraph.createNode("Audio/Modulator");
    const modName = `Modulator ${modCount + 1}`;
    modNode.properties.node_name = modName;
    modNode.properties.node_type = "modulator";
    modNode.properties.parentId = parentId;
    modNode.title = modName;

    if (typeof (modNode as any).computeSize === 'function') {
        modNode.size = (modNode as any).computeSize();
    }

    const parentWidth = parentNode.size ? parentNode.size[0] : 200;
    const parentHeight = parentNode.size ? parentNode.size[1] : 44;
    const offsetX = (modCount - 0.5) * 210;

    modNode.pos = [
        parentNode.pos[0] + parentWidth * 0.5 - 90 + offsetX,
        parentNode.pos[1] + parentHeight + 60
    ];

    graph.add(modNode);

    trackNodes.set(modNode.id, {
        id: modNode.id,
        type: "modulator",
        name: modName,
        filepath: "",
        original_bpm: 120,
        start_beat: 0,
        mix_mode: "sum",
        chain: modNode.properties.chain,
        parentId: parentId,
        children: []
    });

    if (parentData) {
        if (!parentData.modulators) parentData.modulators = [];
        parentData.modulators.push(modNode.id);
    }

    updateGraphNodeCollapsing();
    openParamWindow(modNode);
}

window.addEventListener('render-node', (e: any) => {
    const nodeId = e.detail?.nodeId;
    if (nodeId != null) {
        renderNode(nodeId);
    }
});


window.addEventListener('delete-node', (e: any) => {
    const nodeId = e.detail?.nodeId;
    if (nodeId != null) {
        deleteNode(nodeId);
    }
});

window.addEventListener('node-removed', (e: any) => {
    const nodeId = e.detail?.nodeId;
    if (nodeId != null) {
        handleNodeRemoved(nodeId);
    }
});

window.addEventListener('add-library-node', (e: any) => {
    const filepath = e.detail?.filepath;
    const name = e.detail?.name;
    const itemType = e.detail?.itemType;

    if (filepath) {
        const isMidi = itemType === 'midi' || filepath.endsWith('.mid') || filepath.endsWith('.midi');
        if (isMidi) {
            const node = addRootNode("sequence", undefined, filepath, name);
            if (node) {
                fetch('/api/midi/parse', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filepath })
                }).then(res => res.json()).then(data => {
                    if (data.sequence) {
                        node.properties.sequence = data.sequence;
                        if (data.bpm) node.properties.original_bpm = data.bpm;
                        const dataRecord = trackNodes.get(node.id);
                        if (dataRecord) {
                            dataRecord.sequence = data.sequence;
                            if (data.bpm) dataRecord.original_bpm = data.bpm;
                        }
                    }
                }).catch(err => console.error("Failed parsing dropped MIDI file", err));
            }
        } else {
            addRootNode("sample", undefined, filepath, name);
        }
    }
});

function addChildNode(parentId: number, nodeType: "sample" | "track" | "sequence" | "sample_pool" | "arrangement" = "sample") {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const parentNode = graph.getNodeById(parentId);
    if (!parentNode) return;

    const parentData = trackNodes.get(parentId);
    if (!parentData) return;

    let typeStr = "Audio/Sample";
    let defaultName = "New Sample";
    if (nodeType === "track") {
        typeStr = "Audio/Track";
        defaultName = "Sub Track";
    } else if (nodeType === "sequence") {
        typeStr = "Audio/Sequence";
        defaultName = "Sequence";
    } else if (nodeType === "sample_pool") {
        typeStr = "Audio/SamplePool";
        defaultName = "Sample Pool";
    } else if (nodeType === "arrangement") {
        typeStr = "Audio/Arrangement";
        defaultName = "Arrangement";
    }

    const childNode = LiteGraph.createNode(typeStr);
    childNode.properties.node_name = defaultName;
    childNode.properties.node_type = nodeType;
    childNode.properties.filepath = "";
    childNode.properties.original_bpm = 120;
    childNode.properties.start_beat = 0;
    childNode.properties.mix_mode = "sum";
    if (nodeType === "sequence") {
        childNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        childNode.properties.step_length = 0.25;
    } else if (nodeType === "arrangement") {
        childNode.properties.total_bars = 4.0;
        childNode.properties.probability = 1.0;
    }
    childNode.title = defaultName;
    if (typeof (childNode as any).computeSize === 'function') {
        childNode.size = (childNode as any).computeSize();
    }

    // Visual themes
    if (nodeType === "sample") {
        const sampleColors = [
            { color: "#10b981", bgcolor: "#10b981", boxcolor: "#059669" },
            { color: "#f59e0b", bgcolor: "#f59e0b", boxcolor: "#d97706" },
            { color: "#8b5cf6", bgcolor: "#8b5cf6", boxcolor: "#7c3aed" }
        ];
        const theme = sampleColors[parentData.children.length % sampleColors.length];
        childNode.color = theme.color;
        childNode.bgcolor = theme.bgcolor;
        childNode.boxcolor = theme.boxcolor;
    } else if (nodeType === "sequence") {
        childNode.color = "#ec4899";
        childNode.bgcolor = "#ec4899";
        childNode.boxcolor = "#db2777";
    } else if (nodeType === "sample_pool") {
        childNode.color = "#8b5cf6";
        childNode.bgcolor = "#8b5cf6";
        childNode.boxcolor = "#7c3aed";
    } else if (nodeType === "arrangement") {
        childNode.color = "#f59e0b";
        childNode.bgcolor = "#f59e0b";
        childNode.boxcolor = "#d97706";
    } else {
        childNode.color = "#3b82f6";
        childNode.bgcolor = "#3b82f6";
        childNode.boxcolor = "#2563eb";
    }

    graph.add(childNode);

    // Position node neatly relative to parent (above parent so signal flows down into parent input)
    const childCount = parentData.children.length + 1;
    const spacing = 260;
    const startX = parentNode.pos[0] - ((childCount - 1) * spacing) / 2;

    childNode.pos = [startX + (childCount - 1) * spacing, parentNode.pos[1] - 120];

    // Find first free input slot on parent
    let targetSlot = 0;
    if (parentNode.inputs) {
        for (let i = 0; i < parentNode.inputs.length; i++) {
            if (parentNode.inputs[i].link == null) {
                targetSlot = i;
                break;
            }
        }
    }
    
    // Connect link in LiteGraph: Child output (0) -> Parent free input
    childNode.connect(0, parentNode, targetSlot);

    // Update parent's children record
    parentData.children.push(childNode.id);

    // Register node data
    trackNodes.set(childNode.id, {
        id: childNode.id,
        type: nodeType,
        name: defaultName,
        filepath: "",
        original_bpm: 120,
        start_beat: 0,
        mix_mode: "sum",
        sequence: nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined,
        step_length: nodeType === "sequence" ? 0.25 : undefined,
        total_bars: nodeType === "arrangement" ? 4.0 : undefined,
        probability: nodeType === "arrangement" ? 1.0 : undefined,
        parentId: parentId,
        children: []
    });

    // Re-align all siblings above parent for horizontal symmetry
    parentData.children.forEach((cid, i) => {
        const sibling = graph.getNodeById(cid);
        if (sibling) {
            sibling.pos = [startX + i * spacing, parentNode.pos[1] - 120];
        }
    });

    openParamWindow(childNode);
}

function deleteNode(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const lgraphNode = graph.getNodeById(nodeId);
    if (lgraphNode) {
        graph.remove(lgraphNode); // Triggers onRemoved lifecycle hook & 'node-removed' event
    } else {
        handleNodeRemoved(nodeId);
    }
}

function handleNodeRemoved(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    const nodeData = trackNodes.get(nodeId);

    if (nodeData) {
        // Unlink from parent data structure
        if (nodeData.parentId != null) {
            const parentData = trackNodes.get(nodeData.parentId);
            if (parentData) {
                parentData.children = parentData.children.filter(id => id !== nodeId);
            }
        }

        // Recursively remove children
        const childrenToDelete = [...nodeData.children];
        for (const childId of childrenToDelete) {
            if (graph) {
                const childNode = graph.getNodeById(childId);
                if (childNode) {
                    graph.remove(childNode);
                } else {
                    handleNodeRemoved(childId);
                }
            }
        }

        trackNodes.delete(nodeId);
    }

    // Close associated properties panel if open
    const dv = (window as any).dockview;
    if (dv) {
        const panelId = `properties_${nodeId}`;
        const panel = dv.getGroupPanel(panelId);
        if (panel) panel.api.close();
    }

    if ((window as any)._currentlySelectedNode?.id === nodeId) {
        (window as any)._currentlySelectedNode = null;
    }

    if (activeParamNodeId === nodeId) {
        activeParamNodeId = null;
    }
    updateGraphNodeCollapsing();
}

function addRootNode(
    nodeType: "sample" | "track" | "sequence" | "sample_pool" | "arrangement" = "track",
    pos?: [number, number],
    filepath?: string,
    customName?: string,
    metaKey?: string,
    metaBpm?: number
) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    let typeStr = "Audio/Track";
    let defaultName = "Master Track";
    if (nodeType === "sample") {
        typeStr = "Audio/Sample";
        defaultName = "Sample";
    } else if (nodeType === "sequence") {
        typeStr = "Audio/Sequence";
        defaultName = "Sequence";
    } else if (nodeType === "sample_pool") {
        typeStr = "Audio/SamplePool";
        defaultName = "Sample Pool";
    } else if (nodeType === "arrangement") {
        typeStr = "Audio/Arrangement";
        defaultName = "Arrangement";
    }

    const rootNode = LiteGraph.createNode(typeStr);
    rootNode.pos = pos ? [pos[0], pos[1]] : [350 + Math.random() * 40, 100 + Math.random() * 40];
    rootNode.properties.node_name = customName || defaultName;
    rootNode.properties.filepath = filepath || "";
    rootNode.properties.mix_mode = "sum";

    let extractedBpm = metaBpm;
    let extractedKey = metaKey;
    if (filepath && (!extractedBpm || !extractedKey)) {
        const meta = extractMetadataFromPath(filepath);
        if (!extractedBpm && meta.bpm) extractedBpm = meta.bpm;
        if (!extractedKey && meta.key) extractedKey = meta.key;
    }

    const origBpm = extractedBpm || 120;
    const keyStr = extractedKey || "";
    const targetBpm = origBpm;

    rootNode.properties.original_bpm = origBpm;
    rootNode.properties.target_bpm = targetBpm;
    rootNode.properties.bpm = targetBpm;
    rootNode.properties.key = keyStr;

    if (nodeType === "sequence") {
        rootNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        rootNode.properties.step_length = 0.25;
    } else if (nodeType === "arrangement") {
        rootNode.properties.total_bars = 4.0;
        rootNode.properties.probability = 1.0;
    }
    rootNode.title = customName || defaultName;
    if (typeof (rootNode as any).computeSize === 'function') {
        rootNode.size = (rootNode as any).computeSize();
    }

    if (nodeType === "sample") {
        rootNode.color = "#10b981";
        rootNode.bgcolor = "#10b981";
        rootNode.boxcolor = "#059669";
    } else if (nodeType === "sequence") {
        rootNode.color = "#ec4899";
        rootNode.bgcolor = "#ec4899";
        rootNode.boxcolor = "#db2777";
    } else if (nodeType === "sample_pool") {
        rootNode.color = "#8b5cf6";
        rootNode.bgcolor = "#8b5cf6";
        rootNode.boxcolor = "#7c3aed";
    } else if (nodeType === "arrangement") {
        rootNode.color = "#f59e0b";
        rootNode.bgcolor = "#f59e0b";
        rootNode.boxcolor = "#d97706";
    } else {
        rootNode.color = "#4f46e5";
        rootNode.bgcolor = "#4f46e5";
        rootNode.boxcolor = "#4338ca";
    }

    graph.add(rootNode);

    trackNodes.set(rootNode.id, {
        id: rootNode.id,
        type: nodeType,
        name: customName || defaultName,
        filepath: filepath || "",
        original_bpm: origBpm,
        target_bpm: targetBpm,
        bpm: targetBpm,
        key: keyStr,
        start_beat: 0,
        mix_mode: "sum",
        sequence: nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined,
        step_length: nodeType === "sequence" ? 0.25 : undefined,
        total_bars: nodeType === "arrangement" ? 4.0 : undefined,
        probability: nodeType === "arrangement" ? 1.0 : undefined,
        parentId: null,
        children: []
    });

    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
    return rootNode;
}

const dockview = new DockviewComponent(appElement, {
    createComponent: (options: any) => {
        const element = document.createElement('div');
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.position = 'relative';

        switch (options.name) {
            case 'graph-editor': {
                const canvas = document.createElement('canvas');
                canvas.id = 'graph-canvas';
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                canvas.style.display = 'block';
                canvas.style.backgroundColor = '#ffffff';
                element.appendChild(canvas);

                requestAnimationFrame(() => {
                    const graph = new LGraph();
                    (window as any).editorGraph = graph;

                    // Render connections on top of main canvas so they update live in real-time during node drag
                    if (!graph.config) graph.config = {};
                    (graph.config as any).links_ontop = true;

                    const graphCanvas = new LGraphCanvas(canvas, graph);
                    (window as any).editorCanvas = graphCanvas;

                    graphCanvas.ds.scale = 1.0;

                    // Direct 1-to-1 linear straight connections (Point A to Point B)
                    graphCanvas.links_render_mode = LiteGraph.LINEAR_LINK;
                    graphCanvas.render_curved_connections = false;
                    graphCanvas.render_connection_arrows = false;
                    graphCanvas.render_connections_border = false;
                    graphCanvas.render_connections_shadows = false;
                    graphCanvas.default_link_color = "#94a3b8";
                    graphCanvas.connections_width = 2;

                    // Suppress drawing connection dots / anchor points
                    (graphCanvas as any).drawSlot = function () { };

                    (graph as any).onNodeConnectionChange = function () {
                        syncGraphHierarchy(graph);
                        updateGraphNodeCollapsing();
                    };

                    // Clean white canvas background without grid fade
                    graphCanvas.clear_background = true;
                    (graphCanvas as any).clear_background_color = "#ffffff";
                    (graphCanvas as any).background_image = null;
                    (graphCanvas as any).zoom_modify_alpha = false;
                    (graphCanvas as any).render_canvas_border = false; // Let LiteGraph draw it, we will color it

                    // The library hardcodes the border color to #235. To color it white, we use the 
                    // exposed onDrawForeground hook to draw a white border precisely over it.
                    (graphCanvas as any).onDrawForeground = function (ctx: CanvasRenderingContext2D) {
                        ctx.save();
                        ctx.strokeStyle = "#ffffff";
                        ctx.lineWidth = 2; // slightly thicker to ensure it covers
                        ctx.strokeRect(0, 0, canvas.width, canvas.height);
                        ctx.restore();

                        const nodesList = (graph as any)?._nodes;
                        if (!graph || !nodesList) return;

                        ctx.save();
                        for (const node of nodesList) {
                            if (!node) continue;
                            const isMod = (node.type === "Audio/Modulator" || node.properties?.node_type === "modulator");

                            if (!isMod) {
                                // Draw dedicated Middle Footer Inlet on parent/audio nodes
                                if (!node.flags?.collapsed) {
                                    const width = node.size ? node.size[0] : 200;
                                    const height = node.size ? node.size[1] : 44;
                                    const inletX = node.pos[0] + width * 0.5;
                                    const inletY = node.pos[1] + height;

                                    // Outer subtle ring
                                    ctx.beginPath();
                                    ctx.arc(inletX, inletY, 6, 0, Math.PI * 2);
                                    ctx.fillStyle = "rgba(147, 51, 234, 0.2)";
                                    ctx.fill();

                                    // Core dot
                                    ctx.beginPath();
                                    ctx.arc(inletX, inletY, 4, 0, Math.PI * 2);
                                    ctx.fillStyle = "#9333ea";
                                    ctx.fill();
                                    ctx.lineWidth = 1.5;
                                    ctx.strokeStyle = "#ffffff";
                                    ctx.stroke();
                                }
                            } else {
                                // Draw connection line & dot for Modulator node
                                if ((node.flags as any)?.hidden) continue;

                                const parentId = node.properties?.parentId;
                                if (parentId == null) continue;

                                const parentNode = graph.getNodeById(parentId);
                                if (!parentNode || (parentNode.flags as any)?.hidden) continue;

                                const isDot = Boolean((node as any).collapsedDotMode);

                                const modWidth = node.size ? node.size[0] : 180;
                                const modX = node.pos[0] + modWidth * 0.5;
                                const modY = isDot ? (node.pos[1] + 10) : node.pos[1]; // center of dot if collapsed, top center if expanded

                                const parentWidth = parentNode.size ? parentNode.size[0] : 200;
                                const parentHeight = parentNode.size ? parentNode.size[1] : 44;
                                const parentInletX = parentNode.pos[0] + parentWidth * 0.5;
                                const parentInletY = parentNode.pos[1] + parentHeight;

                                // Vibrant purple control cable connecting parent inlet to modulator dot/top
                                ctx.beginPath();
                                ctx.moveTo(modX, modY);
                                ctx.lineTo(parentInletX, parentInletY);
                                ctx.lineWidth = 2.5;
                                ctx.strokeStyle = "#a855f7";
                                ctx.lineCap = "round";
                                ctx.stroke();

                                if (isDot) {
                                    // Render single collapsed modulator dot signaling existence without labels
                                    ctx.beginPath();
                                    ctx.arc(modX, modY, 7.5, 0, Math.PI * 2);
                                    ctx.fillStyle = "rgba(147, 51, 234, 0.25)";
                                    ctx.fill();

                                    ctx.beginPath();
                                    ctx.arc(modX, modY, 4.5, 0, Math.PI * 2);
                                    ctx.fillStyle = "#9333ea";
                                    ctx.fill();
                                    ctx.lineWidth = 1.5;
                                    ctx.strokeStyle = "#ffffff";
                                    ctx.stroke();
                                } else {
                                    // Expanded cable end cap
                                    ctx.beginPath();
                                    ctx.arc(modX, modY, 3.5, 0, Math.PI * 2);
                                    ctx.fillStyle = "#c084fc";
                                    ctx.fill();
                                }
                            }
                        }
                        ctx.restore();
                    };
                    if (graphCanvas.bgcanvas) {
                        graphCanvas.bgcanvas.style.backgroundColor = "#ffffff";
                    }

                    // Override LiteGraph search box to open Node Select popup on double-click
                    graphCanvas.allow_searchbox = true;
                    graphCanvas.showSearchBox = function (e?: MouseEvent) {
                        if (graphCanvas.node_over) return;

                        let canvasPos: [number, number] | undefined = undefined;
                        if (e && typeof graphCanvas.convertEventToCanvasOffset === 'function') {
                            const offset = graphCanvas.convertEventToCanvasOffset(e);
                            canvasPos = [offset[0], offset[1]];
                        }

                        const clickX = e ? e.clientX : window.innerWidth / 2;
                        const clickY = e ? e.clientY : window.innerHeight / 2;

                        popupMenu.show(clickX, clickY, (nodeType) => {
                            addRootNode(nodeType, canvasPos);
                        });
                    };

                    canvas.addEventListener('dblclick', (e: MouseEvent) => {
                        if (graphCanvas.node_over) return;
                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        popupMenu.show(e.clientX, e.clientY, (nodeType) => {
                            addRootNode(nodeType, [offset[0], offset[1]]);
                        });
                    });

                    canvas.addEventListener('mousemove', (e: MouseEvent) => {
                        if (!graph || graphCanvas.node_over || graphCanvas.connecting_node || graphCanvas.dragging_canvas || (graphCanvas as any).selected_group_resizing) {
                            if (hoveredLink) {
                                hoveredLink = null;
                                canvas.style.cursor = "default";
                                graphCanvas.setDirty(true, true);
                            }
                            return;
                        }

                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        const canvasX = offset[0];
                        const canvasY = offset[1];
                        const scale = graphCanvas.ds?.scale || 1.0;
                        const threshold = 10 / scale;

                        let closestLink: any = null;
                        let minDistance = threshold;

                        if (graph.links) {
                            for (const linkId in graph.links) {
                                const link = graph.links[linkId];
                                if (!link) continue;

                                const originNode = graph.getNodeById(link.origin_id);
                                const targetNode = graph.getNodeById(link.target_id);
                                if (!originNode || !targetNode) continue;

                                const posA = originNode.getConnectionPos(false, link.origin_slot);
                                const posB = targetNode.getConnectionPos(true, link.target_slot);

                                const dist = getDistanceToSegment(canvasX, canvasY, posA[0], posA[1], posB[0], posB[1]);
                                if (dist < minDistance) {
                                    minDistance = dist;
                                    closestLink = link;
                                }
                            }
                        }

                        if (hoveredLink !== closestLink) {
                            hoveredLink = closestLink;
                            if (hoveredLink) {
                                canvas.style.cursor = BREAKER_CURSOR;
                            } else {
                                canvas.style.cursor = "default";
                            }
                            graphCanvas.setDirty(true, true);
                        }
                    });

                    canvas.addEventListener('mousedown', (e: MouseEvent) => {
                        if (e.button === 0 && hoveredLink) {
                            const linkIdToDelete = hoveredLink.id;
                            hoveredLink = null;
                            canvas.style.cursor = "default";
                            graph.removeLink(linkIdToDelete);
                            syncGraphHierarchy(graph);
                            updateGraphNodeCollapsing();
                            window.dispatchEvent(new CustomEvent('graph-connections-changed'));
                            graphCanvas.setDirty(true, true);
                            e.stopPropagation();
                            e.preventDefault();
                        }
                    }, true);

                    canvas.addEventListener('dragover', (e: DragEvent) => {
                        e.preventDefault(); // Allow drop
                    });

                    canvas.addEventListener('drop', (e: DragEvent) => {
                        e.preventDefault();
                        if (e.dataTransfer) {
                            try {
                                const dataStr = e.dataTransfer.getData('text/plain');
                                if (!dataStr) return;
                                const data = JSON.parse(dataStr);
                                if (data && data.type === 'library-item') {
                                    let canvasPos: [number, number] | undefined = undefined;
                                    if (typeof graphCanvas.convertEventToCanvasOffset === 'function') {
                                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                                        canvasPos = [offset[0], offset[1]];
                                    }
                                    addRootNode("sample", canvasPos, data.filepath, data.name, data.key, data.bpm);
                                }
                            } catch (err) { }
                        }
                    });

                    const resizeObserver = new ResizeObserver(() => {
                        const width = Math.floor(element.clientWidth);
                        const height = Math.floor(element.clientHeight);
                        if (width <= 0 || height <= 0) return;

                        canvas.style.width = width + "px";
                        canvas.style.height = height + "px";

                        graphCanvas.resize(width, height);
                        if (graphCanvas.bgcanvas) {
                            graphCanvas.bgcanvas.style.backgroundColor = "#ffffff";
                        }
                        graphCanvas.setDirty(true, true);
                    });
                    resizeObserver.observe(element);

                    graph.start();

                    // Add initial Master Track root node
                    addRootNode("track");

                    graphCanvas.onSelectionChange = function () {
                        updateGraphNodeCollapsing();
                    };

                    graphCanvas.onNodeSelected = function (node: any) {
                        updateGraphNodeCollapsing();
                        openParamWindow(node);
                    };

                    graphCanvas.onNodeDeselected = function () {
                        updateGraphNodeCollapsing();
                    };
                });
                break;
            }
            case 'properties-panel': {
                const nodeId = options.params?.nodeId;
                const graph = (window as any).editorGraph;
                let node = (window as any)._currentlySelectedNode;
                if (!node && graph && nodeId != null) {
                    node = graph.getNodeById(nodeId);
                }
                const onClose = () => {
                    const dv = (window as any).dockview;
                    if (dv) {
                        const p = dv.getGroupPanel(options.id);
                        if (p) p.api.close();
                    } else if (options.api) {
                        options.api.close();
                    }
                };

                if (node) {
                    try {
                        const win = new PropertiesWindow(element, node, onClose);
                        win.render().catch(err => {
                            element.innerHTML = `
                                <div style="padding:15px; color:red;">
                                    <div style="margin-bottom:10px;">Async Error rendering properties: ${err}</div>
                                    <button id="err-close">Close</button>
                                </div>
                            `;
                            element.querySelector('#err-close')?.addEventListener('click', onClose);
                        });
                    } catch (err) {
                        element.innerHTML = `
                            <div style="padding:15px; color:red;">
                                <div style="margin-bottom:10px;">Error rendering properties: ${err}</div>
                                <button id="err-close">Close</button>
                            </div>
                        `;
                        element.querySelector('#err-close')?.addEventListener('click', onClose);
                    }
                } else {
                    element.innerHTML = `
                        <div style="padding:15px; color:red; background-color: #fef08a; height: 100%;">
                            <div style="margin-bottom:10px;">Error loading properties (missing node params).</div>
                            <button id="err-close" style="padding:5px 10px; cursor:pointer;">Close</button>
                        </div>
                    `;
                    element.querySelector('#err-close')?.addEventListener('click', onClose);
                }
                break;
            }
            case 'library-panel': {
                new LibraryPanel(element);
                break;
            }
        }

        return {
            element,
            init: () => { },
            update: () => { },
            dispose: () => { }
        };
    }
});
(window as any).dockview = dockview;

dockview.onDidRemovePanel((panel: any) => {
    if (panel.id && panel.id.startsWith('properties_')) {
        const nodeId = parseInt(panel.id.replace('properties_', ''), 10);
        if (activeParamNodeId === nodeId) {
            activeParamNodeId = null;
        }
        updateGraphNodeCollapsing();
    }
});

dockview.layout(appElement.clientWidth, appElement.clientHeight);
window.addEventListener('resize', () => {
    dockview.layout(appElement.clientWidth, appElement.clientHeight);
});

const graphPanel = dockview.addPanel({
    id: 'graph_panel',
    component: 'graph-editor',
    title: 'Graph Editor'
});
graphPanel.group.header.hidden = true;

const libPanel = dockview.addPanel({
    id: 'library_panel',
    component: 'library-panel',
    title: 'Library'
});
dockview.addFloatingGroup(libPanel, {
    x: 10,
    y: 50,
    width: 250,
    height: 400
});

function serializeNodeSubtree(graph: LGraph, rootNodeId: number) {
    function buildNodeModel(nodeId: number): any {
        const data = trackNodes.get(nodeId);
        const nodeObj = graph.getNodeById(nodeId);
        if (!data && !nodeObj) return null;

        const name = data?.name || nodeObj?.title || nodeObj?.properties?.node_name || "AudioNode";
        const filepath = data?.filepath || nodeObj?.properties?.filepath || null;
        const original_bpm = data?.original_bpm || nodeObj?.properties?.original_bpm || 120;
        const target_bpm = data?.target_bpm || nodeObj?.properties?.target_bpm || data?.bpm || nodeObj?.properties?.bpm || 120;
        const key = data?.key || nodeObj?.properties?.key || "";
        const start_beat = data?.start_beat || nodeObj?.properties?.start_beat || 0;
        const bpm = target_bpm;
        const mix_mode = data?.mix_mode || nodeObj?.properties?.mix_mode || "sum";

        const nodeType = data?.type || nodeObj?.properties?.node_type || (nodeObj?.type === "Audio/Sample" ? "sample" : nodeObj?.type === "Audio/Sequence" ? "sequence" : nodeObj?.type === "Audio/SamplePool" ? "sample_pool" : "track");
        const sequence = data?.sequence || nodeObj?.properties?.sequence || (nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined);
        const stepLength = data?.step_length || nodeObj?.properties?.step_length || (nodeType === "sequence" ? 0.25 : undefined);
        const total_bars = data?.total_bars ?? nodeObj?.properties?.total_bars ?? (nodeType === "arrangement" ? 4.0 : undefined);
        const probability = data?.probability ?? nodeObj?.properties?.probability ?? (nodeType === "arrangement" ? 1.0 : undefined);

        const filters = data?.filters || nodeObj?.properties?.filters;
        const playbackMode = data?.playbackMode || nodeObj?.properties?.playbackMode;
        const refresh_mode = data?.refresh_mode || nodeObj?.properties?.refresh_mode || "manual";
        let seed = data?.seed || nodeObj?.properties?.seed;

        if (nodeType === "sample_pool") {
            const isSelfRender = (nodeId === rootNodeId);
            const isParentRender = !isSelfRender;
            
            if ((refresh_mode === "self_render" && isSelfRender) || 
                (refresh_mode === "parent_render" && isParentRender)) {
                seed = Math.random();
                if (nodeObj && nodeObj.properties) {
                    nodeObj.properties.seed = seed;
                    if ((window as any).editorCanvas) {
                        (window as any).editorCanvas.setDirty(true, true);
                    }
                }
                if (data) {
                    data.seed = seed;
                }
            }
        }

        const childrenIds: number[] = data?.children ? [...data.children] : [];
        if (nodeObj && nodeObj.inputs) {
            for (const input of nodeObj.inputs) {
                if (input.link != null) {
                    const link = (graph as any).links ? (graph as any).links[input.link] : null;
                    if (link && link.origin_id != null) {
                        if (!childrenIds.includes(link.origin_id)) {
                            childrenIds.push(link.origin_id);
                        }
                    }
                }
            }
        }

        const childModels: any[] = [];
        for (const cid of childrenIds) {
            const childModel = buildNodeModel(cid);
            if (childModel) {
                childModels.push(childModel);
            }
        }

        const chain = nodeObj?.properties?.chain || data?.chain || [];

        const modulatorModels: any[] = [];
        for (const [mid, mdata] of trackNodes.entries()) {
            if (mdata.type === "modulator" && mdata.parentId === nodeId) {
                const mNodeObj = graph.getNodeById(mid);
                modulatorModels.push({
                    id: mid,
                    node_name: mdata.name || mNodeObj?.title || "Modulator",
                    chain: mNodeObj?.properties?.chain || mdata.chain || []
                });
            }
        }

        return {
            node_name: name,
            node_type: nodeType,
            filepath: filepath,
            original_bpm: original_bpm,
            target_bpm: target_bpm,
            key: key,
            bpm: bpm,
            start_beat: start_beat,
            mix_mode: mix_mode,
            sequence: sequence,
            step_length: stepLength,
            total_bars: total_bars,
            probability: probability,
            filters: filters,
            playbackMode: playbackMode,
            seed: seed,
            refresh_mode: refresh_mode,
            chain: chain,
            modulators: modulatorModels,
            children: childModels
        };
    }

    return buildNodeModel(rootNodeId);
}

async function renderNode(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const payload = serializeNodeSubtree(graph, nodeId);
    if (!payload) {
        alert("Could not serialize node for rendering.");
        return;
    }

    payload.filename = `export_${nodeId}`;

    try {
        const res = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.status === 'success' && data.filename) {
            await updateTempRendersList(data.filename);
            masterPlayer.play().catch(e => console.error(e));
        } else {
            console.error("Render failed:", data);
            alert("Render failed, check console.");
        }
    } catch (err) {
        console.error("Error during render:", err);
        alert("Error during render, check console.");
    }
}
