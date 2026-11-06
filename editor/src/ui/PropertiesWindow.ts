import { LGraphNode } from 'litegraph.js';
import { WaveformVisualizer } from './WaveformVisualizer';
import { ArrangementVisualizer } from './ArrangementVisualizer';
import { getGhostSource, isGhostFieldLinked, isGhostNode, relinkGhostField, syncGhostTrackData, unlinkGhostField } from '../ghosts';
import { SectionRendererFactory } from './SectionRendererFactory';
import { RandomParamOverlay } from './RandomParamOverlay';

export class PropertiesWindow {
    container: HTMLElement;
    node: LGraphNode;
    onClose: () => void;
    activeTab: string;
    currentWaveformVisualizer: WaveformVisualizer | null = null;
    currentArrangementVisualizer: ArrangementVisualizer | null = null;
    currentPoolPreviewAudio: HTMLAudioElement | null = null;
    currentPoolPreviewButton: HTMLButtonElement | null = null;
    renderToken: number = 0;
    private tabRenderQueue: Promise<void> = Promise.resolve();
    private isRenderingTab: boolean = false;
    private pendingTabRender: boolean = false;
    private modifierAssignmentHandler: (event: Event) => void;
    private nodePropertiesRefreshHandler: (event: Event) => void;
    private arrangementGraphHandler: () => void;
    private disposed: boolean = false;
    private isRandomMappingMode: boolean = false;
    private startRandomMappingHandler: (event: Event) => void;

    constructor(container: HTMLElement, node: LGraphNode, onClose: () => void) {
        this.container = container;
        this.node = node;
        this.modifierAssignmentHandler = (event: Event) => {
            if ((event as CustomEvent).detail?.nodeId === this.node.id) void this.render();
        };
        this.nodePropertiesRefreshHandler = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.nodeId === this.node.id && !detail?.liveTelemetry) void this.renderTabContent();
        };
        this.arrangementGraphHandler = () => {
            if ((this.node as any).shouldRefreshTabOnGraphChange?.(this.activeTab)) {
                void this.renderTabContent();
            }
        };
        this.startRandomMappingHandler = (event: Event) => {
            if ((event as CustomEvent).detail?.nodeId === this.node.id) {
                this.isRandomMappingMode = true;
                if (!(this.node as any).isModifier) {
                    RandomParamOverlay.getOrCreateRandomModifier(this.node as any);
                }
                const randomModeBtn = this.container.querySelector('#td-random-mode-btn');
                if (randomModeBtn) {
                    randomModeBtn.classList.add('active');
                    const textSpan = randomModeBtn.querySelector('.random-mode-btn-text');
                    if (textSpan) textSpan.textContent = 'Mapping ON';
                }
                void this.render();
            }
        };
        window.addEventListener('modifier-assignment-changed', this.modifierAssignmentHandler);
        window.addEventListener('node-properties-refreshed', this.nodePropertiesRefreshHandler);
        window.addEventListener('graph-connections-changed', this.arrangementGraphHandler);
        window.addEventListener('arrangement-length-changed', this.arrangementGraphHandler);
        window.addEventListener('arrangement-source-changed', this.arrangementGraphHandler);
        window.addEventListener('start-random-mapping', this.startRandomMappingHandler);
        this.onClose = () => {
            this.dispose();
            onClose();
        };
        this.activeTab = this.getDefaultTab();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.renderToken++;
        if (this.currentWaveformVisualizer) {
            this.currentWaveformVisualizer.destroy();
            this.currentWaveformVisualizer = null;
        }
        if (this.currentArrangementVisualizer) {
            this.currentArrangementVisualizer.destroy();
            this.currentArrangementVisualizer = null;
        }
        this.stopPoolItemPreview();
        RandomParamOverlay.closePopover();
        window.removeEventListener('modifier-assignment-changed', this.modifierAssignmentHandler);
        window.removeEventListener('node-properties-refreshed', this.nodePropertiesRefreshHandler);
        window.removeEventListener('graph-connections-changed', this.arrangementGraphHandler);
        window.removeEventListener('arrangement-length-changed', this.arrangementGraphHandler);
        window.removeEventListener('arrangement-source-changed', this.arrangementGraphHandler);
        window.removeEventListener('start-random-mapping', this.startRandomMappingHandler);
    }

    private getDefaultTab(): string {
        const nodeAny = this.node as any;
        if (typeof nodeAny.getDefaultPropertiesTab === 'function') {
            return nodeAny.getDefaultPropertiesTab();
        }
        return nodeAny.defaultPropertiesTab || "PARAMS";
    }

    private getTabList(): string[] {
        const nodeAny = this.node as any;
        if (typeof nodeAny.getPropertiesTabs === 'function') {
            return nodeAny.getPropertiesTabs();
        }
        return nodeAny.propertiesTabs || ["PARAMS", "COMMON"];
    }

    private getNodeBadge(): string {
        const nodeAny = this.node as any;
        if (typeof nodeAny.getNodeBadgeLabel === 'function') {
            return nodeAny.getNodeBadgeLabel();
        }
        return nodeAny.badgeLabel || "NODE";
    }

    private applyGhostBindingControls(container: HTMLElement) {
        if (!isGhostNode(this.node) || !getGhostSource(this.node)) return;

        container.querySelectorAll('.ghost-binding-toggle, .ghost-binding-toolbar').forEach(element => element.remove());

        const labelFields: Record<string, string[]> = {
            'name': ['node_name'],
            'modulator name': ['node_name'],
            'mix mode': ['mix_mode'],
            'engine bpm': ['bpm', 'target_bpm'],
            'length': ['total_bars'],
            'asset file': ['filepath'],
            'asset': ['filepath'],
            'midi asset': ['filepath'],
            'file': ['filepath'],
            'type': ['sample_type'],
            'key': ['key'],
            'start beat': ['start_beat'],
            'original bpm': ['original_bpm'],
            'target bpm': ['target_bpm', 'bpm'],
            'color': ['color'],
            'icon': ['icon'],
            'shape': ['shape'],
            'transpose': ['transpose'],
            'fine tune': ['cents'],
            'stretch mode': ['stretch_mode'],
            'stretch factor': ['stretch_factor'],
            'start point': ['crop_start'],
            'end point': ['crop_end'],
            'step length': ['step_length'],
            'play mode': ['play_mode'],
            'voice mode': ['play_mode'],
            'release': ['release'],
            'gate length': ['step_parameters'],
            'gate': ['step_parameters'],
            'seed': ['seed'],
            'seed mode': ['seed_mode'],
            'playback': ['playbackMode'],
            'playback mode': ['playbackMode'],
            'refresh': ['refresh_mode'],
            'refresh mode': ['refresh_mode'],
            'offset': ['step_parameters'],
            'velocity': ['step_parameters'],
            'probability': ['step_parameters'],
            'quantize': ['section_quant'],
            'anchor': ['section_quant_anchor'],
            'roll': ['step_parameters'],
            'subdivisions': ['step_parameters'],
            'node color': ['color'],
            'color presets': ['color'],
            'node icon': ['icon'],
            'pool items': ['selected_items'],
            'matches': ['selected_items'],
            ...((this.node as any).getGhostBoundFieldOverrides?.() || {})
        };

        const setBoundState = (host: HTMLElement, linked: boolean) => {
            host.classList.toggle('ghost-bound-parameter', linked);
            host.querySelectorAll<HTMLElement>('input, select, textarea, button, [contenteditable="true"], [tabindex]')
                .forEach(control => {
                    if (control.classList.contains('ghost-binding-toggle')) return;
                    if ('disabled' in control) (control as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled = linked;
                    if (linked) control.setAttribute('aria-disabled', 'true');
                });
        };

        const makeToggle = (fields: string[], label: string) => {
            const linked = fields.every(field => isGhostFieldLinked(this.node, field));
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `ghost-binding-toggle ${linked ? 'is-linked' : 'is-local'}`;
            button.textContent = linked ? '🔗' : '⛓';
            button.title = linked
                ? `${label} is bound to the source. Click to make it standalone.`
                : `${label} is standalone. Click to bind it to the source.`;
            button.setAttribute('aria-label', button.title);
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (linked) fields.forEach(field => unlinkGhostField(this.node, field));
                else fields.forEach(field => relinkGhostField(this.node, field));
                syncGhostTrackData(this.node, (window as any).trackNodes?.get(this.node.id));
                this.node.setDirtyCanvas?.(true, true);
                (window as any).editorCanvas?.setDirty?.(true, true);
                this.refreshAudioPreview();
                void this.renderTabContent();
            });
            return { button, linked };
        };

        container.querySelectorAll<HTMLElement>('.td-param-row').forEach(row => {
            const label = row.querySelector<HTMLElement>('.td-param-label');
            if (!label) return;
            const labelText = label.textContent?.trim().toLowerCase() || '';
            const fields = labelFields[labelText];
            if (!fields) return;
            const { button, linked } = makeToggle(fields, label.textContent?.trim() || fields[0]);
            label.appendChild(button);
            setBoundState(row, linked);
        });

        const toolbarFields: Array<{ label: string; fields: string[]; selector: string }> = [];
        if (this.activeTab === 'CHAIN') {
            toolbarFields.push({ label: 'Processing chain', fields: ['chain'], selector: '.fx-chain-group' });
        } else if (this.activeTab === 'MODULATOR') {
            toolbarFields.push({ label: 'Modulation chain', fields: ['chain'], selector: '.fx-chain-header, .fx-chain-list' });
        } else if (this.activeTab === 'SEQUENCE') {
            toolbarFields.push({ label: 'Step pattern', fields: ['sequence'], selector: '#sequence-grid' });
        } else if (this.activeTab === 'POOL' || this.activeTab === 'FILTER') {
            toolbarFields.push({ label: 'Pool assets', fields: ['selected_items'], selector: '#prop-pool-items' });
        } else if (this.activeTab === 'ARRANGEMENT') {
            toolbarFields.push(
                { label: 'Section cuts', fields: ['section_points'], selector: '.arrangement-visualizer' },
                { label: 'Section probability', fields: ['section_probability'], selector: '#sec-prob-input' },
                { label: 'Section quantize', fields: ['section_quant'], selector: '#prop-sec-quant' },
                { label: 'Section anchor', fields: ['section_quant_anchor'], selector: '#prop-sec-quant-anchor' }
            );
        }

        if (toolbarFields.length) {
            const toolbar = document.createElement('div');
            toolbar.className = 'ghost-binding-toolbar';
            const heading = document.createElement('span');
            heading.className = 'ghost-binding-toolbar-title';
            heading.textContent = 'Bindings';
            toolbar.appendChild(heading);
            for (const config of toolbarFields) {
                const { button, linked } = makeToggle(config.fields, config.label);
                const item = document.createElement('span');
                item.className = `ghost-binding-toolbar-item ${linked ? 'is-linked' : 'is-local'}`;
                item.append(button, document.createTextNode(config.label));
                toolbar.appendChild(item);
                container.querySelectorAll<HTMLElement>(config.selector).forEach(host => setBoundState(host, linked));
            }
            container.prepend(toolbar);
        }
    }

    refreshAudioPreview() {
        // Parameter changes update node state immediately but intentionally do
        // not calculate audio. RAM previews are requested only by preview buttons.
    }

    async render() {
        (this.node as any).ensurePoolSlotsPopulated?.();
        const syncMetadata = (this.node as any).syncMetadataFromLibrary;
        if (typeof syncMetadata === 'function') {
            // Metadata lookup can involve loading the full GAIA library.  Do
            // not hold the inspector hostage to that request: build the shell
            // and controls immediately, then refresh them once it completes
            // only if a displayed metadata field actually changed.
            const snapshotBefore = {
                filepath: this.node.properties?.filepath,
                sample_type: this.node.properties?.sample_type,
                original_bpm: this.node.properties?.original_bpm,
                key: this.node.properties?.key,
            };
            void Promise.resolve()
                .then(() => syncMetadata.call(this.node))
                .then(metadata => {
                    if (!metadata || this.disposed) return;
                    const changed =
                        this.node.properties?.filepath !== snapshotBefore.filepath ||
                        this.node.properties?.sample_type !== snapshotBefore.sample_type ||
                        this.node.properties?.original_bpm !== snapshotBefore.original_bpm ||
                        this.node.properties?.key !== snapshotBefore.key;
                    if (changed) {
                        void this.renderTabContent();
                    }
                })
                .catch(error => console.error('Could not refresh asset metadata from GAIA', error));
        }
        const tabs = this.getTabList();
        if (!tabs.includes(this.activeTab)) {
            this.activeTab = tabs[0];
        }

        const titleText = this.node.properties.node_name || this.node.title || 'Node';

        const isFloating = () => {
            const dv = (window as any).dockview;
            const p = dv?.getGroupPanel(`properties_${this.node.id}`);
            return p?.group?.api?.location?.type === 'floating';
        };
        const dockTitle = isFloating() ? 'Dock to Right Side' : 'Float Window';
        const dockIcon = isFloating() ? '📌' : '↗';
        const isRenderEnabled = this.node.properties?.render_enabled !== false;
        const isFreezeProtected = this.node.properties?.freeze_refresh !== false;
        const isViewerCookEnabled = this.node.properties?.visualization_enabled !== false;

        this.container.innerHTML = `
            <div class="td-param-container">
                <!-- Header -->
                <div class="td-param-header">
                    <div class="header-left">
                        <span class="node-badge">${this.getNodeBadge()}</span>
                        <span class="node-title" id="td-title-display"></span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        ${!(this.node as any).isModifier ? `
                            <button type="button" class="close-btn" id="td-viewer-cook-btn" title="Viewer Cook: ${isViewerCookEnabled ? 'ON (Click to shut Iride)' : 'OFF (Click to enable Iride)'}" style="opacity: ${isViewerCookEnabled ? '1' : '0.45'}; color: ${isViewerCookEnabled ? '#38bdf8' : 'inherit'};">👁</button>
                            <button type="button" class="close-btn" id="td-render-toggle-btn" title="Include in Global Render: ${isRenderEnabled ? 'ON' : 'OFF'}" style="opacity: ${isRenderEnabled ? '1' : '0.45'}; color: ${isRenderEnabled ? '#10b981' : 'inherit'}; font-weight: 700;">R</button>
                            <button type="button" class="close-btn" id="td-freeze-toggle-btn" title="Freeze Protection: ${isFreezeProtected ? 'ON' : 'OFF'}" style="opacity: ${isFreezeProtected ? '1' : '0.45'}; color: ${isFreezeProtected ? '#38bdf8' : 'inherit'};">❄</button>
                            <button type="button" class="random-mode-toggle-btn ${this.isRandomMappingMode ? 'active' : ''}" id="td-random-mode-btn" title="Toggle Live Random Mapping Mode (Locks normal editing, click parameter to map, scroll to edit range)">
                                <span class="random-mode-dot"></span>
                                <span class="random-mode-btn-text">${this.isRandomMappingMode ? 'Mapping Active' : 'Map Mode'}</span>
                            </button>
                        ` : `
                            <button type="button" class="td-param-btn" id="td-parent-node-btn" title="Return to Parent Node" style="padding: 2px 7px; font-size: 10px;">← Node</button>
                            <button type="button" class="close-btn" id="td-delete-mod-btn" title="Remove this Modifier" style="color: #ef4444;">🗑</button>
                        `}
                        <button class="close-btn" id="td-dock-btn" title="${dockTitle}">${dockIcon}</button>
                        <button class="close-btn" id="td-close-btn" title="Close Panel">✕</button>
                    </div>
                </div>

                <!-- Tabs Navigation -->
                <div class="td-param-tabs" id="td-tabs-bar">
                    ${tabs.map(tab => `
                        <div class="td-param-tab ${tab === this.activeTab ? 'active' : ''}" data-tab="${tab}">
                            ${tab}
                        </div>
                    `).join('')}
                </div>

                <!-- Tab Content Body -->
                <div class="td-param-body" id="td-tab-content"></div>
            </div>
        `;

        const paramContainer = this.container.querySelector('.td-param-container') as HTMLElement | null;
        paramContainer?.addEventListener('dragover', (event: DragEvent) => {
            if (!event.defaultPrevented) {
                event.stopPropagation();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'none';
                }
            }
        });

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        this.setupInlineTitleEditor(titleDisplay, titleText);

        this.container.querySelector('#td-viewer-cook-btn')?.addEventListener('click', () => {
            if (typeof (this.node as any).toggleVisualization === 'function') {
                (this.node as any).toggleVisualization();
                void this.render();
            }
        });
        this.container.querySelector('#td-render-toggle-btn')?.addEventListener('click', () => {
            const current = this.node.properties?.render_enabled !== false;
            (this.node as any).updateProperty?.('render_enabled', !current);
            void this.render();
        });
        this.container.querySelector('#td-freeze-toggle-btn')?.addEventListener('click', () => {
            const current = this.node.properties?.freeze_refresh !== false;
            (this.node as any).updateProperty?.('freeze_refresh', !current);
            void this.render();
        });

        const randomModeBtn = this.container.querySelector('#td-random-mode-btn');
        randomModeBtn?.addEventListener('click', () => {
            this.isRandomMappingMode = !this.isRandomMappingMode;
            if (this.isRandomMappingMode && !(this.node as any).isModifier) {
                RandomParamOverlay.getOrCreateRandomModifier(this.node as any);
            }
            void this.render();
        });

        this.container.querySelector('#td-parent-node-btn')?.addEventListener('click', () => {
            const parentId = this.node.properties?.parentId;
            if (parentId != null) {
                window.dispatchEvent(new CustomEvent('open-node-properties', { detail: { nodeId: parentId } }));
            }
        });
        this.container.querySelector('#td-delete-mod-btn')?.addEventListener('click', () => {
            const parentId = this.node.properties?.parentId;
            window.dispatchEvent(new CustomEvent('delete-node', { detail: { nodeId: this.node.id } }));
            if (parentId != null) {
                window.dispatchEvent(new CustomEvent('open-node-properties', { detail: { nodeId: parentId } }));
            } else {
                this.onClose();
            }
        });

        this.container.querySelector('#td-dock-btn')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('toggle-properties-dock', { detail: { nodeId: this.node.id } }));
        });
        this.container.querySelector('#td-close-btn')?.addEventListener('click', this.onClose);

        const tabBtns = this.container.querySelectorAll('.td-param-tab');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const clickedTab = e.currentTarget as HTMLElement;
                const tab = clickedTab.getAttribute('data-tab');
                if (tab && tab !== this.activeTab) {
                    this.activeTab = tab;
                    await this.renderTabContent();
                    tabBtns.forEach(t => t.classList.remove('active'));
                    clickedTab.classList.add('active');
                }
            });
        });

        await this.renderTabContent();
    }

    applyOverlays() {
        const contentContainer = this.container.querySelector('#td-tab-content') as HTMLElement;
        if (!contentContainer || this.disposed) return;
        if (!(this.node as any).isModifier) {
            RandomParamOverlay.updateVisualFeedback(contentContainer, this.node as any, this.isRandomMappingMode);
        }
    }

    async renderTabContent(): Promise<void> {
        if (this.disposed) return;
        if (this.isRenderingTab) {
            this.pendingTabRender = true;
            return this.tabRenderQueue;
        }
        this.isRenderingTab = true;
        this.tabRenderQueue = (async () => {
            try {
                do {
                    this.pendingTabRender = false;
                    if (this.disposed) break;
                    await this.executeRenderTabContent();
                } while (this.pendingTabRender && !this.disposed);
            } finally {
                this.isRenderingTab = false;
            }
        })();
        return this.tabRenderQueue;
    }

    private async executeRenderTabContent() {
        const token = ++this.renderToken;

        this.stopPoolItemPreview();

        if (this.currentWaveformVisualizer) {
            this.currentWaveformVisualizer.destroy();
            this.currentWaveformVisualizer = null;
        }
        if (this.currentArrangementVisualizer) {
            this.currentArrangementVisualizer.destroy();
            this.currentArrangementVisualizer = null;
        }

        const contentContainer = this.container.querySelector('#td-tab-content') as HTMLElement;
        if (!contentContainer) return;

        // Update random mode button state in header if present
        const randomModeBtn = this.container.querySelector('#td-random-mode-btn');
        if (randomModeBtn) {
            randomModeBtn.classList.toggle('active', this.isRandomMappingMode);
            (randomModeBtn as HTMLElement).style.borderColor = this.isRandomMappingMode ? '#ec4899' : '#334155';
            (randomModeBtn as HTMLElement).style.background = this.isRandomMappingMode ? '#db2777' : '#1e293b';
            (randomModeBtn as HTMLElement).style.color = this.isRandomMappingMode ? '#ffffff' : '#f472b6';
            const textSpan = randomModeBtn.querySelector('.random-mode-btn-text');
            if (textSpan) textSpan.textContent = this.isRandomMappingMode ? 'Mapping Active' : 'Map Mode';
        }

        const finish = () => {
            if (token === this.renderToken) {
                this.applyGhostBindingControls(contentContainer);
                if (!(this.node as any).isModifier) {
                    if (this.isRandomMappingMode) {
                        const existingBanner = contentContainer.querySelector('.td-random-mapping-banner');
                        if (!existingBanner) {
                            const banner = document.createElement('div');
                            banner.className = 'td-random-mapping-banner';
                            banner.style.cssText = 'background: rgba(236, 72, 153, 0.15); border: 1px solid #ec4899; color: #f472b6; padding: 6px 10px; font-size: 11px; font-weight: 500; border-radius: 5px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;';
                            banner.innerHTML = `
                                <span><b>Live Parameter Mapping</b> · Click parameter to toggle · Ctrl+Click to adjust range</span>
                                <button type="button" class="exit-random-mode-btn" style="background: #db2777; color: #fff; border: none; padding: 2px 8px; border-radius: 3px; font-size: 9px; font-weight: 700; cursor: pointer;">Done</button>
                            `;
                            banner.querySelector('.exit-random-mode-btn')?.addEventListener('click', () => {
                                this.isRandomMappingMode = false;
                                void this.renderTabContent();
                            });
                            contentContainer.prepend(banner);
                        }
                    }
                    this.applyOverlays();
                }
            }
        };

        if (typeof (this.node as any).getPanelSchema === 'function') {
            const schema = (this.node as any).getPanelSchema();
            const tabConfig = schema.tabs?.find((t: any) => t.id === this.activeTab);
            if (tabConfig && tabConfig.sections) {
                const fragment = document.createDocumentFragment();
                for (const section of tabConfig.sections) {
                    const el = await SectionRendererFactory.renderSection(section, this.node as any, this);
                    if (token !== this.renderToken || this.disposed) return;
                    fragment.appendChild(el);
                }
                contentContainer.replaceChildren(fragment);
                SectionRendererFactory.updateNodeFieldStates(contentContainer, this.node as any);
                finish();
                return;
            }
        }

        SectionRendererFactory.updateNodeFieldStates(contentContainer, this.node as any);
        finish();
    }

    private stopPoolItemPreview() {
        if (this.currentPoolPreviewAudio) {
            this.currentPoolPreviewAudio.pause();
            this.currentPoolPreviewAudio.src = '';
            this.currentPoolPreviewAudio = null;
        }
        if (this.currentPoolPreviewButton) {
            this.currentPoolPreviewButton.textContent = '▶';
            this.currentPoolPreviewButton.classList.remove('is-playing');
            this.currentPoolPreviewButton = null;
        }
    }

    private setupInlineTitleEditor(titleDisplay: HTMLSpanElement, initialTitle: string): void {
        titleDisplay.textContent = initialTitle;
        titleDisplay.contentEditable = 'true';
        titleDisplay.spellcheck = false;
        titleDisplay.setAttribute('role', 'textbox');
        titleDisplay.setAttribute('aria-label', 'Node name');
        titleDisplay.title = 'Click to edit node name';

        let committedTitle = initialTitle;

        titleDisplay.addEventListener('focus', () => {
            committedTitle = titleDisplay.textContent?.trim() || committedTitle;
        });

        titleDisplay.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                titleDisplay.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                titleDisplay.textContent = committedTitle;
                titleDisplay.blur();
            }
        });

        titleDisplay.addEventListener('blur', () => {
            const nextTitle = titleDisplay.textContent?.trim() || committedTitle;
            titleDisplay.textContent = nextTitle;
            if (nextTitle === committedTitle) return;

            const previousTitle = committedTitle;
            const editableNode = this.node as any;
            editableNode.updateProperty?.('node_name', nextTitle);
            void Promise.resolve(editableNode.onPropertyEdited?.('node_name', nextTitle, previousTitle))
                .then(() => {
                    committedTitle = nextTitle;
                    this.refreshAudioPreview();
                })
                .catch((error: unknown) => {
                    editableNode.updateProperty?.('node_name', previousTitle);
                    titleDisplay.textContent = previousTitle;
                    console.error('Could not save node name', error);
                    window.alert(error instanceof Error ? error.message : 'Could not save node name');
                });
        });
    }
}
