import { LiteGraph, LGraphNode } from 'litegraph.js';
import { CanvasButton } from '../ui/CanvasButton.ts';
import { getGhostSource, isGhostFieldLinked } from '../ghosts.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema, type PanelTabConfig } from '../fields/NodePanelSchema.ts';
import {
    drawNeonIcon,
    drawPerimeterProgressAccent,
    normalizeNeonIcon,
    normalizeNodeShape,
    traceNodeShape,
    type NodeShape
} from './NodeVisuals.ts';
import {
    defaultTransportClock,
    type RenderBox,
    type SignalTelemetry,
    drawRoundRect
} from '../../../packages/iride/src/index.ts';

/** Default attenuation applied before processing newly-created sample nodes. */
export const DEFAULT_SAMPLE_INPUT_GAIN_DB = -6;

export function isModifierNode(node: any): boolean {
    if (!node) return false;
    return Boolean(
        node.isModifier ||
        node.properties?.parentId != null ||
        node.type === 'Audio/Modulator' ||
        node.type === 'Audio/AssetFilter' ||
        node.type === 'Audio/Random'
    );
}

export function getDefaultFxChain(preGainDb = 0) {
    const preGain = Math.pow(10, preGainDb / 20);

    return [
        { id: "pre_gain_" + Math.random().toString(36).substring(2, 8), type: "gain", name: "Pre Gain", enabled: true, fixed: true, params: { gain: preGain, gain_db: preGainDb } },
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

function isPropertyValueEqual(a: any, b: any): boolean {
    if (Object.is(a, b)) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!isPropertyValueEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!isPropertyValueEqual(a[key], b[key])) return false;
    }
    return true;
}

export abstract class BaseNode extends LGraphNode {
    static readonly visualSize = 44;
    static readonly bodySize: number = BaseNode.visualSize;
    static readonly visualPanelWidth = 220;
    static readonly visualPanelHeight = 76;
    static readonly minVisualWidth = 140;
    static readonly minVisualHeight = 56;
    buttons: CanvasButton[] = [];
    previewBtn: CanvasButton;
    renderBtn: CanvasButton;
    renderToggleBtn: CanvasButton;
    freezeToggleBtn: CanvasButton;
    removeBtn: CanvasButton;
    eyeBtn: CanvasButton;
    poolBtn: CanvasButton;
    randomBtn: CanvasButton;

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
    static tabs = ["TRACK", "CHAIN", "EXPORT", "COMMON"];

    static exportFields: FieldSchema[] = [
        {
            key: 'export_root',
            label: 'Root Folder',
            type: 'directory',
            default: 'exports',
            tab: 'EXPORT',
            description: 'Root folder for rendered audio'
        },
        {
            key: 'export_subfolder',
            label: 'Subfolder',
            type: 'string',
            default: '',
            tab: 'EXPORT',
            placeholder: 'e.g. stems (creates if new)',
            description: 'Subfolder search or naming (auto-created if new)'
        },
        {
            key: 'export_pattern',
            label: 'Pattern',
            type: 'string',
            default: '{project}_{name}_{idx}',
            tab: 'EXPORT',
            description: 'Filename pattern with variables: {project}, {name}, {idx}, {bpm}, {bars}, {key}, {date}, {time}, {type}'
        },
        {
            key: 'export_overwrite_mode',
            label: 'Conflict',
            type: 'radio',
            default: 'incremental',
            options: [
                { value: 'incremental', label: 'Incremental' },
                { value: 'overwrite', label: 'Overwrite' }
            ],
            tab: 'EXPORT',
            description: 'How to handle existing files with the same name'
        },
        {
            key: 'export_directory',
            label: 'Target Directory',
            type: 'string',
            default: 'exports',
            tab: 'EXPORT',
            description: 'Resolved target directory path'
        }
    ];

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

    get nodeBodySize(): number {
        const ctor = this.constructor as typeof BaseNode;
        return Math.max(1, Math.min(BaseNode.visualSize, ctor.bodySize || BaseNode.visualSize));
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

    get isRenderable(): boolean {
        return !this.isModifier && this.type !== 'Audio/Disabled';
    }

    get propertiesTabs(): string[] {
        const schema = this.getPanelSchema();
        if (schema?.tabs?.length) {
            return schema.tabs.map(t => t.id);
        }
        const ctor = this.constructor as typeof BaseNode;
        return ctor.tabs || ["TRACK", "CHAIN", "EXPORT", "COMMON"];
    }

    get defaultPropertiesTab(): string {
        const ctor = this.constructor as typeof BaseNode;
        return ctor.defaultTab || "PARAMS";
    }

    get isModifier(): boolean {
        return Boolean(this.properties?.parentId);
    }

    get modifierKind(): string | null {
        return null;
    }

    get visualPanelWidth(): number {
        const ctor = this.constructor as any;
        return ctor.panelWidth || BaseNode.visualPanelWidth;
    }

    get visualPanelHeight(): number {
        const ctor = this.constructor as any;
        return ctor.panelHeight || BaseNode.visualPanelHeight;
    }

    get isVisualizationSupported(): boolean {
        return !this.isModifier && this.type !== 'Audio/Disabled';
    }

    get isPoolSupported(): boolean {
        if (this.isModifier) return false;
        const t = this.type || '';
        const nt = this.nodeType || '';
        return t === 'Audio/Sample' || t === 'Audio/Sequence' || nt === 'sample' || nt === 'sequence';
    }

    hasAttachedPool(): boolean {
        if (!this.isPoolSupported) return false;
        const graph = this.graph || ((typeof window !== 'undefined') ? (window as any).editorGraph : null);
        if (this.properties?.asset_modifier_id != null) {
            if (!graph) return true;
            const mod = graph.getNodeById?.(this.properties.asset_modifier_id);
            if (mod) return true;
        }
        const nodes: any[] = (graph as any)?._nodes || [];
        return nodes.some(n =>
            n &&
            (n.type === 'Audio/AssetFilter' || n.properties?.node_type === 'asset_filter') &&
            n.properties?.parentId === this.id
        );
    }

    hasAttachedRandomMod(): boolean {
        if (this.isModifier) return false;
        const graph = this.graph || ((typeof window !== 'undefined') ? (window as any).editorGraph : null);
        const nodes: any[] = (graph as any)?._nodes || [];
        return nodes.some(n =>
            n &&
            (n.type === 'Audio/Random' || n.properties?.node_type === 'random' || n.properties?.modifier_kind === 'random') &&
            n.properties?.parentId === this.id
        );
    }

    private _distanceStage: 1 | 2 | 3 = 1;

    get currentDistanceStage(): 1 | 2 | 3 {
        return this._distanceStage;
    }

    isNodeSelected(canvas?: any): boolean {
        const activeCanvas = canvas || ((typeof window !== 'undefined') ? (window as any).editorCanvas : null);
        if (activeCanvas?.selected_nodes) {
            return Boolean(activeCanvas.selected_nodes[this.id] || activeCanvas.selected_nodes[String(this.id)]);
        }
        return Boolean(this.is_selected);
    }

    /**
     * Evaluates the distance tier from canvas zoom scale with hysteresis
     * to prevent flickering near the boundary:
     * - Stage 1 (Close): scale >= 0.42 (drops at < 0.40, rises at >= 0.44)
     * - Stage 3 (Far / Max Distance): scale < 0.42 (viewer force-shut)
     */
    resolveDistanceStage(scale: number): 1 | 2 | 3 {
        if (!Number.isFinite(scale) || scale <= 0) return 1;
        const current = this._distanceStage;
        if (current === 3) {
            return scale >= 0.44 ? 1 : 3;
        }
        return scale < 0.40 ? 3 : 1;
    }

    syncDistanceStage(scale: number): boolean {
        const nextStage = this.resolveDistanceStage(scale);
        if (nextStage === this._distanceStage) return false;
        const prevActive = this.isVisualizationActive;
        this._distanceStage = nextStage;
        const nextActive = this.isVisualizationActive;
        if (prevActive !== nextActive) {
            this.resizable = nextActive;
            this.size = this.computeSize();
            this.updateButtonLayout();
        }
        return true;
    }

    /**
     * Per-node "Viewer Cook" state controlled by the Eye button.
     */
    get isViewerCookEnabled(): boolean {
        const val = this.properties?.visualization_enabled;
        const enabled = val !== undefined ? Boolean(val) : true;
        return enabled && this.isVisualizationSupported;
    }

    /**
     * True when the Iride viewer should render.
     * At Stage 3 (maximum distance), the viewer is force-shut for all nodes and cannot be toggled back on.
     */
    get isVisualizationActive(): boolean {
        return this.isViewerCookEnabled && this._distanceStage !== 3;
    }

    get isMinifiedStage(): boolean {
        return false;
    }

    toggleVisualization(): void {
        // At Stage 3 (maximum distance), visualization is shut off and not toggleable back
        if (!this.isVisualizationSupported || this._distanceStage === 3) return;
        const nextState = !this.isViewerCookEnabled;
        this.updateProperty('visualization_enabled', nextState);
        this.resizable = this.isVisualizationActive;
        this.updateButtonLayout();
        this.size = this.computeSize();
        this.setDirtyCanvas(true, true);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('node-visualization-toggled', {
                detail: { nodeId: this.id, enabled: nextState }
            }));
        }
        this.onVisualizationToggled?.(nextState);
    }

    getLiveActivityState(_telemetry?: SignalTelemetry): { isTriggered: boolean; progress?: number } {
        if (!_telemetry?.isPlaying) return { isTriggered: false };
        const isActive = _telemetry.activeNodeIds ? _telemetry.activeNodeIds.has(this.id) : true;
        const progress = _telemetry.duration > 0
            ? Math.max(0, Math.min(1, _telemetry.time / _telemetry.duration))
            : undefined;
        return { isTriggered: isActive, progress };
    }

    onVisualizationToggled?(_enabled: boolean): void;

    // Backwards compatibility & polymorphic node hooks
    getDefaultColor(): string { return (this.constructor as typeof BaseNode).defaultColor; }
    getDefaultIcon(): string { return (this.constructor as typeof BaseNode).defaultIcon; }
    getDefaultShape(): NodeShape { return (this.constructor as typeof BaseNode).defaultShape; }
    getBodySize(): number { return this.nodeBodySize; }
    getNodeType(): string { return this.nodeType; }
    getNodeBadgeLabel(): string { return this.badgeLabel; }
    getNodeColor(): string { return this.nodeColor; }
    getNodeIcon(): string { return this.nodeIcon; }
    getPropertiesTabs(): string[] { return this.propertiesTabs; }
    getDefaultPropertiesTab(): string { return this.defaultPropertiesTab; }
    get acceptedPoolAssetType(): 'audio' | 'sequence_source' { return 'audio'; }
    shouldRefreshTabOnGraphChange(_tab: string): boolean { return false; }
    getGhostBoundFieldOverrides(): Record<string, string[]> { return {}; }

    getInputNodes(): any[] {
        const graph = this.graph || ((typeof window !== 'undefined') ? (window as any).editorGraph : null);
        if (!graph) return [];
        const originNodes: any[] = [];
        const addOrigin = (id: number | null | undefined) => {
            if (id == null) return;
            const origin = graph.getNodeById?.(id);
            if (origin && !originNodes.includes(origin)) {
                originNodes.push(origin);
            }
        };

        if (this.inputs) {
            const links = (graph as any).links || {};
            for (const input of this.inputs) {
                if (input && input.link != null) {
                    const link = links[input.link];
                    const originId = Array.isArray(link) ? link[1] : link?.origin_id;
                    addOrigin(originId);
                }
            }
        }

        const allLinks = (graph as any).links;
        if (allLinks) {
            for (const key in allLinks) {
                const link = allLinks[key];
                if (!link) continue;
                const targetId = Array.isArray(link) ? link[3] : link?.target_id;
                if (targetId === this.id) {
                    const originId = Array.isArray(link) ? link[1] : link?.origin_id;
                    addOrigin(originId);
                }
            }
        }
        return originNodes;
    }

    getAudioBuffer(_visited?: Set<number>): AudioBuffer | null {
        return (this as any).manifestStemBuffer
            || (this as any)._lastRenderedBuffer
            || (this as any).audioBuffer
            || null;
    }

    getFields(tab?: string): FieldSchema[] {
        const ctor = this.constructor as any;
        const baseFields: FieldSchema[] = ctor.fields || [];
        const combined = tab === 'EXPORT'
            ? BaseNode.exportFields
            : [...baseFields, ...BaseNode.exportFields];
        if (tab) {
            return combined.filter(f => !f.tab || f.tab === tab);
        }
        return combined;
    }

    getPanelSchema(): NodePanelSchema {
        const ctor = this.constructor as any;
        let schema: NodePanelSchema;

        if (ctor.panelSchema) {
            schema = {
                tabs: ctor.panelSchema.tabs.map((t: any) => ({
                    ...t,
                    sections: [...t.sections]
                }))
            };
        } else {
            const tabs = ctor.tabs || ["TRACK", "CHAIN", "EXPORT", "COMMON"];
            schema = {
                tabs: tabs.map((tabId: string) => ({
                    id: tabId,
                    label: tabId.charAt(0) + tabId.slice(1).toLowerCase(),
                    sections: tabId === 'COMMON'
                        ? [
                            { type: 'appearance' },
                            { type: 'info_table' },
                            {
                                type: 'fields',
                                fields: this.getFields('COMMON').filter(field => field.key !== 'node_name')
                            }
                        ]
                        : tabId === 'EXPORT'
                            ? [{ type: 'export_panel' }]
                            : [{ type: 'fields', fields: this.getFields(tabId) }]
                }))
            };
        }

        if (this.isRenderable && !schema.tabs.some(t => t.id === 'EXPORT')) {
            const exportTab: PanelTabConfig = {
                id: 'EXPORT',
                label: 'Export',
                sections: [
                    { type: 'export_panel' }
                ]
            };
            const commonIndex = schema.tabs.findIndex(t => t.id === 'COMMON');
            if (commonIndex >= 0) {
                schema.tabs.splice(commonIndex, 0, exportTab);
            } else {
                schema.tabs.push(exportTab);
            }
        }

        return schema;
    }

    private _committedPropertySnapshots = new Map<string, any>();

    updateProperty(key: string, value: any): void {
        if (!this.properties) this.properties = {};
        const previousValue = this.properties[key];
        const nextValue = clonePropertyValue(value);
        const hasSnapshot = this._committedPropertySnapshots.has(key);
        const isObjectOrArray = nextValue !== null && typeof nextValue === 'object';
        const baselineValue = (isObjectOrArray && hasSnapshot) ? this._committedPropertySnapshots.get(key) : previousValue;
        // If no snapshot was recorded yet and the value is an object/array, a caller may have
        // mutated this.properties[key] in place before calling updateProperty, so do not skip.
        if ((hasSnapshot || !isObjectOrArray) && isPropertyValueEqual(baselineValue, nextValue)) {
            return;
        }
        this._committedPropertySnapshots.set(key, clonePropertyValue(nextValue));
        this.properties[key] = nextValue;

        if (key === 'node_name' || key === 'name') {
            this.title = String(value);
            this.properties.node_name = String(value);
        }

        const source = getGhostSource(this);
        const propertyField = key === 'name' ? 'node_name' : key;
        if (source && isGhostFieldLinked(this, propertyField)) {
            const clonedForSource = clonePropertyValue(value);
            source.properties[propertyField] = clonedForSource;
            (source as any)._committedPropertySnapshots?.set?.(propertyField, clonePropertyValue(clonedForSource));
            if (key === 'name' || key === 'node_name') source.title = String(value);
            (source as any)._cachedCompositedBuffer = null;
            source.setDirtyCanvas?.(true, true);
            if (typeof window !== 'undefined' && source.id != null) {
                window.dispatchEvent(new CustomEvent('node-property-changed', {
                    detail: { nodeId: source.id, key: propertyField, value: clonePropertyValue(clonedForSource) }
                }));
            }
        }

        (this as any)._cachedCompositedBuffer = null;
        if (typeof this.computeSize === 'function') {
            this.size = this.computeSize();
        }
        this.setDirtyCanvas(true, true);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('node-property-changed', {
                detail: { nodeId: this.id, key, value: clonePropertyValue(value) }
            }));
        }
    }

    async onPropertyEdited(_key: string, _value: any, _previousValue: any): Promise<void> {
        // Subclasses may persist or coordinate field-specific edits.
    }

    /**
     * Gives a node a chance to confirm or reject an inspector edit before the
     * shared widget writes to its serialized properties.
     */
    preparePropertyEdit(_key: string, _value: any, _previousValue: any): boolean {
        return true;
    }

    onGlobalParametersChanged(_parameters: Record<string, any>): void {
        // Subclasses may react to graph-wide parameter changes.
    }

    prepareSerializedModel(model: any): any {
        return model;
    }

    drawCanvas(ctx: CanvasRenderingContext2D, canvas: any): void {
        if ((this.flags as any)?.hidden || (this as any).collapsedDotMode || this.isModifier) return;

        if (canvas?.ds?.scale != null) {
            this.syncDistanceStage(Number(canvas.ds.scale));
        }

        if (!this.size || this.size[0] === 0) {
            this.size = this.computeSize();
            this.updateButtonLayout();
        }
        const isSelected = canvas?.selected_nodes
            ? Boolean(canvas.selected_nodes[this.id] || canvas.selected_nodes[String(this.id)])
            : Boolean(this.is_selected);
        const isHovered = canvas?.node_over === this;
        const isLibraryDropTarget = canvas?.library_drop_node === this;
        const isMainPreview = Boolean(this.properties?.is_main_preview);
        const telemetry = defaultTransportClock.getTelemetry();

        ctx.save();
        if (this.isVisualizationActive) {
            this.drawPanelFrame(ctx, isSelected, isHovered, isLibraryDropTarget, isMainPreview);
            if (!this.isModifier) {
                this.drawSlots(ctx);
            }
            const viewport: RenderBox = {
                x: 6,
                y: 23,
                width: this.size[0] - 12,
                height: Math.max(16, this.size[1] - 29)
            };
            this.drawVisualization(ctx, viewport, telemetry);
        } else {
            this.drawSelectionRing(ctx, isSelected, isHovered, isLibraryDropTarget, isMainPreview);
            if (!this.isModifier) {
                this.drawBody(ctx, telemetry);
                this.drawMinimalBorderFeedback(ctx, telemetry, isSelected, isMainPreview);
            }
            if (this._distanceStage !== 3 || isSelected || isHovered) {
                this.drawIcon(ctx);
            }
            if (!this.isModifier) {
                if (this._distanceStage !== 3 || isSelected || isHovered) {
                    this.drawSlots(ctx);
                }
                this.drawBadges(ctx, isMainPreview);
                this.drawNameBadge(ctx, isSelected, isHovered, canvas);
            }
        }
        ctx.restore();

        if (!this.isModifier) {
            this.onDrawForeground?.(ctx, canvas);
        }
    }

    drawVisualization(_ctx: CanvasRenderingContext2D, _bounds: RenderBox, _telemetry?: SignalTelemetry): void {
        // Subclasses override to invoke their IRIDE renderer
    }

    protected truncateTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
        if (!text || maxWidth <= 0) return '';
        if (typeof ctx.measureText !== 'function') {
            return text.length > 18 ? text.slice(0, 16) + '…' : text;
        }
        if (ctx.measureText(text).width <= maxWidth) return text;
        let low = 0;
        let high = text.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const candidate = text.slice(0, mid) + '…';
            if (ctx.measureText(candidate).width <= maxWidth) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low > 0 ? text.slice(0, low) + '…' : '…';
    }

    protected drawPanelFrame(
        ctx: CanvasRenderingContext2D,
        isSelected: boolean,
        isHovered: boolean,
        isLibraryDropTarget: boolean,
        isMainPreview: boolean
    ): void {
        const [width, height] = this.size;

        // Selection / hover / main-preview outer ring
        if (isMainPreview || isSelected || isLibraryDropTarget || isHovered) {
            ctx.save();
            ctx.lineWidth = isSelected ? 2 : 1.5;
            ctx.strokeStyle = isMainPreview
                ? "#f59e0b"
                : isSelected
                    ? "#38bdf8"
                    : isLibraryDropTarget
                        ? "#22c55e"
                        : "rgba(148, 163, 184, 0.55)";
            drawRoundRect(ctx, -2, -2, width + 4, height + 4, 3);
            ctx.stroke();
            ctx.restore();
        }

        // Solid light panel background
        ctx.fillStyle = "#ffffff";
        drawRoundRect(ctx, 0, 0, width, height, 3);
        ctx.fill();

        // Single peripheral border around everything
        ctx.strokeStyle = this.boxcolor || this.nodeColor;
        ctx.lineWidth = isSelected ? 1.5 : 1;
        drawRoundRect(ctx, 0, 0, width, height, 3);
        ctx.stroke();

        // Node Title (clean dark slate text with no header background or icon, dynamically truncated before buttons)
        const headerHeight = 22;
        const nodeName = this.properties?.node_name || this.title || "Node";
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const visibleBtns = this.getVisibleCanvasButtons(isSelected, isHovered);
        const leftmostBtnX = visibleBtns.reduce((minX, btn) => (btn.x < 0 ? Math.min(minX, btn.x) : minX), 0);
        const reservedRight = leftmostBtnX < 0 ? Math.abs(leftmostBtnX) + 4 : 8;
        const maxTitleWidth = Math.max(24, width - 8 - reservedRight);
        const displayTitle = this.truncateTextToWidth(ctx, nodeName, maxTitleWidth);
        ctx.fillText(displayTitle, 8, headerHeight / 2 + 0.5);

        // Subtle resize grip at bottom-right corner when selected
        if (isSelected && this.isVisualizationActive) {
            ctx.strokeStyle = "rgba(100, 116, 139, 0.45)";
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(width - 9, height - 3);
            ctx.lineTo(width - 3, height - 9);
            ctx.moveTo(width - 5, height - 3);
            ctx.lineTo(width - 3, height - 5);
            ctx.stroke();
        }
    }

    protected drawSelectionRing(
        ctx: CanvasRenderingContext2D,
        isSelected: boolean,
        isHovered: boolean,
        isLibraryDropTarget: boolean,
        isMainPreview: boolean
    ): void {
        const size = this.nodeBodySize;
        const offset = (BaseNode.visualSize - size) / 2;
        if (isMainPreview) {
            traceNodeShape(ctx, this.nodeShape, offset - 4, offset - 4, size + 8);
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#f59e0b";
            ctx.stroke();
        }
        if (isSelected) {
            traceNodeShape(ctx, this.nodeShape, offset - 3, offset - 3, size + 6);
            ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#38bdf8";
            ctx.stroke();
        } else if (isHovered || isLibraryDropTarget) {
            traceNodeShape(ctx, this.nodeShape, offset - 2.5, offset - 2.5, size + 5);
            ctx.lineWidth = isLibraryDropTarget ? 2.25 : 1.5;
            ctx.strokeStyle = isLibraryDropTarget ? "#22c55e" : (this.isModifier ? "rgba(126, 34, 206, 0.45)" : "rgba(148, 163, 184, 0.65)");
            ctx.stroke();
        }
    }

    protected drawBody(ctx: CanvasRenderingContext2D, telemetry?: SignalTelemetry): void {
        const size = this.nodeBodySize;
        const offset = (BaseNode.visualSize - size) / 2;
        const activity = this.getLiveActivityState(telemetry);
        const shouldDim = Boolean(telemetry?.isPlaying && !activity.isTriggered);

        ctx.save();
        if (shouldDim) {
            ctx.globalAlpha = 0.72;
        }
        traceNodeShape(ctx, this.nodeShape, offset, offset, size);
        ctx.fillStyle = this.nodeColor;
        ctx.fill();
        if (this.boxcolor && this.boxcolor !== this.nodeColor) {
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = this.boxcolor;
            ctx.stroke();
        }
        ctx.restore();
    }

    /**
     * Minimal perimeter border accents for closed/far-distance icon nodes.
     * Communicates live playback triggers, playhead progress, buffer fill, and cache invalidation
     * purely along the geometric shape border instead of interior visualizations.
     */
    protected drawMinimalBorderFeedback(
        ctx: CanvasRenderingContext2D,
        telemetry: SignalTelemetry | undefined,
        _isSelected: boolean,
        _isMainPreview: boolean
    ): void {
        const size = this.nodeBodySize;
        const offset = (BaseNode.visualSize - size) / 2;

        // 1. Invalidated cache: minimal dashed amber perimeter
        if ((this as any).isInvalidated) {
            ctx.save();
            ctx.setLineDash?.([3, 3]);
            traceNodeShape(ctx, this.nodeShape, offset - 1.5, offset - 1.5, size + 3);
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 1.75;
            ctx.stroke();
            ctx.setLineDash?.([]);
            ctx.restore();
        }

        // 2. Progressive RAM buffer fill: perimeter cyan progress arc
        const bufProg = (this as any).bufferedProgress;
        if (typeof bufProg === 'number' && bufProg > 0 && bufProg < 0.999) {
            drawPerimeterProgressAccent(
                ctx,
                this.nodeShape,
                offset - 2,
                offset - 2,
                size + 4,
                bufProg,
                "#38bdf8",
                2
            );
        }

        // 3. Live playback trigger & playhead progress: vivid perimeter border accent
        if (telemetry?.isPlaying) {
            const activity = this.getLiveActivityState(telemetry);
            if (activity.isTriggered) {
                const progress = typeof activity.progress === 'number' ? Math.max(0.08, activity.progress) : 1.0;
                drawPerimeterProgressAccent(
                    ctx,
                    this.nodeShape,
                    offset - 2,
                    offset - 2,
                    size + 4,
                    progress,
                    "#38bdf8",
                    2.5
                );
            }
        }
    }

    protected drawIcon(ctx: CanvasRenderingContext2D): void {
        const center = BaseNode.visualSize / 2;
        const iconColor = this.isModifier ? (this.nodeColor || '#7e22ce') : '#f8fafc';
        drawNeonIcon(ctx, this.nodeIcon, center, center, this.isModifier ? 24 : 21, iconColor);
    }

    protected drawSlots(ctx: CanvasRenderingContext2D): void {
        const [width, height] = this.size;
        const slotY = height * 0.5;
        const drawSlot = (x: number) => {
            ctx.beginPath();
            ctx.arc(x, slotY, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#07111f";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, slotY, 2.25, 0, Math.PI * 2);
            ctx.fillStyle = "#f8fafc";
            ctx.fill();
        };
        if (this.inputs?.length) drawSlot(0);
        if (this.outputs?.length) drawSlot(width);
    }

    protected drawBadges(ctx: CanvasRenderingContext2D, isMainPreview: boolean): void {
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
        if (isMainPreview) drawBadge("#f59e0b", "▶");
        if (this.properties?.disabled || this.type === "Audio/Disabled") drawBadge("#dc2626", "×");
    }

    protected drawNameBadge(ctx: CanvasRenderingContext2D, isSelected: boolean, isHovered: boolean, canvas?: any): void {
        if (!isSelected && !isHovered) return;
        const width = BaseNode.visualSize;
        const nodeName = this.properties?.node_name || this.title || "Node";
        const scale = Number(canvas?.ds?.scale) || 1;
        const fontSize = scale < 0.75
            ? Math.min(18, Math.max(11, Math.round(11 / Math.sqrt(Math.max(0.25, scale)))))
            : 11;
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
        const badgeWidth = (typeof ctx.measureText === 'function' ? ctx.measureText(nodeName).width : nodeName.length * 7) + 14;
        const badgeHeight = Math.max(20, fontSize + 9);
        const badgeX = width / 2 - badgeWidth / 2;
        const badgeY = -(badgeHeight + 5);
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 3);
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
        if (this.properties.visualization_enabled === undefined && this.isVisualizationSupported) {
            this.properties.visualization_enabled = true;
        }
        if (this.properties.freeze_refresh === undefined) {
            this.properties.freeze_refresh = true;
        }
        if (this.properties.render_enabled === undefined) {
            this.properties.render_enabled = true;
        }
        if (!this.properties.chain || !Array.isArray(this.properties.chain) || this.properties.chain.length === 0) {
            this.properties.chain = getDefaultFxChain();
        }
        if (this.properties.export_directory === undefined) {
            this.properties.export_directory = "exports";
        }
        if (this.properties.export_root === undefined) {
            this.properties.export_root = "exports";
        }
        if (this.properties.export_subfolder === undefined) {
            this.properties.export_subfolder = "";
        }
        if (this.properties.export_pattern === undefined) {
            this.properties.export_pattern = "{project}_{name}_{idx}";
        }
        if (this.properties.export_overwrite_mode === undefined) {
            this.properties.export_overwrite_mode = "incremental";
        }

        // Action buttons positioned floating on the right side of the node or header
        this.previewBtn = new CanvasButton(
            48, 0, 16, 16, "▶", "#0f3b5f", "#0369a1",
            () => {
                window.dispatchEvent(new CustomEvent('preview-node', { detail: { nodeId: this.id } }));
            },
            "Preview (RAM)"
        );

        this.renderToggleBtn = new CanvasButton(
            48, 18, 16, 16, "R",
            "rgba(30, 41, 59, 0.7)", "#334155",
            () => {
                const current = this.properties?.render_enabled !== false;
                this.updateProperty('render_enabled', !current);
                this.setDirtyCanvas(true, true);
            },
            "Include in Global Render: OFF",
            (node: any) => node.properties?.render_enabled !== false,
            "#059669", "#10b981",
            "Include in Global Render: ON"
        );

        this.freezeToggleBtn = new CanvasButton(
            48, 36, 16, 16, "❄",
            "rgba(30, 41, 59, 0.7)", "#334155",
            () => {
                const current = this.properties?.freeze_refresh !== false;
                this.updateProperty('freeze_refresh', !current);
                this.setDirtyCanvas(true, true);
            },
            "Freeze Refresh: OFF (Refreshes on Global Recalculate)",
            (node: any) => node.properties?.freeze_refresh !== false,
            "#0284c7", "#38bdf8",
            "Freeze Refresh: ON (Protected during Global Freeze)"
        );

        // Keep renderBtn referencing renderToggleBtn for backwards compatibility
        this.renderBtn = this.renderToggleBtn;

        this.eyeBtn = new CanvasButton(
            2, 2, 13, 13, "👁", "rgba(15, 23, 42, 0.75)", "#0284c7",
            () => {
                this.toggleVisualization();
            },
            "Viewer Cook: Toggle Iride Visualization"
        );

        this.poolBtn = new CanvasButton(
            -63, 4, 28, 13, "POOL",
            "rgba(15, 23, 42, 0.72)", "#7e22ce",
            () => {
                window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', { detail: { nodeId: this.id } }));
            },
            "Open Asset Pool",
            (node: any) => Boolean(node.hasAttachedPool?.()),
            "#7e22ce", "#9333ea",
            "Asset Pool: Active (Click to open)"
        );

        this.randomBtn = new CanvasButton(
            -32, 4, 26, 13, "RND",
            "rgba(15, 23, 42, 0.72)", "#7e22ce",
            () => {
                window.dispatchEvent(new CustomEvent('add-random-node', { detail: { parentId: this.id } }));
            },
            "Open Random Mod",
            (node: any) => Boolean(node.hasAttachedRandomMod?.()),
            "#7e22ce", "#9333ea",
            "Random Mod: Active (Click to open)"
        );

        this.removeBtn = new CanvasButton(
            48, 54, 16, 16, "×", "#5f1720", "#b91c1c",
            () => {
                if (this.graph) {
                    this.graph.remove(this);
                } else {
                    window.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId: this.id } }));
                }
            },
            "Delete Node"
        );

        this.addButton(this.previewBtn);
        this.addButton(this.renderToggleBtn);
        this.addButton(this.freezeToggleBtn);
        this.addButton(this.eyeBtn);
        this.addButton(this.poolBtn);
        this.addButton(this.randomBtn);
        this.addButton(this.removeBtn);
        this.size = this.computeSize();
        this.resizable = this.isVisualizationActive;
        this.updateButtonLayout();
    }

    onConfigure(_info: any): void {
        if (this.properties.visualization_enabled === undefined && this.isVisualizationSupported) {
            this.properties.visualization_enabled = true;
        }
        if (this.properties.freeze_refresh === undefined) {
            this.properties.freeze_refresh = true;
        }
        if (this.properties.render_enabled === undefined) {
            this.properties.render_enabled = true;
        }
        this.size = this.computeSize();
        this.resizable = this.isVisualizationActive;
        this.updateButtonLayout();
    }

    updateButtonLayout(): void {
        const supportsPool = this.isPoolSupported;
        if (this.isVisualizationActive) {
            this.previewBtn.x = -38; this.previewBtn.y = 3; this.previewBtn.width = 16; this.previewBtn.height = 16;
            this.eyeBtn.x = -20; this.eyeBtn.y = 3; this.eyeBtn.width = 16; this.eyeBtn.height = 16;
            this.eyeBtn.color = "#0284c7"; this.eyeBtn.hoverColor = "#38bdf8";
            this.poolBtn.label = "POOL";
            this.poolBtn.x = -63; this.poolBtn.y = 4; this.poolBtn.width = 28; this.poolBtn.height = 13;
            this.randomBtn.label = "RND";
            this.randomBtn.x = -32; this.randomBtn.y = 4; this.randomBtn.width = 26; this.randomBtn.height = 13;
            this.renderToggleBtn.x = -80; this.renderToggleBtn.y = 3; this.renderToggleBtn.width = 16; this.renderToggleBtn.height = 16;
            this.freezeToggleBtn.x = -60; this.freezeToggleBtn.y = 3; this.freezeToggleBtn.width = 16; this.freezeToggleBtn.height = 16;
            this.removeBtn.x = -20; this.removeBtn.y = 3; this.removeBtn.width = 16; this.removeBtn.height = 16;
        } else {
            this.eyeBtn.x = 2; this.eyeBtn.y = 2; this.eyeBtn.width = 13; this.eyeBtn.height = 13;
            this.eyeBtn.color = "rgba(15, 23, 42, 0.75)"; this.eyeBtn.hoverColor = "#0284c7";
            this.poolBtn.label = "P";
            this.poolBtn.x = supportsPool ? -30 : -15; this.poolBtn.y = 2; this.poolBtn.width = 13; this.poolBtn.height = 13;
            this.randomBtn.label = "R";
            this.randomBtn.x = -15; this.randomBtn.y = 2; this.randomBtn.width = 13; this.randomBtn.height = 13;
            this.previewBtn.x = 48; this.previewBtn.y = 0; this.previewBtn.width = 16; this.previewBtn.height = 16;
            this.renderToggleBtn.x = 48; this.renderToggleBtn.y = 18; this.renderToggleBtn.width = 16; this.renderToggleBtn.height = 16;
            this.freezeToggleBtn.x = 48; this.freezeToggleBtn.y = 36; this.freezeToggleBtn.width = 16; this.freezeToggleBtn.height = 16;
            this.removeBtn.x = 48; this.removeBtn.y = 54; this.removeBtn.width = 16; this.removeBtn.height = 16;
        }
    }

    /**
     * Returns only the modifier badges rendered in the top-right corner of the node canvas (Pool / Random Mod).
     * At Stage 3 (maximum distance) or when visualization is unsupported, no canvas buttons are shown.
     */
    getVisibleCanvasButtons(isSelected: boolean = true, isHovered: boolean = false): CanvasButton[] {
        if (!this.isVisualizationSupported || this._distanceStage === 3) {
            return [];
        }
        const showAll = this.isVisualizationActive ? isSelected : (isSelected || isHovered);
        let btns: CanvasButton[];
        if (!showAll) {
            btns = [];
            if (this.isPoolSupported && this.hasAttachedPool()) btns.push(this.poolBtn);
            if (this.hasAttachedRandomMod()) btns.push(this.randomBtn);
        } else {
            btns = [];
            if (this.isPoolSupported) btns.push(this.poolBtn);
            btns.push(this.randomBtn);
        }

        const rightMargin = this.isVisualizationActive ? 6 : 2;
        const gap = this.isVisualizationActive ? 3 : 2;
        const topY = this.isVisualizationActive ? 4 : 2;
        let offsetRight = rightMargin;
        for (let i = btns.length - 1; i >= 0; i--) {
            const btn = btns[i];
            btn.y = topY;
            btn.x = -(offsetRight + btn.width);
            offsetRight += btn.width + gap;
        }
        return btns;
    }

    addButton(btn: CanvasButton) {
        this.buttons.push(btn);
    }

    computeSize(): [number, number] {
        if (this.isVisualizationActive) {
            this.resizable = true;
            const activeCanvas = (LiteGraph as any)?.LGraphCanvas?.active_canvas
                || ((typeof window !== 'undefined') ? (window as any).editorCanvas : null);
            if (activeCanvas?.resizing_node === this) {
                return [BaseNode.minVisualWidth, BaseNode.minVisualHeight];
            }
            const customW = Number(this.properties?.visual_width);
            const customH = Number(this.properties?.visual_height);
            const w = Math.max(BaseNode.minVisualWidth, customW > 0 ? customW : this.visualPanelWidth);
            const h = Math.max(BaseNode.minVisualHeight, customH > 0 ? customH : this.visualPanelHeight);
            return [w, h];
        }
        this.resizable = false;
        return [BaseNode.visualSize, BaseNode.visualSize];
    }

    onResize(size: [number, number]): void {
        if (this.isVisualizationActive && size) {
            const w = Math.max(BaseNode.minVisualWidth, Math.round(size[0]));
            const h = Math.max(BaseNode.minVisualHeight, Math.round(size[1]));
            if (Array.isArray(this.size)) {
                this.size[0] = w;
                this.size[1] = h;
            } else {
                this.size = [w, h];
            }
            if (this.properties) {
                this.properties.visual_width = w;
                this.properties.visual_height = h;
            }
            this.updateButtonLayout();
            this.setDirtyCanvas(true, true);
        }
    }

    getTitle(): string {
        return this.properties?.node_name || this.title || "AudioNode";
    }

    canBeMainPreview(): boolean {
        return !this.properties?.disabled;
    }

    isPointInside(x: number, y: number, margin: number = 0): boolean {
        const [width, height] = this.size;
        const isHoveredOrSelected = Boolean(this.is_selected || ((window as any).editorCanvas?.node_over === this));
        const extraRight = 8;
        const extraTop = isHoveredOrSelected && !this.isVisualizationActive ? 32 : 0;
        const extraBottom = 8;

        return (
            x >= this.pos[0] - margin - 8 &&
            x <= this.pos[0] + width + margin + extraRight &&
            y >= this.pos[1] - margin - extraTop &&
            y <= this.pos[1] + height + margin + extraBottom
        );
    }

    onDrawForeground(ctx: CanvasRenderingContext2D, canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden || this.isModifier) return;
        const isHovered = Boolean(canvas && canvas.node_over === this);
        const isSelected = canvas?.selected_nodes
            ? Boolean(canvas.selected_nodes[this.id] || canvas.selected_nodes[String(this.id)])
            : Boolean(this.is_selected);

        const visibleBtns = this.getVisibleCanvasButtons(isSelected, isHovered);
        for (const btn of visibleBtns) {
            btn.draw(ctx, this);
        }
    }

    onMouseMove(_e: MouseEvent, local_pos: any, canvas: any) {
        if (this.flags.collapsed || (this.flags as any).hidden || this.isModifier) return;
        const isHovered = Boolean(canvas && canvas.node_over === this);
        const isSelected = canvas?.selected_nodes
            ? Boolean(canvas.selected_nodes[this.id] || canvas.selected_nodes[String(this.id)])
            : Boolean(this.is_selected);
        const visibleBtns = this.getVisibleCanvasButtons(isSelected, isHovered);
        if (visibleBtns.length === 0) return;

        if (!local_pos || local_pos.length < 2) return;
        const x = local_pos[0];
        const y = local_pos[1];
        let dirty = false;
        let hoveredTooltip: string | null = null;
        for (const btn of visibleBtns) {
            const hit = btn.checkHit(x, y, this);
            if (btn.isHovered !== hit) {
                btn.isHovered = hit;
                dirty = true;
            }
            if (hit) {
                const tip = typeof btn.resolveTooltip === 'function' ? btn.resolveTooltip(this) : btn.tooltip;
                if (tip) hoveredTooltip = tip;
            }
        }
        if (canvas?.canvas) {
            if (hoveredTooltip) {
                canvas.canvas.title = hoveredTooltip;
            } else if (canvas.canvas.title) {
                canvas.canvas.title = '';
            }
        }
        if (dirty) {
            this.setDirtyCanvas(true, true);
        }
    }

    onMouseLeave?(_e: MouseEvent, _prev_node: any) {
        for (const btn of this.buttons) {
            btn.isHovered = false;
        }
        if ((window as any).editorCanvas?.canvas?.title) {
            (window as any).editorCanvas.canvas.title = '';
        }
        this.setDirtyCanvas(true, true);
    }

    onMouseDown(_e: MouseEvent, local_pos: any, _canvas: any): boolean {
        if (this.flags.collapsed || (this.flags as any).hidden || this.isModifier) return false;
        const isHovered = Boolean(_canvas && _canvas.node_over === this);
        const isSelected = _canvas?.selected_nodes
            ? Boolean(_canvas.selected_nodes[this.id] || _canvas.selected_nodes[String(this.id)])
            : Boolean(this.is_selected);
        const visibleBtns = this.getVisibleCanvasButtons(isSelected, isHovered);
        if (visibleBtns.length === 0) return false;

        if (local_pos && local_pos.length >= 2) {
            const x = local_pos[0];
            const y = local_pos[1];
            for (const btn of visibleBtns) {
                if (btn.checkHit(x, y, this)) {
                    btn.onClick(_e);
                    return true;
                }
            }
        }

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
        const [width, height] = this.size;

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
