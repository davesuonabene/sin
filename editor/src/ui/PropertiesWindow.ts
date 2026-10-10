import { LGraphNode } from 'litegraph.js';
import { WaveformVisualizer } from './WaveformVisualizer';
import { ArrangementVisualizer } from './ArrangementVisualizer';
import { getGhostSource, isGhostFieldLinked, isGhostNode, relinkGhostField, syncGhostTrackData, unlinkGhostField } from '../ghosts';
import { SectionRendererFactory } from './SectionRendererFactory';
import { RandomParamOverlay } from './RandomParamOverlay';
import { advanceRandomSeed, applyRandomModulation } from '../../../ermes/ts/randomResolver.ts';

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
            if ((event as CustomEvent).detail?.nodeId === this.node.id) void this.renderTabContent();
        };
        this.arrangementGraphHandler = () => {
            if (this.node.type === 'Audio/Arrangement' && this.activeTab === 'ARRANGEMENT') {
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

    private isAssetFilterNode(): boolean {
        return this.node.type === "Audio/AssetFilter"
            || this.node.properties?.node_type === "asset_filter"
            || this.node.properties?.output_type === "asset_path";
    }

    private getDefaultTab(): string {
        if (typeof (this.node as any).getDefaultPropertiesTab === 'function') {
            return (this.node as any).getDefaultPropertiesTab();
        }
        if (this.node.type === "Audio/Track") return "TRACK";
        if (this.node.type === "Audio/Sequence") return "SEQUENCE";
        if (this.node.type === "Audio/Arrangement") return "ARRANGEMENT";
        if (this.isAssetFilterNode()) return "FILTER";
        if (this.node.type === "Audio/Modulator") return "MODULATOR";
        if (this.node.type === "Audio/Random") return "RANDOM";
        return "PARAMS";
    }

    private getTabList(): string[] {
        if (typeof (this.node as any).getPropertiesTabs === 'function') {
            return (this.node as any).getPropertiesTabs();
        }
        let tabs: string[];
        if (this.node.type === "Audio/Sample") tabs = ["SAMPLE", "CROP", "AUDIO", "CHAIN", "COMMON"];
        else if (this.node.type === "Audio/Sequence") tabs = ["SEQUENCE", "TIMING", "CHAIN", "COMMON"];
        else if (this.node.type === "Audio/Arrangement") tabs = ["ARRANGEMENT", "CHAIN", "COMMON"];
        else if (this.isAssetFilterNode()) tabs = ["FILTER", "COMMON"];
        else if (this.node.type === "Audio/Modulator") tabs = ["MODULATOR", "COMMON"];
        else if (this.node.type === "Audio/Random") tabs = ["RANDOM", "COMMON"];
        else tabs = ["TRACK", "CHAIN", "COMMON"];
        return tabs;
    }

    private getNodeBadge(): string {
        if (typeof (this.node as any).getNodeBadgeLabel === 'function') {
            return (this.node as any).getNodeBadgeLabel();
        }
        if (this.node.type === "Audio/Sample") return "SMPL";
        if (this.node.type === "Audio/Sequence") return "SEQ";
        if (this.node.type === "Audio/Arrangement") return "ARR";
        if (this.isAssetFilterNode()) return "PATH";
        if (this.node.type === "Audio/Modulator") return "MOD";
        if (this.node.type === "Audio/Random") return "RND";
        return "NODE";
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
            'seed': ['seed'],
            'seed mode': ['seed_mode'],
            'playback': ['playbackMode'],
            'playback mode': ['playbackMode'],
            'refresh': ['refresh_mode'],
            'refresh mode': ['refresh_mode'],
            'offset': ['step_parameters'],
            'velocity': ['step_parameters'],
            'probability': [this.node.type === 'Audio/Arrangement' ? 'section_probability' : 'step_parameters'],
            'sample start': ['section_sample_start'],
            'quantize': ['section_quant'],
            'anchor': ['section_quant_anchor'],
            'roll': ['step_parameters'],
            'subdivisions': ['step_parameters'],
            'node color': ['color'],
            'color presets': ['color'],
            'node icon': ['icon'],
            'pool items': ['selected_items'],
            'matches': ['selected_items']
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
                { label: 'Section sample start', fields: ['section_sample_start'], selector: '#sec-sample-start-input' },
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
        const syncMetadata = (this.node as any).syncMetadataFromLibrary;
        if (typeof syncMetadata === 'function') {
            // Metadata lookup can involve loading the full GAIA library.  Do
            // not hold the inspector hostage to that request: build the shell
            // and controls immediately, then refresh them once it completes.
            void Promise.resolve()
                .then(() => syncMetadata.call(this.node))
                .then(metadata => {
                    if (metadata && !this.disposed) void this.renderTabContent();
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
        const hasAttachedRandomModifier = !(this.node as any).isModifier
            && Boolean(RandomParamOverlay.getAttachedRandomModifier(this.node as any));

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
                            <button type="button" class="random-mode-toggle-btn ${this.isRandomMappingMode ? 'active' : ''}" id="td-random-mode-btn" title="Toggle Live Random Mapping Mode (Locks normal editing, click parameter to map, Ctrl+Click to edit range)" style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px solid ${this.isRandomMappingMode ? '#ec4899' : '#334155'}; background: ${this.isRandomMappingMode ? '#db2777' : '#1e293b'}; color: ${this.isRandomMappingMode ? '#ffffff' : '#f472b6'}; cursor: pointer; transition: all 0.15s ease;">
                                <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${this.isRandomMappingMode ? '#ffffff' : '#ec4899'};"></span>
                                <span class="random-mode-btn-text">${this.isRandomMappingMode ? 'Mapping Active' : 'Map Mode'}</span>
                            </button>
                            ${hasAttachedRandomModifier ? `
                                <button type="button" id="td-random-roll-btn" title="Roll random parameters" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px solid #db2777; background: #4c1d95; color: #fbcfe8; cursor: pointer;">
                                    Roll 🎲
                                </button>
                            ` : ''}
                        ` : ''}
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
                <div class="td-param-body" id="td-tab-content">
                    <div class="td-section-container td-section-loading">Loading controls…</div>
                </div>
            </div>
        `;

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        this.setupInlineTitleEditor(titleDisplay, titleText);

        const randomModeBtn = this.container.querySelector('#td-random-mode-btn');
        randomModeBtn?.addEventListener('click', () => {
            this.isRandomMappingMode = !this.isRandomMappingMode;
            if (this.isRandomMappingMode && !(this.node as any).isModifier) {
                RandomParamOverlay.getOrCreateRandomModifier(this.node as any);
            }
            void this.render();
        });

        this.container.querySelector('#td-random-roll-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            const modifier = RandomParamOverlay.getOrCreateRandomModifier(this.node as any);
            if (!modifier) return;
            advanceRandomSeed(modifier);
            applyRandomModulation(modifier, this.node);
            this.applyOverlays();
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

    private async renderTabContent() {
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
                contentContainer.innerHTML = '';
                for (const section of tabConfig.sections) {
                    // Waveform decoding is the expensive panel path.  Keep the
                    // field controls available and show a compact placeholder
                    // while that one section is prepared in the background.
                    if (section.type === 'waveform_crop') {
                        const placeholder = document.createElement('div');
                        placeholder.className = 'td-section-container td-section-loading';
                        placeholder.textContent = 'Loading waveform…';
                        contentContainer.appendChild(placeholder);
                        void SectionRendererFactory.renderSection(section, this.node as any, this)
                            .then(el => {
                                if (token !== this.renderToken || this.disposed) return;
                                placeholder.replaceWith(el);
                                finish();
                            })
                            .catch(error => {
                                if (token !== this.renderToken || this.disposed) return;
                                placeholder.textContent = 'Could not load waveform.';
                                console.error('Could not render waveform panel', error);
                            });
                        continue;
                    }
                    const el = await SectionRendererFactory.renderSection(section, this.node as any, this);
                    if (token !== this.renderToken || this.disposed) return;
                    contentContainer.appendChild(el);
                }
                finish();
                return;
            }
        }

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
