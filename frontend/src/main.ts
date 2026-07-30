import './style.css';
import { DockviewComponent, type IDockviewPanel } from 'dockview-core';
import { LGraph, LGraphCanvas, LiteGraph } from 'litegraph.js';
import './nodes/TrackNode';
import './nodes/SampleNode';
import './nodes/SequenceNode';
import './nodes/SamplePoolNode';
import './nodes/ArrangementNode';
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

// Monkey-patch LGraphNode.prototype.connect to redirect connections to free slots
// Because LiteGraph's findSlotByType ignores preferFreeSlot for inputs, drops always hit slot 0.
const originalConnect = (LiteGraph as any).LGraphNode.prototype.connect;
(LiteGraph as any).LGraphNode.prototype.connect = function(slot: any, target_node: any, target_slot: any) {
    let t_node = target_node;
    if (t_node && t_node.constructor === Number) {
        t_node = this.graph.getNodeById(t_node);
    }
    if (t_node && t_node.inputs && target_slot !== undefined && target_slot !== -1) {
        let targetSlotIndex = typeof target_slot === "string" ? t_node.findInputSlot(target_slot) : target_slot;
        if (targetSlotIndex !== -1 && t_node.inputs[targetSlotIndex]) {
            if (t_node.inputs[targetSlotIndex].link != null) {
                // The intended slot is occupied. Try to find a free one of the same type.
                const type = t_node.inputs[targetSlotIndex].type;
                for (let i = 0; i < t_node.inputs.length; i++) {
                    if (t_node.inputs[i].type === type && t_node.inputs[i].link == null) {
                        target_slot = i;
                        break;
                    }
                }
            }
        }
    }
    return originalConnect.call(this, slot, target_node, target_slot);
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
    type: "track" | "sample" | "sequence" | "sample_pool" | "arrangement";
    name: string;
    filepath: string;
    original_bpm: number;
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
    parentId: number | null;
    children: number[];
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

function updateGraphNodeCollapsing() {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    for (const [nodeId, data] of trackNodes.entries()) {
        const lgraphNode = graph.getNodeById(nodeId);
        if (!lgraphNode) continue;

        if (data.parentId === null) {
            lgraphNode.flags.collapsed = false;
        } else {
            const isSelfWindowOpen = (activeParamNodeId === nodeId);
            const isSelfChildParamOpen = isChildParamShown(nodeId);

            if (isSelfWindowOpen || isSelfChildParamOpen) {
                lgraphNode.flags.collapsed = false;
            } else {
                lgraphNode.flags.collapsed = true;
            }
        }
    }

    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
}

function openParamWindow(node: any) {
    if (!node || node.id == null) return;
    if (node.type !== "Audio/Track" && node.type !== "Audio/Sample" && node.type !== "Audio/Sequence" && node.type !== "Audio/SamplePool" && node.type !== "Audio/Arrangement") return;

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
        const width = 340;
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
    if (filepath) {
        addRootNode("sample", undefined, filepath, name);
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

function addRootNode(nodeType: "sample" | "track" | "sequence" | "sample_pool" | "arrangement" = "track", pos?: [number, number], filepath?: string, customName?: string) {
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
        original_bpm: 120,
        start_beat: 0,
        bpm: 120,
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

                    // Suppress drawing connection dots / anchors
                    (graphCanvas as any).drawSlot = function () { };

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
                                    addRootNode("sample", canvasPos, data.filepath, data.name);
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

                    graphCanvas.onNodeSelected = function (node: any) {
                        openParamWindow(node);
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
        const start_beat = data?.start_beat || nodeObj?.properties?.start_beat || 0;
        const bpm = data?.bpm || nodeObj?.properties?.bpm || 120;
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

        return {
            node_name: name,
            node_type: nodeType,
            filepath: filepath,
            original_bpm: original_bpm,
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
