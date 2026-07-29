import './style.css';
import { DockviewComponent, type IDockviewPanel } from 'dockview-core';
import { LGraph, LGraphCanvas, LiteGraph } from 'litegraph.js';
import './nodes/TrackNode';
import './nodes/SampleNode';
import './nodes/SequenceNode';
import { PropertiesWindow } from './ui/PropertiesWindow';
import { NodePopupMenu } from './ui/NodePopupMenu';

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

toolbar.appendChild(masterPlayer);
appElement.appendChild(toolbar);
// ------------------

// Configure LiteGraph globally
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

// Direct linear connections (Single straight line A -> B without turns)
LiteGraph.LINEAR_LINK = 1;
LiteGraph.LINK_COLOR = "#94a3b8"; // Light slate
LiteGraph.CONNECTING_LINK_COLOR = "#94a3b8";
LiteGraph.EVENT_LINK_COLOR = "#94a3b8";
LiteGraph.NODE_TEXT_COLOR = "#ffffff";
LiteGraph.NODE_TITLE_COLOR = "#ffffff";

export interface TrackNodeData {
    id: number;
    type: "track" | "sample" | "sequence";
    name: string;
    filepath: string;
    original_bpm: number;
    start_beat: number;
    bpm?: number;
    mix_mode: string;
    sequence?: number[];
    step_length?: number;
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
            const parentId = data.parentId;
            const isParentWindowOpen = (activeParamNodeId === parentId);
            const isParentChildParamOpen = isChildParamShown(parentId);
            const isSelfWindowOpen = (activeParamNodeId === nodeId);
            const isSelfChildParamOpen = isChildParamShown(nodeId);

            if (isParentWindowOpen || isParentChildParamOpen || isSelfWindowOpen || isSelfChildParamOpen) {
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
    if (node.type !== "Audio/Track" && node.type !== "Audio/Sample" && node.type !== "Audio/Sequence") return;

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
        dv.addFloatingGroup(panel as any, {
            x: Math.min(window.innerWidth - 340, Math.max(50, node.pos[0] + 260)),
            y: Math.max(50, node.pos[1] - 50),
            width: 320,
            height: 380
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

function addChildNode(parentId: number, nodeType: "sample" | "track" | "sequence" = "sample") {
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
    }
    childNode.title = defaultName;

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
    } else {
        childNode.color = "#3b82f6";
        childNode.bgcolor = "#3b82f6";
        childNode.boxcolor = "#2563eb";
    }

    graph.add(childNode);

    // Position node neatly relative to parent
    const childCount = parentData.children.length + 1;
    const spacing = 260;
    const startX = parentNode.pos[0] - ((childCount - 1) * spacing) / 2;
    
    childNode.pos = [startX + (childCount - 1) * spacing, parentNode.pos[1] + 120];

    // Connect link in LiteGraph
    parentNode.connect(0, childNode, 0);

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
        parentId: parentId,
        children: []
    });

    // Re-align all siblings under parent for horizontal symmetry
    parentData.children.forEach((cid, i) => {
        const sibling = graph.getNodeById(cid);
        if (sibling) {
            sibling.pos = [startX + i * spacing, parentNode.pos[1] + 120];
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

function addRootNode(nodeType: "sample" | "track" | "sequence" = "track", pos?: [number, number]) {
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
    }

    const rootNode = LiteGraph.createNode(typeStr);
    rootNode.pos = pos ? [pos[0], pos[1]] : [350 + Math.random() * 40, 100 + Math.random() * 40];
    rootNode.properties.node_name = defaultName;
    rootNode.properties.mix_mode = "sum";
    rootNode.title = defaultName;
    
    if (nodeType === "sample") {
        rootNode.color = "#10b981";
        rootNode.bgcolor = "#10b981";
        rootNode.boxcolor = "#059669";
    } else if (nodeType === "sequence") {
        rootNode.color = "#ec4899";
        rootNode.bgcolor = "#ec4899";
        rootNode.boxcolor = "#db2777";
    } else {
        rootNode.color = "#4f46e5";
        rootNode.bgcolor = "#4f46e5";
        rootNode.boxcolor = "#4338ca";
    }

    graph.add(rootNode);
    
    trackNodes.set(rootNode.id, {
        id: rootNode.id,
        type: nodeType,
        name: defaultName,
        filepath: "",
        original_bpm: 120,
        start_beat: 0,
        bpm: 120,
        mix_mode: "sum",
        sequence: nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined,
        step_length: nodeType === "sequence" ? 0.25 : undefined,
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
                    (graphCanvas as any).drawSlot = function() {};

                    // Clean white canvas background
                    graphCanvas.clear_background = true;
                    (graphCanvas as any).clear_background_color = "#ffffff";
                    if (graphCanvas.bgcanvas) {
                        graphCanvas.bgcanvas.style.backgroundColor = "#ffffff";
                    }

                    // Override LiteGraph search box to open Node Select popup on double-click
                    graphCanvas.allow_searchbox = true;
                    graphCanvas.showSearchBox = function(e?: MouseEvent) {
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

                    graphCanvas.onNodeSelected = function(node: any) {
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
        }

        return {
            element,
            init: () => {},
            update: () => {},
            dispose: () => {}
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

        const nodeType = data?.type || nodeObj?.properties?.node_type || (nodeObj?.type === "Audio/Sample" ? "sample" : nodeObj?.type === "Audio/Sequence" ? "sequence" : "track");
        const sequence = data?.sequence || nodeObj?.properties?.sequence || (nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined);
        const stepLength = data?.step_length || nodeObj?.properties?.step_length || (nodeType === "sequence" ? 0.25 : undefined);

        const childrenIds: number[] = data?.children ? [...data.children] : [];
        if (nodeObj && nodeObj.outputs) {
            for (const output of nodeObj.outputs) {
                if (output.links) {
                    for (const linkId of output.links) {
                        const link = (graph as any).links ? (graph as any).links[linkId] : null;
                        if (link && link.target_id != null) {
                            if (!childrenIds.includes(link.target_id)) {
                                childrenIds.push(link.target_id);
                            }
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

    payload.filename = `node_${nodeId}`;

    try {
        const res = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data.status === 'success' && data.file_url) {
            masterPlayer.src = `${data.file_url}?t=${Date.now()}`;
            masterPlayer.style.display = 'block';
            toolbar.style.display = 'flex';
            masterPlayer.play();
        } else {
            console.error("Render failed:", data);
            alert("Render failed, check console.");
        }
    } catch (err) {
        console.error("Error during render:", err);
        alert("Error during render, check console.");
    }
}
