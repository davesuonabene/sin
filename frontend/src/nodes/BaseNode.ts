import { LiteGraph, LGraphNode } from 'litegraph.js';
import { CanvasButton } from '../ui/CanvasButton';
import { isGhostNode, getGhostSource, isGhostFieldLinked } from '../ghosts';
import { type FieldSchema } from '../fields/FieldSchema';
import { type NodePanelSchema } from '../fields/NodePanelSchema';
import {
    drawNeonIcon,
    normalizeNeonIcon,
    normalizeNodeShape,
    traceNodeShape,
    type NodeShape
} from './NodeVisuals';

export function getDefaultFxChain() {
    return [
        { id: "pre_gain_" + Math.random().toString(36).substring(2, 8), type: "gain", name: "Pre Gain", enabled: true, fixed: true, params: { gain: 1.0 } },
        { id: "post_gain_" + Math.random().toString(36).substring(2, 8), type: "gain", name: "Post Gain", enabled: true, fixed: true, params: { gain: 1.0 } }
    ];
}

function clonePropertyValue<T>(value: T, seen = new WeakMap<object, any>()): T {
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return seen.get(value as object);
    const copy: any = Array.isArray(value) ? [] : {};
    seen.set(value as object, copy);
    for (const key of Reflect.ownKeys(value as object)) {
        copy[key as any] = clonePropertyValue((value as any)[key], seen);
    }
    return copy;
}

export abstract class BaseNode extends LGraphNode {
    static readonly visualSize = 44;
    buttons: CanvasButton[] = [];
    renderBtn: CanvasButton;
    modulatorBtn: CanvasButton;
    removeBtn: CanvasButton;

    static createNode<T extends BaseNode>(this: new () => T, properties?: Record<string, any>): T {
        const instance = new this();
        if (properties) {
            instance.properties = clonePropertyValue({ ...instance.properties, ...properties });
        }
        return instance;
    }

    static defaultColor = "#4f46e5";
    static defaultIcon = "mixer";
    static defaultShape: NodeShape = "square";
    static badgeLabel = "NODE";
    static nodeType = "track";
    static defaultTab = "PARAMS";
    static tabs = ["TRACK", "CHAIN", "COMMON"];

    get nodeColor(): string {
        if (this.properties?.disabled || this.type === "Audio/Disabled") {
            return "#64748b";
        }
        const ctor = this.constructor as typeof BaseNode;
        return this.properties?.color || this.color || ctor.defaultColor || "#4f46e5";
    }

    get nodeIcon(): string {
        if (this.properties?.disabled || this.type === "Audio/Disabled") {
            return "warning";
        }
        const ctor = this.constructor as typeof BaseNode;
        return normalizeNeonIcon(this.properties?.icon, normalizeNeonIcon(ctor.defaultIcon));
    }

    get nodeShape(): NodeShape {
        const ctor = this.constructor as typeof BaseNode;
        return normalizeNodeShape(this.properties?.shape, ctor.defaultShape || "square");
    }

    get badgeLabel(): string {
        const ctor = this.constructor as typeof BaseNode;
        return ctor.badgeLabel || "NODE";
    }

    get nodeType(): string {
        if (this.properties?.disabled || this.type === "Audio/Disabled") {
            return "disabled";
        }
        const ctor = this.constructor as typeof BaseNode;
        return this.properties?.node_type || ctor.nodeType || "track";
    }

    get propertiesTabs(): string[] {
        const ctor = this.constructor as typeof BaseNode;
        return ctor.tabs || ["TRACK", "CHAIN", "COMMON"];
    }

    get defaultPropertiesTab(): string {
        const ctor = this.constructor as typeof BaseNode;
        return ctor.defaultTab || "PARAMS";
    }

    // Backwards compatibility helpers
    getDefaultColor(): string { return (this.constructor as typeof BaseNode).defaultColor; }
    getDefaultIcon(): string { return (this.constructor as typeof BaseNode).defaultIcon; }
    getDefaultShape(): NodeShape { return (this.constructor as typeof BaseNode).defaultShape; }
    getNodeType(): string { return this.nodeType; }
    getNodeBadgeLabel(): string { return this.badgeLabel; }
    getNodeColor(): string { return this.nodeColor; }
    getNodeIcon(): string { return this.nodeIcon; }
    getPropertiesTabs(): string[] { return this.propertiesTabs; }
    getDefaultPropertiesTab(): string { return this.defaultPropertiesTab; }

    getFields(tab?: string): FieldSchema[] {
        const ctor = this.constructor as any;
        const fields: FieldSchema[] = ctor.fields || [];
        if (tab) {
            return fields.filter(f => !f.tab || f.tab === tab);
        }
        return fields;
    }

    getPanelSchema(): NodePanelSchema {
        const ctor = this.constructor as any;
        if (ctor.panelSchema) {
            return ctor.panelSchema;
        }

        const tabs = this.propertiesTabs;
        return {
            tabs: tabs.map(tabId => ({
                id: tabId,
                label: tabId.charAt(0) + tabId.slice(1).toLowerCase(),
                sections: tabId === 'COMMON'
                    ? [{ type: 'info_table' }, { type: 'fields', fields: this.getFields('COMMON') }]
                    : [{ type: 'fields', fields: this.getFields(tabId) }]
            }))
        };
    }

    updateProperty(key: string, value: any): void {
        if (!this.properties) this.properties = {};
        this.properties[key] = clonePropertyValue(value);

        if (key === 'node_name' || key === 'name') {
            this.title = String(value);
            this.properties.node_name = String(value);
        }

        const source = getGhostSource(this);
        const propertyField = key === 'name' ? 'node_name' : key;
        if (source && isGhostFieldLinked(this, propertyField)) {
            source.properties[propertyField] = clonePropertyValue(value);
            if (key === 'name' || key === 'node_name') source.title = String(value);
            source.setDirtyCanvas?.(true, true);
        }

        if (typeof this.computeSize === 'function') {
            this.size = this.computeSize();
        }
        this.setDirtyCanvas(true, true);
        window.dispatchEvent(new CustomEvent('node-property-changed', {
            detail: { nodeId: this.id, key, value: clonePropertyValue(value) }
        }));
    }

    async onPropertyEdited(_key: string, _value: any, _previousValue: any): Promise<void> {
        // Subclasses may persist or coordinate field-specific edits.
    }

    drawCanvas(ctx: CanvasRenderingContext2D, canvas: any): void {
        if ((this.flags as any)?.hidden || (this as any).collapsedDotMode) return;

        this.size = this.computeSize();
        const isSelected = Boolean(canvas?.selected_nodes && canvas.selected_nodes[this.id]) || Boolean(this.is_selected);
        const isHovered = canvas?.node_over === this;
        const isLibraryDropTarget = canvas?.library_drop_node === this;
        const isGlobalRefreshHighlighted = Boolean(this.properties?.global_refresh_highlighted);

        ctx.save();
        this.drawSelectionRing(ctx, isSelected, isHovered, isLibraryDropTarget, isGlobalRefreshHighlighted);
        this.drawBody(ctx);
        this.drawIcon(ctx);
        this.drawSlots(ctx);
        this.drawBadges(ctx, isGlobalRefreshHighlighted);
        this.drawNameBadge(ctx, isSelected, isHovered);
        ctx.restore();

        this.onDrawForeground?.(ctx, canvas);
    }

    protected drawSelectionRing(
        ctx: CanvasRenderingContext2D,
        isSelected: boolean,
        isHovered: boolean,
        isLibraryDropTarget: boolean,
        isGlobalRefreshHighlighted: boolean
    ): void {
        const size = BaseNode.visualSize;
        if (isGlobalRefreshHighlighted) {
            traceNodeShape(ctx, this.nodeShape, -5, -5, size + 10);
            ctx.fillStyle = "rgba(245, 158, 11, 0.16)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#f59e0b";
            ctx.stroke();
        }
        if (isSelected) {
            traceNodeShape(ctx, this.nodeShape, -4, -4, size + 8);
            ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#38bdf8";
            ctx.stroke();
        } else if (isHovered || isLibraryDropTarget) {
            traceNodeShape(ctx, this.nodeShape, -3, -3, size + 6);
            ctx.lineWidth = isLibraryDropTarget ? 2.5 : 1.5;
            ctx.strokeStyle = isLibraryDropTarget ? "#22c55e" : "rgba(255, 255, 255, 0.72)";
            ctx.stroke();
        }
    }

    protected drawBody(ctx: CanvasRenderingContext2D): void {
        const size = BaseNode.visualSize;
        const nodeColor = this.nodeColor;
        traceNodeShape(ctx, this.nodeShape, 0, 0, size);
        ctx.fillStyle = "#07111f";
        ctx.fill();
        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = nodeColor;
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = nodeColor;
        if (isGhostNode(this)) ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);
    }

    protected drawIcon(ctx: CanvasRenderingContext2D): void {
        const center = BaseNode.visualSize / 2;
        drawNeonIcon(ctx, this.nodeIcon, center, center, 21);
    }

    protected drawSlots(ctx: CanvasRenderingContext2D): void {
        const size = BaseNode.visualSize;
        const drawSlot = (x: number) => {
            ctx.beginPath();
            ctx.arc(x, size / 2, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#07111f";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, size / 2, 2.25, 0, Math.PI * 2);
            ctx.fillStyle = "#f8fafc";
            ctx.fill();
        };
        if (this.inputs?.length) drawSlot(0);
        if (this.outputs?.length) drawSlot(size);
    }

    protected drawBadges(ctx: CanvasRenderingContext2D, isGlobalRefreshHighlighted: boolean): void {
        const badgeX = BaseNode.visualSize - 5;
        const drawBadge = (fill: string, text: string) => {
            ctx.beginPath();
            ctx.arc(badgeX, 5, 5.5, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 8px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(text, badgeX, 5.5);
        };
        if (isGlobalRefreshHighlighted) drawBadge("#f59e0b", "★");
        if (this.properties?.disabled || this.type === "Audio/Disabled") drawBadge("#dc2626", "×");
    }

    protected drawNameBadge(ctx: CanvasRenderingContext2D, isSelected: boolean, isHovered: boolean): void {
        if (!isSelected && !isHovered) return;
        const width = BaseNode.visualSize;
        const nodeName = this.properties?.node_name || this.title || "Node";
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        const badgeWidth = ctx.measureText(nodeName).width + 14;
        const badgeHeight = 20;
        const badgeX = width / 2 - badgeWidth / 2;
        const badgeY = -25;
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 5);
        else ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
        ctx.fillStyle = "rgba(7, 17, 31, 0.94)";
        ctx.fill();
        ctx.strokeStyle = this.nodeColor;
        ctx.lineWidth = 0.75;
        ctx.stroke();
        ctx.fillStyle = "#f8fafc";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(nodeName, width / 2, badgeY + badgeHeight / 2 + 0.5);
    }

    constructor() {
        super();
        this.size = [BaseNode.visualSize, BaseNode.visualSize];
        this.shape = LiteGraph.BOX_SHAPE || 1;
        
        if (!this.properties) {
            this.properties = {};
        }
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultFxChain();
        }

        // Action buttons positioned floating on the right side of the node
        this.renderBtn = new CanvasButton(
            48, 0, 16, 16, "▶", "#0f3b5f", "#0369a1",
            () => {
                window.dispatchEvent(new CustomEvent('preview-node', { detail: { nodeId: this.id } }));
            }
        );

        this.modulatorBtn = new CanvasButton(
            48, 18, 16, 16, "⌁", "#3b1764", "#7e22ce",
            () => {
                window.dispatchEvent(new CustomEvent('add-modulator-node', { detail: { parentId: this.id } }));
            }
        );

        this.removeBtn = new CanvasButton(
            48, 36, 16, 16, "×", "#5f1720", "#b91c1c",
            () => {
                if (this.graph) {
                    this.graph.remove(this);
                } else {
                    window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
                }
            }
        );

        this.addButton(this.renderBtn);
        this.addButton(this.modulatorBtn);
        this.addButton(this.removeBtn);
    }

    addButton(btn: CanvasButton) {
        this.buttons.push(btn);
    }

    computeSize(): [number, number] {
        return [BaseNode.visualSize, BaseNode.visualSize];
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "AudioNode";
    }

    isPointInside(x: number, y: number, margin: number = 0): boolean {
        const width = BaseNode.visualSize;
        const height = BaseNode.visualSize;
        const isHoveredOrSelected = Boolean(this.is_selected || ((window as any).editorCanvas?.node_over === this));
        const extraRight = isHoveredOrSelected ? 28 : 0;
        const extraTop = isHoveredOrSelected ? 32 : 0;

        return (
            x >= this.pos[0] - margin - 8 &&
            x <= this.pos[0] + width + margin + extraRight &&
            y >= this.pos[1] - margin - extraTop &&
            y <= this.pos[1] + height + margin
        );
    }

    onDrawForeground(ctx: CanvasRenderingContext2D, canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden) return;
        const isHovered = canvas && canvas.node_over === this;
        const isSelected = Boolean(canvas && canvas.selected_nodes && canvas.selected_nodes[this.id]) || this.is_selected;
        
        if (isHovered || isSelected) {
            for (const btn of this.buttons) {
                btn.draw(ctx, this);
            }
        }
    }

    onMouseMove(_e: MouseEvent, local_pos: any, canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden) return;
        const isHovered = canvas && canvas.node_over === this;
        const isSelected = Boolean(canvas && canvas.selected_nodes && canvas.selected_nodes[this.id]) || this.is_selected;
        if (!isHovered && !isSelected) return;

        if (!local_pos || local_pos.length < 2) return;
        const x = local_pos[0];
        const y = local_pos[1];
        let dirty = false;
        for (const btn of this.buttons) {
            const hit = btn.checkHit(x, y, this);
            if (btn.isHovered !== hit) {
                btn.isHovered = hit;
                dirty = true;
            }
        }
        if (dirty) {
            this.setDirtyCanvas(true, true);
        }
    }

    onMouseDown(_e: MouseEvent, local_pos: any, canvas: any): boolean {
        if (this.flags.collapsed || (this.flags as any).hidden) return false;

        const isHovered = canvas && canvas.node_over === this;
        const isSelected = Boolean(canvas && canvas.selected_nodes && canvas.selected_nodes[this.id]) || this.is_selected;

        if (local_pos && local_pos.length >= 2) {
            const x = local_pos[0];
            const y = local_pos[1];
            if (isHovered || isSelected) {
                for (const btn of this.buttons) {
                    if (btn.checkHit(x, y, this)) {
                        btn.onClick(_e);
                        return true;
                    }
                }
            }
        }

        // LiteGraph owns selection here so modifier clicks and group dragging work.
        return false;
    }

    onConnectionsChange(type: number, _slotIndex: number, _isConnected: boolean, _link_info: any, _ioSlot: any) {
        if (type === LiteGraph.INPUT && this.inputs) {
            queueMicrotask(() => {
                this.normalizeInputs();
            });
        }
        window.dispatchEvent(new CustomEvent('graph-connections-changed'));
    }

    normalizeInputs() {
        if (!this.inputs || this.inputs.length === 0) return;

        // Remove trailing excess empty inputs beyond the first empty one
        for (let i = this.inputs.length - 1; i >= 1; i--) {
            if (this.inputs[i].link == null && this.inputs[i - 1].link == null) {
                this.removeInput(i);
            } else {
                break;
            }
        }

        // Ensure at least one trailing empty input slot exists
        const lastInput = this.inputs[this.inputs.length - 1];
        if (lastInput && lastInput.link != null) {
            this.addInput("Input", "audio");
        }

        if (this.graph) {
            this.setDirtyCanvas(true, true);
        }
    }

    getConnectionPos(is_input: boolean, _slot_number: number | string, out?: any): any {
        out = out || new Float32Array(2);
        const width = BaseNode.visualSize;
        const height = BaseNode.visualSize;

        if (is_input) {
            // Lateral left connection
            out[0] = this.pos[0];
            out[1] = this.pos[1] + height * 0.5;
        } else {
            // Lateral right connection
            out[0] = this.pos[0] + width;
            out[1] = this.pos[1] + height * 0.5;
        }
        return out;
    }

    onRemoved() {
        // Automatically notify application when node is deleted
        window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id, properties: this.properties } }));
        window.dispatchEvent(new CustomEvent('graph-connections-changed'));
    }
}
