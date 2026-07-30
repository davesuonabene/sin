import { LGraphNode } from 'litegraph.js';
import { fetchLibrary } from '../api';

export class PropertiesWindow {
    container: HTMLElement;
    node: LGraphNode;
    onClose: () => void;
    activeTab: string;

    constructor(container: HTMLElement, node: LGraphNode, onClose: () => void) {
        this.container = container;
        this.node = node;
        this.onClose = onClose;
        this.activeTab = this.getDefaultTab();
    }

    private getDefaultTab(): string {
        if (this.node.type === "Audio/Track") return "TRACK";
        if (this.node.type === "Audio/Sequence") return "SEQUENCE";
        if (this.node.type === "Audio/SamplePool") return "POOL";
        return "PARAMS";
    }

    private getTabList(): string[] {
        if (this.node.type === "Audio/Sample") return ["SAMPLE", "AUDIO", "COMMON"];
        if (this.node.type === "Audio/Sequence") return ["SEQUENCE", "TIMING", "COMMON"];
        if (this.node.type === "Audio/SamplePool") return ["POOL", "COMMON"];
        return ["PARAMS", "COMMON"];
    }

    private getNodeBadge(): string {
        if (this.node.type === "Audio/Sample") return "SMPL";
        if (this.node.type === "Audio/Sequence") return "SEQ";
        if (this.node.type === "Audio/SamplePool") return "POOL";
        return "NODE";
    }

    private updateTrackNode(prop: string, val: any) {
        const trackNodes = (window as any).trackNodes;
        if (!trackNodes) return;
        const data = trackNodes.get(this.node.id);
        if (data) {
            data[prop] = val;
        }
    }

    async render() {
        const tabs = this.getTabList();
        if (!tabs.includes(this.activeTab)) {
            this.activeTab = tabs[0];
        }

        const titleText = this.node.properties.node_name || this.node.title || 'Node';

        this.container.innerHTML = `
            <div class="td-param-container">
                <!-- Header -->
                <div class="td-param-header">
                    <div class="header-left">
                        <span class="node-badge">${this.getNodeBadge()}</span>
                        <span class="node-title" id="td-title-display">${titleText}</span>
                    </div>
                    <button class="close-btn" id="td-close-btn" title="Close Panel">✕</button>
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
                    <!-- Dynamic Tab Content Rendered Here -->
                </div>
            </div>
        `;

        // Bind Header & Tab Events
        this.container.querySelector('#td-close-btn')?.addEventListener('click', this.onClose);

        const tabBtns = this.container.querySelectorAll('.td-param-tab');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const tab = (e.currentTarget as HTMLElement).getAttribute('data-tab');
                if (tab && tab !== this.activeTab) {
                    this.activeTab = tab;
                    await this.renderTabContent();
                    // Update active tab styles
                    tabBtns.forEach(t => t.classList.remove('active'));
                    (e.currentTarget as HTMLElement).classList.add('active');
                }
            });
        });

        await this.renderTabContent();
    }

    private async renderTabContent() {
        const contentContainer = this.container.querySelector('#td-tab-content') as HTMLElement;
        if (!contentContainer) return;

        if (this.activeTab === "COMMON") {
            this.renderCommonTab(contentContainer);
            return;
        }

        if (this.node.type === "Audio/Track") {
            this.renderTrackTab(contentContainer);
        } else if (this.node.type === "Audio/Sample") {
            if (this.activeTab === "SAMPLE") {
                await this.renderSampleTab(contentContainer);
            } else if (this.activeTab === "AUDIO") {
                this.renderAudioTab(contentContainer);
            }
        } else if (this.node.type === "Audio/Sequence") {
            if (this.activeTab === "SEQUENCE") {
                this.renderSequenceTab(contentContainer);
            } else if (this.activeTab === "TIMING") {
                this.renderSequenceTimingTab(contentContainer);
            }
        } else if (this.node.type === "Audio/SamplePool") {
            if (this.activeTab === "POOL") {
                this.renderPoolTab(contentContainer);
            }
        } else {
            this.renderGenericTab(contentContainer);
        }
    }

    private renderCommonTab(container: HTMLElement) {
        const pos = this.node.pos ? `X: ${Math.round(this.node.pos[0])}, Y: ${Math.round(this.node.pos[1])}` : 'N/A';
        const inputsCount = this.node.inputs ? this.node.inputs.length : 0;
        const outputsCount = this.node.outputs ? this.node.outputs.length : 0;

        container.innerHTML = `
            <table class="td-info-table">
                <tr><td>ID</td><td>#${this.node.id}</td></tr>
                <tr><td>Type</td><td>${this.node.type}</td></tr>
                <tr><td>Position</td><td>${pos}</td></tr>
                <tr><td>Inputs</td><td>${inputsCount} slot(s)</td></tr>
                <tr><td>Outputs</td><td>${outputsCount} slot(s)</td></tr>
            </table>
        `;
    }

    private renderTrackTab(container: HTMLElement) {
        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row">
                    <div class="td-param-label">Name</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="prop-name" value="${this.node.properties.node_name || ''}" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Mix Mode</div>
                    <div class="td-param-control">
                        <select class="td-param-select" id="prop-mix">
                            <option value="sum" ${this.node.properties.mix_mode === 'sum' ? 'selected' : ''}>Sum (Layered)</option>
                            <option value="chained" ${this.node.properties.mix_mode === 'chained' ? 'selected' : ''}>Chained (Seq)</option>
                        </select>
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Engine BPM</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-bpm" value="${this.node.properties.bpm || 120}" />
                    </div>
                </div>
            </div>
        `;

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        const nameInput = container.querySelector('#prop-name') as HTMLInputElement;
        
        nameInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            this.node.properties.node_name = val;
            this.node.title = val;
            if (typeof this.node.computeSize === 'function') {
                this.node.size = this.node.computeSize();
            }
            if (titleDisplay) titleDisplay.innerText = val;
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('name', val);
        });

        const mixSelect = container.querySelector('#prop-mix') as HTMLSelectElement;
        mixSelect.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            this.node.properties.mix_mode = val;
            this.updateTrackNode('mix_mode', val);
        });

        const bpmInput = container.querySelector('#prop-bpm') as HTMLInputElement;
        if (bpmInput) {
            bpmInput.addEventListener('change', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.node.properties.bpm = val;
                this.updateTrackNode('bpm', val);
            });
        }
    }

    private async renderSampleTab(container: HTMLElement) {
        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row">
                    <div class="td-param-label">Asset</div>
                    <div class="td-param-control">
                        <select class="td-param-select" id="prop-file" disabled>
                            <option>Loading assets...</option>
                        </select>
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Start Beat</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-start" value="${this.node.properties.start_beat || 0}" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Original BPM</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-original-bpm" value="${this.node.properties.original_bpm || 120}" />
                    </div>
                </div>
            </div>
        `;

        const fileSelect = container.querySelector('#prop-file') as HTMLSelectElement;
        
        try {
            const files = await fetchLibrary();
            fileSelect.disabled = false;
            fileSelect.innerHTML = `<option value="" disabled ${!this.node.properties.filepath ? 'selected' : ''}>Select asset...</option>`;
            
            for (const file of files) {
                const isSelected = this.node.properties.filepath === file.absolute_path;
                fileSelect.innerHTML += `<option value="${file.absolute_path}" ${isSelected ? 'selected' : ''}>${file.name}</option>`;
            }
        } catch (err) {
            fileSelect.innerHTML = `<option>Error loading assets</option>`;
        }

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;

        fileSelect.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            this.node.properties.filepath = val;
            
            const newName = val.split('.')[0];
            this.node.properties.node_name = newName;
            this.node.title = newName;
            if (typeof this.node.computeSize === 'function') {
                this.node.size = this.node.computeSize();
            }
            
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('filepath', val);
            this.updateTrackNode('name', newName);

            if (titleDisplay) titleDisplay.innerText = newName;
        });

        const startInput = container.querySelector('#prop-start') as HTMLInputElement;
        startInput.addEventListener('change', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            this.node.properties.start_beat = val;
            this.updateTrackNode('start_beat', val);
        });

        const originalBpmInput = container.querySelector('#prop-original-bpm') as HTMLInputElement;
        if (originalBpmInput) {
            originalBpmInput.addEventListener('change', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.node.properties.original_bpm = val;
                this.updateTrackNode('original_bpm', val);
            });
        }
    }

    private renderAudioTab(container: HTMLElement) {
        const filePath = this.node.properties.filepath ? '/assets/' + this.node.properties.filepath : '';
        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row" style="margin-bottom: 8px;">
                    <div class="td-param-label">File</div>
                    <div class="td-param-control" style="font-family: monospace; font-size: 10px; color: #38bdf8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${this.node.properties.filepath || 'No file selected'}
                    </div>
                </div>
                <audio controls src="${filePath}" class="td-audio-preview"></audio>
            </div>
        `;
    }

    private renderSequenceTab(container: HTMLElement) {
        if (!this.node.properties.sequence) {
            this.node.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        }

        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-seq-grid" id="sequence-grid"></div>
            </div>
        `;

        const gridContainer = container.querySelector('#sequence-grid') as HTMLElement;
        const seq: number[] = this.node.properties.sequence;

        seq.forEach((_, i) => {
            const stepBtn = document.createElement('button');
            stepBtn.type = 'button';
            stepBtn.innerText = `${i + 1}`;
            stepBtn.className = 'td-seq-btn';

            const updateStyle = () => {
                const isActive = this.node.properties.sequence[i] === 1;
                if (isActive) {
                    stepBtn.classList.add('active');
                } else {
                    stepBtn.classList.remove('active');
                }
            };

            updateStyle();

            stepBtn.addEventListener('click', () => {
                const currentVal = this.node.properties.sequence[i];
                this.node.properties.sequence[i] = currentVal === 1 ? 0 : 1;
                updateStyle();
                this.updateTrackNode('sequence', [...this.node.properties.sequence]);
                this.node.setDirtyCanvas(true, true);
            });

            gridContainer.appendChild(stepBtn);
        });
    }

    private renderSequenceTimingTab(container: HTMLElement) {
        if (this.node.properties.step_length === undefined) {
            this.node.properties.step_length = 0.25;
        }

        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row">
                    <div class="td-param-label">Name</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="prop-name" value="${this.node.properties.node_name || ''}" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Step Length</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-step-length" step="0.0625" value="${this.node.properties.step_length || 0.25}" />
                    </div>
                </div>
            </div>
        `;

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        const nameInput = container.querySelector('#prop-name') as HTMLInputElement;
        nameInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            this.node.properties.node_name = val;
            this.node.title = val;
            if (typeof this.node.computeSize === 'function') {
                this.node.size = this.node.computeSize();
            }
            if (titleDisplay) titleDisplay.innerText = val;
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('name', val);
        });

        const stepLengthInput = container.querySelector('#prop-step-length') as HTMLInputElement;
        stepLengthInput.addEventListener('change', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            this.node.properties.step_length = val;
            this.updateTrackNode('step_length', val);
        });
    }

    private renderGenericTab(container: HTMLElement) {
        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row">
                    <div class="td-param-label">Name</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="prop-name" value="${this.node.properties.node_name || this.node.title || ''}" />
                    </div>
                </div>
            </div>
        `;

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        const nameInput = container.querySelector('#prop-name') as HTMLInputElement;
        nameInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            this.node.properties.node_name = val;
            this.node.title = val;
            if (typeof this.node.computeSize === 'function') {
                this.node.size = this.node.computeSize();
            }
            if (titleDisplay) titleDisplay.innerText = val;
            this.node.setDirtyCanvas(true, true);
        });
    }

    private renderPoolTab(container: HTMLElement) {
        if (!this.node.properties.filters) {
            this.node.properties.filters = { tags: "", bpm_min: null, bpm_max: null, type: "" };
        }
        
        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row">
                    <div class="td-param-label">Name</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="prop-name" value="${this.node.properties.node_name || ''}" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Mode</div>
                    <div class="td-param-control">
                        <select class="td-param-select" id="prop-mode">
                            <option value="Random" ${this.node.properties.playbackMode === 'Random' ? 'selected' : ''}>Random</option>
                            <option value="RoundRobin" ${this.node.properties.playbackMode === 'RoundRobin' ? 'selected' : ''}>RoundRobin</option>
                            <option value="Weighted" ${this.node.properties.playbackMode === 'Weighted' ? 'selected' : ''}>Weighted</option>
                        </select>
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Refresh Mode</div>
                    <div class="td-param-control" style="display: flex; gap: 8px; align-items: center;">
                        <select class="td-param-select" id="prop-refresh-mode">
                            <option value="parent_render" ${this.node.properties.refresh_mode === 'parent_render' ? 'selected' : ''}>Parent Render</option>
                            <option value="self_render" ${this.node.properties.refresh_mode === 'self_render' ? 'selected' : ''}>Self Render</option>
                            <option value="manual" ${this.node.properties.refresh_mode === 'manual' ? 'selected' : ''}>Manual</option>
                        </select>
                        <button class="td-param-button" id="prop-inline-refresh" style="padding: 4px 8px; background: #8b5cf6; border: none; color: white; border-radius: 4px; cursor: pointer; font-size: 11px;">
                            Refresh
                        </button>
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Tags</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="prop-tags" value="${this.node.properties.filters.tags || ''}" placeholder="kick, punch" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">BPM Min</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-bpm-min" value="${this.node.properties.filters.bpm_min || ''}" placeholder="Any" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">BPM Max</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-bpm-max" value="${this.node.properties.filters.bpm_max || ''}" placeholder="Any" />
                    </div>
                </div>

                <div class="td-param-row" style="margin-top: 8px;">
                    <div class="td-param-label">Selected Loop</div>
                    <div class="td-param-control" id="prop-selected-sample" style="font-size: 11px; color: #38bdf8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-top: 4px;">
                        Resolving...
                    </div>
                </div>

                <div class="td-param-row" style="margin-top: 16px;">
                    <button class="td-param-button" id="prop-retrigger" style="width: 100%; padding: 8px; background: #8b5cf6; border: none; color: white; border-radius: 4px; cursor: pointer; font-weight: bold;">
                        🎲 Retrigger Sample
                    </button>
                </div>
            </div>
        `;

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        const nameInput = container.querySelector('#prop-name') as HTMLInputElement;
        
        nameInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            this.node.properties.node_name = val;
            this.node.title = val;
            if (typeof this.node.computeSize === 'function') {
                this.node.size = this.node.computeSize();
            }
            if (titleDisplay) titleDisplay.innerText = val;
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('name', val);
        });

        const modeSelect = container.querySelector('#prop-mode') as HTMLSelectElement;
        modeSelect.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            this.node.properties.playbackMode = val;
            this.updateTrackNode('playbackMode', val);
            this.updateResolvedSample(container);
        });

        const refreshModeSelect = container.querySelector('#prop-refresh-mode') as HTMLSelectElement;
        refreshModeSelect.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            this.node.properties.refresh_mode = val;
            this.updateTrackNode('refresh_mode', val);
        });

        const inlineRefreshBtn = container.querySelector('#prop-inline-refresh') as HTMLButtonElement;
        inlineRefreshBtn.addEventListener('click', () => {
            this.node.properties.seed = Math.random();
            this.updateTrackNode('seed', this.node.properties.seed);
            if ((window as any).editorCanvas) {
                (window as any).editorCanvas.setDirty(true, true);
            }
            this.updateResolvedSample(container);
        });

        const tagsInput = container.querySelector('#prop-tags') as HTMLInputElement;
        tagsInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            if (!this.node.properties.filters) this.node.properties.filters = {};
            this.node.properties.filters.tags = val;
            this.updateTrackNode('filters', this.node.properties.filters);
            this.updateResolvedSample(container);
        });

        const bpmMinInput = container.querySelector('#prop-bpm-min') as HTMLInputElement;
        bpmMinInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            if (!this.node.properties.filters) this.node.properties.filters = {};
            this.node.properties.filters.bpm_min = val ? parseFloat(val) : null;
            this.updateTrackNode('filters', this.node.properties.filters);
            this.updateResolvedSample(container);
        });

        const bpmMaxInput = container.querySelector('#prop-bpm-max') as HTMLInputElement;
        bpmMaxInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            if (!this.node.properties.filters) this.node.properties.filters = {};
            this.node.properties.filters.bpm_max = val ? parseFloat(val) : null;
            this.updateTrackNode('filters', this.node.properties.filters);
            this.updateResolvedSample(container);
        });

        const retriggerBtn = container.querySelector('#prop-retrigger') as HTMLButtonElement;
        retriggerBtn.addEventListener('click', () => {
            this.node.properties.seed = Math.random();
            this.updateTrackNode('seed', this.node.properties.seed);
            if ((window as any).editorCanvas) {
                (window as any).editorCanvas.setDirty(true, true);
            }
            this.updateResolvedSample(container);
        });

        this.updateResolvedSample(container);
    }

    private async updateResolvedSample(container: HTMLElement) {
        const selectedEl = container.querySelector('#prop-selected-sample') as HTMLDivElement;
        if (!selectedEl) return;
        selectedEl.innerText = "Resolving...";
        
        try {
            const res = await fetch('/api/pool/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filters: this.node.properties.filters || {},
                    seed: this.node.properties.seed || 0,
                    playbackMode: this.node.properties.playbackMode || "Random"
                })
            });
            const data = await res.json();
            if (data.sample) {
                const parts = data.sample.split(/[/\\]/);
                selectedEl.innerText = parts[parts.length - 1];
                selectedEl.title = data.sample;
            } else {
                selectedEl.innerText = "No match found";
                selectedEl.title = "";
            }
        } catch (e) {
            selectedEl.innerText = "Error resolving";
        }
    }
}


