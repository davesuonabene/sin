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
        if (this.node.type === "Audio/Sample") return "SAMPLE";
        if (this.node.type === "Audio/Sequence") return "SEQUENCE";
        return "PARAMS";
    }

    private getTabList(): string[] {
        if (this.node.type === "Audio/Track") return ["TRACK", "COMMON"];
        if (this.node.type === "Audio/Sample") return ["SAMPLE", "AUDIO", "COMMON"];
        if (this.node.type === "Audio/Sequence") return ["SEQUENCE", "TIMING", "COMMON"];
        return ["PARAMS", "COMMON"];
    }

    private getNodeBadge(): string {
        if (this.node.type === "Audio/Track") return "TRACK";
        if (this.node.type === "Audio/Sample") return "SMPL";
        if (this.node.type === "Audio/Sequence") return "SEQ";
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
                const isSelected = this.node.properties.filepath === file;
                fileSelect.innerHTML += `<option value="${file}" ${isSelected ? 'selected' : ''}>${file}</option>`;
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
}


