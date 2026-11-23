import { type BaseNode, type NodeToolbarControl } from '../nodes/BaseNode.ts';
import { APPEARANCE_COLOR_PRESETS } from '../config/appearance.ts';
import { RandomParamOverlay } from './RandomParamOverlay.ts';
import { renderIcon, type IconName } from '../../../packages/ui/src/icons.js';
import { enhanceSelect } from '../../../packages/ui/src/dropdown.js';

export class NodeContextToolbar {
    readonly element: HTMLElement;
    private nodes: any[] = [];
    private colorPopover: HTMLElement | null = null;
    private disposed = false;
    private readonly handleGraphRefresh: () => void;
    private readonly handleDocumentPointerDown: (event: PointerEvent) => void;

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'node-context-toolbar is-hidden';
        this.element.setAttribute('role', 'toolbar');
        this.element.setAttribute('aria-label', 'Selected node controls');

        const stopCanvasEvent = (event: Event) => {
            event.stopPropagation();
        };
        for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
            this.element.addEventListener(eventName, stopCanvasEvent);
        }

        this.handleGraphRefresh = () => {
            if (!this.disposed && this.nodes.length > 0) {
                this.render();
            }
        };

        this.handleDocumentPointerDown = (event: PointerEvent) => {
            const target = event.target as HTMLElement | null;
            if (this.colorPopover && !this.colorPopover.contains(target) && !target?.closest('.nct-color-dot')) {
                this.closeColorPopover();
            }
        };

        window.addEventListener('node-properties-refreshed', this.handleGraphRefresh);
        window.addEventListener('node-property-changed', this.handleGraphRefresh);
        window.addEventListener('node-visualization-changed', this.handleGraphRefresh);
        window.addEventListener('modifier-assignment-changed', this.handleGraphRefresh);
        window.addEventListener('graph-connections-changed', this.handleGraphRefresh);
        document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
    }

    public setNodes(selectedNodes: any[]): void {
        this.nodes = Array.isArray(selectedNodes) ? selectedNodes.filter(Boolean) : [];
        this.render();
    }

    public syncFromCanvas(graphCanvas: any): void {
        const selectedMap = graphCanvas?.selected_nodes;
        const selectedList = selectedMap && typeof selectedMap === 'object'
            ? Object.values(selectedMap).filter(Boolean)
            : [];
        this.setNodes(selectedList);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.closeColorPopover();
        window.removeEventListener('node-properties-refreshed', this.handleGraphRefresh);
        window.removeEventListener('node-property-changed', this.handleGraphRefresh);
        window.removeEventListener('node-visualization-changed', this.handleGraphRefresh);
        window.removeEventListener('modifier-assignment-changed', this.handleGraphRefresh);
        window.removeEventListener('graph-connections-changed', this.handleGraphRefresh);
        document.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
        this.element.remove();
    }

    private closeColorPopover(): void {
        if (this.colorPopover) {
            this.colorPopover.remove();
            this.colorPopover = null;
        }
    }

    private createDivider(): HTMLElement {
        const div = document.createElement('span');
        div.className = 'ui-divider nct-divider';
        div.setAttribute('aria-hidden', 'true');
        return div;
    }

    private notifyNodesChanged(nodes: any[]): void {
        const graphCanvas = (window as any).editorCanvas;
        for (const node of nodes) {
            node?.setDirtyCanvas?.(true, true);
            if (node?.id != null) {
                window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: node.id } }));
            }
        }
        graphCanvas?.setDirty?.(true, true);
    }

    private applyColorToNodes(nodes: any[], colorValue: string): void {
        for (const target of nodes) {
            if (!target) continue;
            if (typeof target.updateProperty === 'function') {
                target.updateProperty('color', colorValue);
            } else if (target.properties) {
                target.properties.color = colorValue;
            }
            if (target.properties) {
                target.properties.user_color = true;
            }
            target.color = colorValue;
            target.bgcolor = colorValue;
            target.boxcolor = colorValue;
        }
        this.notifyNodesChanged(nodes);
        this.render();
    }

    private openColorPopover(anchor: HTMLElement, targetNodes: any[]): void {
        if (this.colorPopover) {
            this.closeColorPopover();
            return;
        }
        const pop = document.createElement('div');
        pop.className = 'nct-color-popover sin-menu-surface';
        const stop = (e: Event) => e.stopPropagation();
        for (const eventName of ['pointerdown', 'mousedown', 'click', 'contextmenu']) {
            pop.addEventListener(eventName, stop);
        }

        const currentColor = String(
            targetNodes[0]?.properties?.color || targetNodes[0]?.nodeColor || targetNodes[0]?.color || ''
        ).toLowerCase();

        const grid = document.createElement('div');
        grid.className = 'ctx-menu-colors-grid';
        for (const preset of APPEARANCE_COLOR_PRESETS) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = `ctx-color-swatch ${preset.value.toLowerCase() === currentColor ? 'active' : ''}`;
            swatch.style.backgroundColor = preset.value;
            swatch.title = preset.label;
            swatch.setAttribute('aria-label', preset.label);
            swatch.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeColorPopover();
                this.applyColorToNodes(targetNodes, preset.value);
            });
            grid.appendChild(swatch);
        }
        pop.appendChild(grid);
        document.body.appendChild(pop);

        const rect = anchor.getBoundingClientRect();
        const popRect = pop.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.left));
        const top = Math.min(window.innerHeight - popRect.height - 8, rect.bottom + 6);
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        this.colorPopover = pop;
    }

    private createColorDotButton(targetNodes: any[]): HTMLButtonElement {
        const color = String(
            targetNodes[0]?.properties?.color || targetNodes[0]?.nodeColor || targetNodes[0]?.color || '#64748b'
        );
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'ui-btn ui-btn--icon nct-color-dot';
        dot.title = 'Node color';
        dot.setAttribute('aria-label', 'Change node color');
        const swatch = document.createElement('span');
        swatch.className = 'nct-color-swatch-inner';
        swatch.style.backgroundColor = color;
        dot.appendChild(swatch);
        dot.addEventListener('click', () => {
            this.openColorPopover(dot, targetNodes);
        });
        return dot;
    }

    private createToggleButton(opts: {
        label?: string;
        iconHtml?: string;
        title: string;
        active: boolean;
        tone?: 'neutral' | 'amber' | 'sky' | 'emerald' | 'danger';
        disabled?: boolean;
        onClick: () => void;
    }): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = opts.label && !opts.iconHtml
            ? 'ui-btn ui-btn--bordered nct-btn nct-btn--text'
            : (opts.label ? 'ui-btn ui-btn--bordered nct-btn nct-btn--labeled' : 'ui-btn ui-btn--icon ui-btn--bordered nct-btn');
        btn.title = opts.title;
        btn.setAttribute('aria-label', opts.title);
        btn.setAttribute('aria-pressed', String(opts.active));
        if (opts.active) btn.classList.add('is-active');
        if (opts.tone && opts.tone !== 'neutral') btn.dataset.tone = opts.tone;
        if (opts.disabled) btn.disabled = true;

        if (opts.iconHtml && opts.label) {
            btn.innerHTML = `${opts.iconHtml}<span class="nct-btn-label">${opts.label}</span>`;
        } else if (opts.iconHtml) {
            btn.innerHTML = opts.iconHtml;
        } else if (opts.label) {
            btn.textContent = opts.label;
        }

        btn.addEventListener('click', () => {
            opts.onClick();
        });
        return btn;
    }

    private renderControl(ctrl: NodeToolbarControl): HTMLElement {
        if (ctrl.kind === 'slot-strip') {
            const strip = document.createElement('div');
            strip.className = 'nct-slot-strip';
            const selectedSet = new Set(ctrl.selectedIndices || [ctrl.activeIndex]);
            for (let i = 0; i < ctrl.count; i++) {
                const pill = document.createElement('button');
                pill.type = 'button';
                pill.className = 'nct-slot-pill';
                const isActive = i === ctrl.activeIndex;
                const isSelected = selectedSet.has(i);
                if (isActive) pill.classList.add('is-active');
                else if (isSelected) pill.classList.add('is-selected');
                pill.textContent = String(i);
                pill.title = `Select Slot ${i}`;
                pill.addEventListener('click', () => ctrl.onSelect(i));
                strip.appendChild(pill);

                if (isActive) {
                    const addBtn = document.createElement('button');
                    addBtn.type = 'button';
                    addBtn.className = 'nct-slot-action nct-slot-add';
                    addBtn.innerHTML = renderIcon('plus');
                    addBtn.title = 'Add new slot';
                    addBtn.setAttribute('aria-label', 'Add new slot');
                    addBtn.addEventListener('click', () => ctrl.onAdd());
                    strip.appendChild(addBtn);

                    if (ctrl.onRemove && ctrl.count > 1) {
                        const removeBtn = document.createElement('button');
                        removeBtn.type = 'button';
                        removeBtn.className = 'nct-slot-action nct-slot-remove';
                        removeBtn.textContent = '×';
                        removeBtn.title = `Remove Slot ${i}`;
                        removeBtn.setAttribute('aria-label', `Remove Slot ${i}`);
                        removeBtn.addEventListener('click', () => ctrl.onRemove?.());
                        strip.appendChild(removeBtn);
                    }
                }
            }
            return strip;
        }

        if (ctrl.kind === 'segmented') {
            const seg = document.createElement('div');
            seg.className = 'ui-segmented nct-segmented';
            if (ctrl.title) seg.title = ctrl.title;
            for (const opt of ctrl.options) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ui-segmented-btn';
                const isActive = ctrl.value === opt.value;
                btn.classList.toggle('is-active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
                btn.textContent = opt.label;
                if (opt.title) btn.title = opt.title;
                btn.addEventListener('click', () => {
                    if (ctrl.value !== opt.value) {
                        ctrl.onChange(opt.value);
                    }
                });
                seg.appendChild(btn);
            }
            return seg;
        }

        if (ctrl.kind === 'select') {
            const wrap = document.createElement('div');
            wrap.className = 'nct-select-wrap';
            if (ctrl.label) {
                const lbl = document.createElement('span');
                lbl.className = 'nct-inline-label';
                lbl.textContent = ctrl.label;
                wrap.appendChild(lbl);
            }
            const select = document.createElement('select');
            select.className = 'nct-select';
            if (ctrl.title) select.title = ctrl.title;
            select.setAttribute('aria-label', ctrl.title || ctrl.label || ctrl.id);
            for (const opt of ctrl.options) {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.label;
                if (opt.value === ctrl.value) option.selected = true;
                select.appendChild(option);
            }
            select.value = ctrl.value;
            select.addEventListener('change', () => ctrl.onChange(select.value));
            wrap.appendChild(select);
            enhanceSelect(select, { size: 'sm' });
            return wrap;
        }

        if (ctrl.kind === 'toggle') {
            return this.createToggleButton({
                label: ctrl.label,
                iconHtml: ctrl.icon ? renderIcon(ctrl.icon as IconName) : undefined,
                title: ctrl.title || ctrl.label,
                active: ctrl.active,
                tone: ctrl.tone,
                onClick: () => {
                    ctrl.onToggle();
                    this.render();
                }
            });
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = ctrl.tone === 'danger'
            ? 'ui-btn ui-btn--bordered ui-btn--danger nct-btn nct-btn--labeled'
            : 'ui-btn ui-btn--bordered nct-btn nct-btn--labeled';
        if (ctrl.title) btn.title = ctrl.title;
        if (ctrl.disabled) btn.disabled = true;
        const iconHtml = ctrl.icon ? renderIcon(ctrl.icon as IconName) : '';
        btn.innerHTML = iconHtml ? `${iconHtml}<span class="nct-btn-label">${ctrl.label}</span>` : ctrl.label;
        btn.addEventListener('click', () => ctrl.onClick());
        return btn;
    }

    private renderSingleNode(node: any): void {
        const identity = document.createElement('div');
        identity.className = 'nct-identity';

        const badge = document.createElement('span');
        badge.className = 'node-badge nct-badge';
        const badgeLabel = typeof node.getNodeBadgeLabel === 'function'
            ? node.getNodeBadgeLabel()
            : (node.badgeLabel || (node.constructor as any)?.badgeLabel || 'NODE');
        badge.textContent = String(badgeLabel);

        const title = document.createElement('span');
        title.className = 'nct-title';
        const nodeTitle = String(node.properties?.node_name || node.title || `Node #${node.id ?? ''}`).trim();
        title.textContent = nodeTitle;
        title.title = nodeTitle;

        identity.append(badge, title, this.createColorDotButton([node]));
        this.element.appendChild(identity);

        const isModifier = Boolean(node.isModifier);
        if (!isModifier) {
            this.element.appendChild(this.createDivider());
            const commonGroup = document.createElement('div');
            commonGroup.className = 'nct-group';

            if (node.isVisualizationSupported !== false && typeof node.toggleVisualization === 'function') {
                const isVizOn = node.properties?.visualization_enabled !== false;
                const isFarStage = Number(node.currentDistanceStage) === 3;
                commonGroup.appendChild(this.createToggleButton({
                    iconHtml: renderIcon(isVizOn && !isFarStage ? 'eye' : 'eyeOff'),
                    title: isFarStage
                        ? 'Viewer Cook: Auto-collapsed to icon at current zoom'
                        : `Viewer Cook: ${isVizOn ? 'ON' : 'OFF'}`,
                    active: isVizOn && !isFarStage,
                    disabled: isFarStage,
                    tone: 'sky',
                    onClick: () => {
                        node.toggleVisualization();
                        this.notifyNodesChanged([node]);
                        this.render();
                    }
                }));
            }

            const isRenderOn = node.properties?.render_enabled !== false;
            commonGroup.appendChild(this.createToggleButton({
                label: 'R',
                title: `Include in Global Render: ${isRenderOn ? 'ON' : 'OFF'}`,
                active: isRenderOn,
                tone: 'emerald',
                onClick: () => {
                    const next = node.properties?.render_enabled === false;
                    if (typeof node.updateProperty === 'function') node.updateProperty('render_enabled', next);
                    else if (node.properties) node.properties.render_enabled = next;
                    this.notifyNodesChanged([node]);
                    this.render();
                }
            }));

            const isFreezeOn = node.properties?.freeze_refresh !== false;
            commonGroup.appendChild(this.createToggleButton({
                iconHtml: renderIcon('freeze'),
                title: `Freeze Protection: ${isFreezeOn ? 'ON' : 'OFF'}`,
                active: isFreezeOn,
                tone: 'sky',
                onClick: () => {
                    const next = node.properties?.freeze_refresh === false;
                    if (typeof node.updateProperty === 'function') node.updateProperty('freeze_refresh', next);
                    else if (node.properties) node.properties.freeze_refresh = next;
                    this.notifyNodesChanged([node]);
                    this.render();
                }
            }));

            const hasRandomMod = typeof node.hasAttachedRandomMod === 'function'
                ? Boolean(node.hasAttachedRandomMod())
                : Boolean(RandomParamOverlay.getAttachedRandomModifier(node));
            commonGroup.appendChild(this.createToggleButton({
                iconHtml: renderIcon('dice'),
                title: hasRandomMod ? 'Random Modifier (open or edit ranges)' : 'Add Random Modifier',
                active: hasRandomMod,
                tone: 'amber',
                onClick: () => {
                    window.dispatchEvent(new CustomEvent('add-random-node', {
                        detail: { parentId: node.id, forceOpen: true }
                    }));
                }
            }));

            if (typeof node.previewBtn?.onClick === 'function') {
                const playBtn = document.createElement('button');
                playBtn.type = 'button';
                playBtn.className = 'ui-btn ui-btn--icon ui-btn--bordered nct-btn';
                playBtn.title = 'Preview node audio';
                playBtn.setAttribute('aria-label', 'Preview node audio');
                playBtn.innerHTML = renderIcon('play');
                playBtn.addEventListener('click', () => {
                    node.previewBtn.onClick();
                });
                commonGroup.appendChild(playBtn);
            }

            if (node.isVisualizationSupported !== false && typeof node.getSupportedVisualizationOptions === 'function') {
                const options = node.getSupportedVisualizationOptions() as Array<{ id: string; label: string }>;
                if (options.length > 0) {
                    const currentViz = typeof node.getVisualizationType === 'function'
                        ? String(node.getVisualizationType())
                        : options[0].id;
                    const select = document.createElement('select');
                    select.className = 'nct-select nct-viz-select';
                    select.title = 'Visualization Type';
                    select.setAttribute('aria-label', 'Visualization Type');
                    for (const opt of options) {
                        const optionEl = document.createElement('option');
                        optionEl.value = opt.id;
                        optionEl.textContent = opt.label;
                        if (opt.id === currentViz) optionEl.selected = true;
                        select.appendChild(optionEl);
                    }
                    select.value = currentViz;
                    select.addEventListener('change', () => {
                        node.setVisualizationType?.(select.value);
                        this.render();
                    });
                    commonGroup.appendChild(select);
                    enhanceSelect(select, { size: 'sm' });
                }
            }

            this.element.appendChild(commonGroup);
        }

        const customControls = typeof (node as BaseNode).getToolbarControls === 'function'
            ? (node as BaseNode).getToolbarControls()
            : [];
        if (customControls.length > 0) {
            this.element.appendChild(this.createDivider());
            const customGroup = document.createElement('div');
            customGroup.className = 'nct-group';
            for (const ctrl of customControls) {
                customGroup.appendChild(this.renderControl(ctrl));
            }
            this.element.appendChild(customGroup);
        }

        if (!isModifier) {
            this.element.appendChild(this.createDivider());
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'ui-btn ui-btn--icon ui-btn--bordered ui-btn--danger nct-btn';
            deleteBtn.title = 'Delete selected node';
            deleteBtn.setAttribute('aria-label', 'Delete selected node');
            deleteBtn.innerHTML = renderIcon('trash');
            deleteBtn.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('delete-node', { detail: { nodeId: node.id } }));
            });
            this.element.appendChild(deleteBtn);
        }
    }

    private renderMultiSelection(nodes: any[]): void {
        const countEl = document.createElement('span');
        countEl.className = 'nct-multi-count';
        countEl.textContent = `${nodes.length} selected`;

        this.element.append(countEl, this.createColorDotButton(nodes), this.createDivider());

        const batchGroup = document.createElement('div');
        batchGroup.className = 'nct-group';

        const vizNodes = nodes.filter(n => !n.isModifier && n.isVisualizationSupported !== false && typeof n.toggleVisualization === 'function');
        if (vizNodes.length > 0) {
            const allFarStage = vizNodes.every(n => Number(n.currentDistanceStage) === 3);
            const anyVizOff = vizNodes.some(n => n.properties?.visualization_enabled === false);
            batchGroup.appendChild(this.createToggleButton({
                iconHtml: renderIcon('eye'),
                label: anyVizOff ? 'Show' : 'Hide',
                title: allFarStage
                    ? 'Viewer Cook: Auto-collapsed to icon at current zoom'
                    : 'Toggle Viewer Cook on selected nodes',
                active: !anyVizOff && !allFarStage,
                disabled: allFarStage,
                tone: 'sky',
                onClick: () => {
                    for (const n of vizNodes) {
                        const isCurrentlyOn = n.properties?.visualization_enabled !== false;
                        if (anyVizOff ? !isCurrentlyOn : isCurrentlyOn) {
                            n.toggleVisualization();
                        }
                    }
                    this.notifyNodesChanged(vizNodes);
                    this.render();
                }
            }));
        }

        const flagNodes = nodes.filter(n => !n.isModifier);
        if (flagNodes.length > 0) {
            const allRenderOn = flagNodes.every(n => n.properties?.render_enabled !== false);
            batchGroup.appendChild(this.createToggleButton({
                label: 'R',
                title: allRenderOn ? 'Disable Render Flag on selected nodes' : 'Enable Render Flag on selected nodes',
                active: allRenderOn,
                tone: 'emerald',
                onClick: () => {
                    const next = !allRenderOn;
                    for (const n of flagNodes) {
                        if (typeof n.updateProperty === 'function') n.updateProperty('render_enabled', next);
                        else if (n.properties) n.properties.render_enabled = next;
                    }
                    this.notifyNodesChanged(flagNodes);
                    this.render();
                }
            }));

            const allFreezeOn = flagNodes.every(n => n.properties?.freeze_refresh !== false);
            batchGroup.appendChild(this.createToggleButton({
                iconHtml: renderIcon('freeze'),
                title: allFreezeOn ? 'Disable Freeze Flag on selected nodes' : 'Enable Freeze Flag on selected nodes',
                active: allFreezeOn,
                tone: 'sky',
                onClick: () => {
                    const next = !allFreezeOn;
                    for (const n of flagNodes) {
                        if (typeof n.updateProperty === 'function') n.updateProperty('freeze_refresh', next);
                        else if (n.properties) n.properties.freeze_refresh = next;
                    }
                    this.notifyNodesChanged(flagNodes);
                    this.render();
                }
            }));
        }

        this.element.append(batchGroup, this.createDivider());

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ui-btn ui-btn--bordered ui-btn--danger nct-btn nct-btn--labeled';
        delBtn.title = `Delete ${nodes.length} selected nodes`;
        delBtn.innerHTML = `${renderIcon('trash')}<span class="nct-btn-label">Delete (${nodes.length})</span>`;
        delBtn.addEventListener('click', () => {
            const ids = nodes.map(n => n?.id).filter(id => id != null);
            for (const nodeId of ids) {
                window.dispatchEvent(new CustomEvent('delete-node', { detail: { nodeId } }));
            }
        });
        this.element.appendChild(delBtn);
    }

    private render(): void {
        this.closeColorPopover();
        this.element.innerHTML = '';
        if (this.nodes.length === 0) {
            this.element.classList.add('is-hidden');
            return;
        }
        this.element.classList.remove('is-hidden');
        if (this.nodes.length === 1) {
            this.renderSingleNode(this.nodes[0]);
        } else {
            this.renderMultiSelection(this.nodes);
        }
    }
}
