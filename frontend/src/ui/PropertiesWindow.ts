import { LGraphNode } from 'litegraph.js';
import { fetchLibrary } from '../api';
import { FxPopupMenu, type FxItemDef } from './FxPopupMenu';
import { getDefaultFxChain } from '../nodes/BaseNode';
import { ModulatorPopupMenu, type ModulatorItemDef } from './ModulatorPopupMenu';
import { getDefaultModulatorChain } from '../nodes/ModulatorNode';

function linearToDb(g: number): number {
    if (g <= 0.0001) return -36.0;
    return Math.max(-36.0, Math.min(12.0, 20 * Math.log10(g)));
}

function dbToLinear(db: number): number {
    if (db <= -35.9) return 0.0;
    return Math.pow(10, db / 20);
}

function formatDb(db: number): string {
    if (db <= -35.9) return "-inf dB";
    if (Math.abs(db) < 0.05) return "0.0 dB";
    if (db > 0) return `+${db.toFixed(1)} dB`;
    return `${db.toFixed(1)} dB`;
}

function makeInteractiveFloatBox(
    boxEl: HTMLElement,
    initialDb: number,
    onChange: (newDb: number) => void
) {
    let currentDb = initialDb;

    const updateUI = (db: number) => {
        currentDb = Math.max(-36.0, Math.min(12.0, db));
        const labelTextEl = boxEl.querySelector('.float-val-text') as HTMLElement;
        if (labelTextEl) {
            labelTextEl.innerText = formatDb(currentDb);
        }
    };

    let isDragging = false;
    let startX = 0;
    let startDb = 0;

    boxEl.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startDb = currentDb;
        try { boxEl.setPointerCapture(e.pointerId); } catch (_) {}
        boxEl.classList.add('dragging');
        e.preventDefault();
    });

    boxEl.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const deltaDb = dx * 0.15;
        let newDb = Math.round((startDb + deltaDb) * 10) / 10;
        updateUI(newDb);
        onChange(currentDb);
    });

    const stopDrag = (e: PointerEvent) => {
        if (isDragging) {
            isDragging = false;
            boxEl.classList.remove('dragging');
            try { boxEl.releasePointerCapture(e.pointerId); } catch (_) {}
        }
    };

    boxEl.addEventListener('pointerup', stopDrag);
    boxEl.addEventListener('pointercancel', stopDrag);

    boxEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.min = '-36';
        input.max = '12';
        input.value = currentDb.toFixed(1);
        input.className = 'td-float-direct-input';

        const oldHTML = boxEl.innerHTML;
        boxEl.innerHTML = '';
        boxEl.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commitInput = () => {
            if (committed) return;
            committed = true;
            const parsed = parseFloat(input.value);
            if (!isNaN(parsed)) {
                updateUI(parsed);
                onChange(currentDb);
            }
            boxEl.innerHTML = oldHTML;
            const newLabelText = boxEl.querySelector('.float-val-text') as HTMLElement;
            if (newLabelText) newLabelText.innerText = formatDb(currentDb);
        };

        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
                commitInput();
            } else if (evt.key === 'Escape') {
                committed = true;
                boxEl.innerHTML = oldHTML;
            }
        });

        input.addEventListener('blur', commitInput);
    });
}

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
        if (this.node.type === "Audio/Arrangement") return "ARRANGEMENT";
        if (this.node.type === "Audio/Modulator") return "MODULATOR";
        return "PARAMS";
    }

    private getTabList(): string[] {
        if (this.node.type === "Audio/Sample") return ["SAMPLE", "AUDIO", "CHAIN", "COMMON"];
        if (this.node.type === "Audio/Sequence") return ["SEQUENCE", "TIMING", "CHAIN", "COMMON"];
        if (this.node.type === "Audio/SamplePool") return ["POOL", "CHAIN", "COMMON"];
        if (this.node.type === "Audio/Arrangement") return ["ARRANGEMENT", "CHAIN", "COMMON"];
        if (this.node.type === "Audio/Modulator") return ["MODULATOR", "COMMON"];
        return ["TRACK", "CHAIN", "COMMON"];
    }

    private getNodeBadge(): string {
        if (this.node.type === "Audio/Sample") return "SMPL";
        if (this.node.type === "Audio/Sequence") return "SEQ";
        if (this.node.type === "Audio/SamplePool") return "POOL";
        if (this.node.type === "Audio/Arrangement") return "ARR";
        if (this.node.type === "Audio/Modulator") return "MOD";
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

        if (this.activeTab === "CHAIN") {
            this.renderChainTab(contentContainer);
            return;
        }

        if (this.activeTab === "MODULATOR" || this.node.type === "Audio/Modulator") {
            this.renderModulatorTab(contentContainer);
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
        } else if (this.node.type === "Audio/Arrangement") {
            if (this.activeTab === "ARRANGEMENT") {
                this.renderArrangementTab(contentContainer);
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
                this.node.properties.target_bpm = val;
                this.updateTrackNode('bpm', val);
                this.updateTrackNode('target_bpm', val);
                if (typeof (window as any).syncBpmInheritance === 'function') {
                    (window as any).syncBpmInheritance();
                }
            });
        }
    }

    private async renderSampleTab(container: HTMLElement) {
        const trackNodes = (window as any).trackNodes;
        const isConnected = trackNodes?.get(this.node.id)?.parentId != null;
        const keyVal = this.node.properties.key || '';
        const origBpm = this.node.properties.original_bpm || 120;
        const targetBpm = this.node.properties.target_bpm || this.node.properties.bpm || 120;

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
                    <div class="td-param-label">Key</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="prop-key" value="${keyVal}" placeholder="e.g. Cmin, 1A" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Original BPM</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-original-bpm" value="${origBpm}" disabled title="Detected original BPM (read-only)" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Target BPM</div>
                    <div class="td-param-control" style="display: flex; align-items: center; gap: 6px;">
                        <input type="number" class="td-param-input" id="prop-target-bpm" value="${targetBpm}" ${isConnected ? 'disabled title="Inherited from connected parent node"' : ''} />
                        ${isConnected ? '<span style="font-size: 10px; background: #e0f2fe; color: #0284c7; padding: 2px 6px; border-radius: 4px; font-weight: 600; white-space: nowrap;">Inherited</span>' : ''}
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Start Beat</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-start" value="${this.node.properties.start_beat || 0}" />
                    </div>
                </div>
            </div>
        `;

        const fileSelect = container.querySelector('#prop-file') as HTMLSelectElement;
        let loadedFiles: any[] = [];
        
        try {
            loadedFiles = await fetchLibrary();
            fileSelect.disabled = false;
            fileSelect.innerHTML = `<option value="" disabled ${!this.node.properties.filepath ? 'selected' : ''}>Select asset...</option>`;
            
            for (const file of loadedFiles) {
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
            
            const selectedFileObj = loadedFiles.find(f => f.absolute_path === val);
            const newName = val.split(/[/\\]/).pop()?.split('.')[0] || "Sample";
            this.node.properties.node_name = newName;
            this.node.title = newName;

            let metaKey = selectedFileObj?.key;
            let metaBpm = selectedFileObj?.bpm;

            if (metaKey) {
                this.node.properties.key = metaKey;
                this.updateTrackNode('key', metaKey);
                const keyInput = container.querySelector('#prop-key') as HTMLInputElement;
                if (keyInput) keyInput.value = metaKey;
            }

            if (metaBpm) {
                this.node.properties.original_bpm = metaBpm;
                this.updateTrackNode('original_bpm', metaBpm);
                const origInput = container.querySelector('#prop-original-bpm') as HTMLInputElement;
                if (origInput) origInput.value = metaBpm.toString();

                if (!isConnected) {
                    this.node.properties.target_bpm = metaBpm;
                    this.node.properties.bpm = metaBpm;
                    this.updateTrackNode('target_bpm', metaBpm);
                    this.updateTrackNode('bpm', metaBpm);
                    const targetInput = container.querySelector('#prop-target-bpm') as HTMLInputElement;
                    if (targetInput) targetInput.value = metaBpm.toString();
                }
            }

            if (typeof this.node.computeSize === 'function') {
                this.node.size = this.node.computeSize();
            }
            
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('filepath', val);
            this.updateTrackNode('name', newName);

            if (titleDisplay) titleDisplay.innerText = newName;
        });

        const keyInput = container.querySelector('#prop-key') as HTMLInputElement;
        if (keyInput) {
            keyInput.addEventListener('change', (e) => {
                const val = (e.target as HTMLInputElement).value;
                this.node.properties.key = val;
                this.updateTrackNode('key', val);
            });
        }

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

        const targetBpmInput = container.querySelector('#prop-target-bpm') as HTMLInputElement;
        if (targetBpmInput) {
            targetBpmInput.addEventListener('change', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.node.properties.target_bpm = val;
                this.node.properties.bpm = val;
                this.updateTrackNode('target_bpm', val);
                this.updateTrackNode('bpm', val);
            });
        }
    }

    private renderAudioTab(container: HTMLElement) {
        const filePath = this.node.properties.filepath ? '/assets/' + this.node.properties.filepath : '';
        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row" style="margin-bottom: 8px;">
                    <div class="td-param-label">File</div>
                    <div class="td-param-control" style="font-family: monospace; font-size: 10px; color: #0284c7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${this.node.properties.filepath || 'No file selected'}
                    </div>
                </div>
                <audio controls src="${filePath}" class="td-audio-preview"></audio>
            </div>
        `;
    }

    private async renderSequenceTab(container: HTMLElement) {
        if (!this.node.properties.sequence) {
            this.node.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        }
        if (this.node.properties.selected_step === undefined) {
            this.node.properties.selected_step = 0;
        }

        const selectedStepNum = (this.node.properties.selected_step ?? 0) + 1;

        container.innerHTML = `
            <div class="td-param-group">
                <div class="td-param-row" style="margin-bottom: 12px;">
                    <div class="td-param-label">MIDI Pattern</div>
                    <div class="td-param-control">
                        <select class="td-param-select" id="prop-midi-file">
                            <option value="">-- Custom / Manual --</option>
                        </select>
                    </div>
                </div>
                <div class="td-param-row" style="margin-bottom: 8px; justify-content: space-between;">
                    <div style="font-size: 10px; font-weight: 600; color: #475569;">16 Step Sequencer</div>
                    <div style="font-size: 10px; color: #0284c7; font-weight: 600;" id="seq-selected-indicator">
                        Step ${selectedStepNum} Selected
                    </div>
                </div>
                <div class="td-seq-grid" id="sequence-grid"></div>
            </div>
        `;

        const midiSelect = container.querySelector('#prop-midi-file') as HTMLSelectElement;
        if (midiSelect) {
            try {
                const libraryData = await fetchLibrary();
                const midiFiles = (libraryData || []).filter((f: any) => f.type === 'midi' || f.name.endsWith('.mid') || f.name.endsWith('.midi'));
                midiFiles.forEach((f: any) => {
                    const opt = document.createElement('option');
                    opt.value = f.absolute_path;
                    opt.innerText = f.name;
                    if (this.node.properties.filepath === f.absolute_path) {
                        opt.selected = true;
                    }
                    midiSelect.appendChild(opt);
                });
            } catch (e) {
                console.error("Failed to load MIDI library items", e);
            }

            midiSelect.addEventListener('change', async (e) => {
                const filepath = (e.target as HTMLSelectElement).value;
                if (!filepath) return;
                try {
                    const res = await fetch('/api/midi/parse', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filepath })
                    });
                    const data = await res.json();
                    if (data.sequence) {
                        this.node.properties.sequence = data.sequence;
                        this.node.properties.filepath = filepath;
                        if (data.bpm) {
                            this.node.properties.original_bpm = data.bpm;
                            this.updateTrackNode('original_bpm', data.bpm);
                        }
                        this.updateTrackNode('sequence', [...data.sequence]);
                        this.updateTrackNode('filepath', filepath);
                        this.node.setDirtyCanvas(true, true);
                        await this.renderSequenceTab(container);
                    }
                } catch (err) {
                    console.error("Error loading MIDI file", err);
                }
            });
        }

        const gridContainer = container.querySelector('#sequence-grid') as HTMLElement;
        const selectedIndicator = container.querySelector('#seq-selected-indicator') as HTMLElement;
        const seq: number[] = this.node.properties.sequence;
        const stepUpdateFns: Array<() => void> = [];

        const refreshAllSteps = () => {
            stepUpdateFns.forEach(fn => fn());
            if (selectedIndicator) {
                const selIdx = this.node.properties.selected_step ?? 0;
                selectedIndicator.innerText = `Step ${selIdx + 1} Selected`;
            }
        };

        seq.forEach((_, i) => {
            const stepCol = document.createElement('div');
            stepCol.className = 'td-seq-col';

            const dot = document.createElement('span');
            dot.className = 'td-seq-dot';
            dot.title = `Click dot to select step ${i + 1}`;

            const stepBtn = document.createElement('button');
            stepBtn.type = 'button';
            stepBtn.className = 'td-seq-btn';
            stepBtn.title = `Step ${i + 1} (${this.node.properties.sequence[i] === 1 ? 'Active' : 'Disabled'})`;

            stepCol.appendChild(dot);
            stepCol.appendChild(stepBtn);

            const updateStyle = () => {
                const isActive = this.node.properties.sequence[i] === 1;
                if (isActive) {
                    stepBtn.classList.add('active');
                } else {
                    stepBtn.classList.remove('active');
                }
                stepBtn.title = `Step ${i + 1} (${isActive ? 'Active' : 'Disabled'})`;

                const isSelected = this.node.properties.selected_step === i;
                if (isSelected) {
                    dot.classList.add('selected');
                    stepBtn.classList.add('step-selected');
                } else {
                    dot.classList.remove('selected');
                    stepBtn.classList.remove('step-selected');
                }
            };

            stepUpdateFns.push(updateStyle);
            updateStyle();

            // Clicking the dot selects the step
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                this.node.properties.selected_step = i;
                this.updateTrackNode('selected_step', i);
                this.node.setDirtyCanvas(true, true);
                refreshAllSteps();
            });

            // Clicking the step toggles active/disabled state as usual
            stepBtn.addEventListener('click', () => {
                const currentVal = this.node.properties.sequence[i];
                this.node.properties.sequence[i] = currentVal === 1 ? 0 : 1;
                this.updateTrackNode('sequence', [...this.node.properties.sequence]);
                this.node.setDirtyCanvas(true, true);
                refreshAllSteps();
            });

            gridContainer.appendChild(stepCol);
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
                    <div class="td-param-control" id="prop-selected-sample" style="font-size: 11px; color: #0284c7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-top: 4px;">
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

    private renderArrangementTab(container: HTMLElement) {
        if (this.node.properties.total_bars === undefined) {
            this.node.properties.total_bars = 4.0;
            this.node.properties.probability = 1.0;
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
                    <div class="td-param-label">Total Bars</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-total-bars" value="${this.node.properties.total_bars}" step="0.25" />
                    </div>
                </div>

                <div class="td-param-row">
                    <div class="td-param-label">Probability</div>
                    <div class="td-param-control">
                        <input type="number" class="td-param-input" id="prop-prob" value="${this.node.properties.probability}" min="0" max="1" step="0.05" />
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

        const totalBarsInput = container.querySelector('#prop-total-bars') as HTMLInputElement;
        const onTotalBarsChange = (e: Event) => {
            const val = parseFloat((e.target as HTMLInputElement).value) || 4.0;
            this.node.properties.total_bars = val;
            this.updateTrackNode('total_bars', val);
        };
        totalBarsInput.addEventListener('change', onTotalBarsChange);
        totalBarsInput.addEventListener('input', onTotalBarsChange);

        const probInput = container.querySelector('#prop-prob') as HTMLInputElement;
        const onProbChange = (e: Event) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            const clamped = isNaN(val) ? 1.0 : Math.max(0, Math.min(1, val));
            this.node.properties.probability = clamped;
            this.updateTrackNode('probability', clamped);
        };
        probInput.addEventListener('change', onProbChange);
        probInput.addEventListener('input', onProbChange);
    }

    private renderChainTab(container: HTMLElement) {
        if (!this.node.properties.chain || !Array.isArray(this.node.properties.chain) || this.node.properties.chain.length === 0) {
            this.node.properties.chain = getDefaultFxChain();
            this.updateTrackNode('chain', this.node.properties.chain);
        }

        const chain: any[] = this.node.properties.chain;

        container.innerHTML = `
            <div class="td-param-group fx-chain-group">
                <div class="fx-chain-header">
                    <span class="fx-chain-title">Processing Chain</span>
                    <span class="fx-chain-count">${chain.length} Modules</span>
                </div>
                <div class="fx-chain-list" id="fx-chain-list"></div>
            </div>
        `;

        const listContainer = container.querySelector('#fx-chain-list') as HTMLElement;

        const createAddBtn = () => {
            const addWrapper = document.createElement('div');
            addWrapper.className = 'fx-inline-add-container';
            const addBtn = document.createElement('button');
            addBtn.className = 'fx-inline-add-btn';
            addBtn.id = 'fx-add-btn';
            addBtn.innerHTML = `<span style="font-size: 13px; font-weight: bold; margin-right: 4px;">+</span> Add FX Module`;

            addBtn.addEventListener('click', () => {
                const rect = addBtn.getBoundingClientRect();
                const popup = new FxPopupMenu();
                popup.show(rect.left, rect.bottom + 5, (fxDef: FxItemDef) => {
                    const newMod = {
                        id: fxDef.type + "_" + Math.random().toString(36).substring(2, 8),
                        type: fxDef.type,
                        name: fxDef.label,
                        enabled: true,
                        fixed: false,
                        params: { ...fxDef.defaultParams }
                    };
                    if (chain.length > 0 && chain[chain.length - 1].type === "gain" && chain[chain.length - 1].name === "Post Gain") {
                        chain.splice(chain.length - 1, 0, newMod);
                    } else {
                        chain.push(newMod);
                    }
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                    this.renderChainTab(container);
                });
            });

            addWrapper.appendChild(addBtn);
            return addWrapper;
        };

        chain.forEach((module: any, index: number) => {
            // Insert the inline + Add FX button right before the last module (Post Gain)
            if (index === chain.length - 1) {
                listContainer.appendChild(createAddBtn());
            }

            const isPreGain = module.fixed && index === 0;
            const isPostGain = module.fixed && index === chain.length - 1;

            if (isPreGain || isPostGain) {
                const linearGain = module.params?.gain ?? 1.0;
                const dbVal = module.params?.gain_db !== undefined ? module.params.gain_db : linearToDb(linearGain);
                const dbLabel = formatDb(dbVal);

                const card = document.createElement('div');
                card.className = `fx-module-card fixed ${isPreGain ? 'pre-gain' : 'post-gain'}`;

                const box = document.createElement('div');
                box.className = `td-interactive-float-box ${isPreGain ? 'pre-gain' : 'post-gain'}`;
                box.title = `${isPreGain ? 'Pre Gain' : 'Post Gain'} (Drag horizontally to adjust, double-click to type dB)`;

                if (isPreGain) {
                    box.innerHTML = `
                        <span class="float-label">Pre Gain</span>
                        <span class="float-val-text">${dbLabel}</span>
                    `;
                } else {
                    box.innerHTML = `
                        <span class="float-val-text">${dbLabel}</span>
                        <span class="float-label">Post Gain</span>
                    `;
                }

                makeInteractiveFloatBox(box, dbVal, (newDb: number) => {
                    const lin = dbToLinear(newDb);
                    if (!module.params) module.params = {};
                    module.params.gain = lin;
                    module.params.gain_db = newDb;
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                });

                card.appendChild(box);
                listContainer.appendChild(card);
                return;
            }

            const card = document.createElement('div');
            card.className = `fx-module-card ${module.fixed ? 'fixed' : ''} ${!module.enabled ? 'bypassed' : ''}`;

            const canMoveUp = !module.fixed && index > 1 && !chain[index - 1].fixed;
            const canMoveDown = !module.fixed && index < chain.length - 2 && !chain[index + 1].fixed;

            card.innerHTML = `
                <div class="fx-card-header">
                    <div class="fx-card-info">
                        <input type="checkbox" class="fx-enable-checkbox" ${module.enabled ? 'checked' : ''} title="${module.enabled ? 'Enabled' : 'Bypassed'}" />
                        <span class="fx-card-name">${module.name}</span>
                        <span class="fx-card-type-badge">${module.type.toUpperCase()}</span>
                    </div>
                    <div class="fx-card-actions">
                        ${!module.fixed ? `
                            <button class="fx-action-btn fx-move-up" ${!canMoveUp ? 'disabled' : ''} title="Move Up">▲</button>
                            <button class="fx-action-btn fx-move-down" ${!canMoveDown ? 'disabled' : ''} title="Move Down">▼</button>
                            <button class="fx-action-btn fx-delete" title="Delete FX">✕</button>
                        ` : '<span class="fx-fixed-label">ANCHOR</span>'}
                    </div>
                </div>
                <div class="fx-card-params" id="params-${module.id}"></div>
            `;

            const enableCb = card.querySelector('.fx-enable-checkbox') as HTMLInputElement;
            enableCb.addEventListener('change', (e) => {
                module.enabled = (e.target as HTMLInputElement).checked;
                this.updateTrackNode('chain', chain);
                this.node.setDirtyCanvas(true, true);
                if (!module.enabled) {
                    card.classList.add('bypassed');
                } else {
                    card.classList.remove('bypassed');
                }
            });

            if (!module.fixed) {
                const moveUpBtn = card.querySelector('.fx-move-up') as HTMLButtonElement;
                const moveDownBtn = card.querySelector('.fx-move-down') as HTMLButtonElement;
                const deleteBtn = card.querySelector('.fx-delete') as HTMLButtonElement;

                if (moveUpBtn) {
                    moveUpBtn.addEventListener('click', () => {
                        const temp = chain[index];
                        chain[index] = chain[index - 1];
                        chain[index - 1] = temp;
                        this.updateTrackNode('chain', chain);
                        this.node.setDirtyCanvas(true, true);
                        this.renderChainTab(container);
                    });
                }

                if (moveDownBtn) {
                    moveDownBtn.addEventListener('click', () => {
                        const temp = chain[index];
                        chain[index] = chain[index + 1];
                        chain[index + 1] = temp;
                        this.updateTrackNode('chain', chain);
                        this.node.setDirtyCanvas(true, true);
                        this.renderChainTab(container);
                    });
                }

                if (deleteBtn) {
                    deleteBtn.addEventListener('click', () => {
                        chain.splice(index, 1);
                        this.updateTrackNode('chain', chain);
                        this.node.setDirtyCanvas(true, true);
                        this.renderChainTab(container);
                    });
                }
            }

            const paramsContainer = card.querySelector(`#params-${module.id}`) as HTMLElement;
            this.renderFxModuleParams(module, paramsContainer);

            listContainer.appendChild(card);
        });
    }

    private renderFxModuleParams(module: any, container: HTMLElement) {
        const updateParam = (key: string, val: any) => {
            if (!module.params) module.params = {};
            module.params[key] = val;
            this.updateTrackNode('chain', this.node.properties.chain);
            this.node.setDirtyCanvas(true, true);
        };

        if (module.type === "gain") {
            const val = module.params?.gain ?? 1.0;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Gain Level</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="2" step="0.05" value="${val}" class="fx-slider" data-param="gain" />
                        <input type="number" min="0" max="4" step="0.05" value="${val}" class="fx-num" data-param="gain" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "eq") {
            const low = module.params?.low_gain ?? 1.0;
            const mid = module.params?.mid_gain ?? 1.0;
            const high = module.params?.high_gain ?? 1.0;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Low (Bass)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="2" step="0.05" value="${low}" class="fx-slider" data-param="low_gain" />
                        <input type="number" min="0" max="4" step="0.05" value="${low}" class="fx-num" data-param="low_gain" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Mid (Body)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="2" step="0.05" value="${mid}" class="fx-slider" data-param="mid_gain" />
                        <input type="number" min="0" max="4" step="0.05" value="${mid}" class="fx-num" data-param="mid_gain" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>High (Treble)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="2" step="0.05" value="${high}" class="fx-slider" data-param="high_gain" />
                        <input type="number" min="0" max="4" step="0.05" value="${high}" class="fx-num" data-param="high_gain" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "compressor") {
            const thresh = module.params?.threshold ?? -12.0;
            const ratio = module.params?.ratio ?? 4.0;
            const attack = module.params?.attack ?? 10.0;
            const release = module.params?.release ?? 100.0;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Threshold (dB)</label>
                    <div class="fx-param-control">
                        <input type="range" min="-60" max="0" step="1" value="${thresh}" class="fx-slider" data-param="threshold" />
                        <input type="number" min="-60" max="0" step="1" value="${thresh}" class="fx-num" data-param="threshold" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Ratio (:1)</label>
                    <div class="fx-param-control">
                        <input type="range" min="1" max="20" step="0.5" value="${ratio}" class="fx-slider" data-param="ratio" />
                        <input type="number" min="1" max="20" step="0.5" value="${ratio}" class="fx-num" data-param="ratio" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Attack (ms)</label>
                    <div class="fx-param-control">
                        <input type="range" min="1" max="100" step="1" value="${attack}" class="fx-slider" data-param="attack" />
                        <input type="number" min="1" max="200" step="1" value="${attack}" class="fx-num" data-param="attack" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Release (ms)</label>
                    <div class="fx-param-control">
                        <input type="range" min="10" max="1000" step="10" value="${release}" class="fx-slider" data-param="release" />
                        <input type="number" min="10" max="2000" step="10" value="${release}" class="fx-num" data-param="release" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "delay") {
            const dt = module.params?.delay_time ?? 0.25;
            const fb = module.params?.feedback ?? 0.4;
            const mix = module.params?.mix ?? 0.3;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Time (sec)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.05" max="1.0" step="0.05" value="${dt}" class="fx-slider" data-param="delay_time" />
                        <input type="number" min="0.01" max="2.0" step="0.05" value="${dt}" class="fx-num" data-param="delay_time" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Feedback</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="0.9" step="0.05" value="${fb}" class="fx-slider" data-param="feedback" />
                        <input type="number" min="0" max="0.95" step="0.05" value="${fb}" class="fx-num" data-param="feedback" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Dry/Wet Mix</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${mix}" class="fx-slider" data-param="mix" />
                        <input type="number" min="0" max="1" step="0.05" value="${mix}" class="fx-num" data-param="mix" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "reverb") {
            const rs = module.params?.room_size ?? 0.5;
            const mix = module.params?.mix ?? 0.3;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Room Size</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.1" max="0.95" step="0.05" value="${rs}" class="fx-slider" data-param="room_size" />
                        <input type="number" min="0.1" max="0.99" step="0.05" value="${rs}" class="fx-num" data-param="room_size" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Dry/Wet Mix</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${mix}" class="fx-slider" data-param="mix" />
                        <input type="number" min="0" max="1" step="0.05" value="${mix}" class="fx-num" data-param="mix" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "filter") {
            const mode = module.params?.mode ?? "lowpass";
            const cutoff = module.params?.cutoff ?? 1000.0;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Type</label>
                    <div class="fx-param-control">
                        <select class="td-param-select fx-select" data-param="mode">
                            <option value="lowpass" ${mode === 'lowpass' ? 'selected' : ''}>Lowpass</option>
                            <option value="highpass" ${mode === 'highpass' ? 'selected' : ''}>Highpass</option>
                        </select>
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Cutoff (Hz)</label>
                    <div class="fx-param-control">
                        <input type="range" min="20" max="10000" step="50" value="${cutoff}" class="fx-slider" data-param="cutoff" />
                        <input type="number" min="20" max="20000" step="50" value="${cutoff}" class="fx-num" data-param="cutoff" />
                    </div>
                </div>
            `;
            const sel = container.querySelector('.fx-select') as HTMLSelectElement;
            if (sel) {
                sel.addEventListener('change', (e) => {
                    updateParam('mode', (e.target as HTMLSelectElement).value);
                });
            }
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "distortion") {
            const drive = module.params?.drive ?? 3.0;
            const mix = module.params?.mix ?? 0.5;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Drive</label>
                    <div class="fx-param-control">
                        <input type="range" min="1" max="10" step="0.2" value="${drive}" class="fx-slider" data-param="drive" />
                        <input type="number" min="1" max="20" step="0.2" value="${drive}" class="fx-num" data-param="drive" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Mix</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${mix}" class="fx-slider" data-param="mix" />
                        <input type="number" min="0" max="1" step="0.05" value="${mix}" class="fx-num" data-param="mix" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "chorus") {
            const rate = module.params?.rate ?? 1.5;
            const depth = module.params?.depth ?? 0.005;
            const mix = module.params?.mix ?? 0.4;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Rate (Hz)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.1" max="5.0" step="0.1" value="${rate}" class="fx-slider" data-param="rate" />
                        <input type="number" min="0.1" max="10.0" step="0.1" value="${rate}" class="fx-num" data-param="rate" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Depth</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.001" max="0.01" step="0.001" value="${depth}" class="fx-slider" data-param="depth" />
                        <input type="number" min="0.001" max="0.02" step="0.001" value="${depth}" class="fx-num" data-param="depth" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Mix</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${mix}" class="fx-slider" data-param="mix" />
                        <input type="number" min="0" max="1" step="0.05" value="${mix}" class="fx-num" data-param="mix" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        } else if (module.type === "limiter") {
            const thresh = module.params?.threshold ?? -0.1;
            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Threshold (dB)</label>
                    <div class="fx-param-control">
                        <input type="range" min="-6.0" max="0.0" step="0.1" value="${thresh}" class="fx-slider" data-param="threshold" />
                        <input type="number" min="-12.0" max="0.0" step="0.1" value="${thresh}" class="fx-num" data-param="threshold" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        }
    }

    private bindMultiSliderPairs(container: HTMLElement, updateFn: (key: string, val: number) => void) {
        const sliders = container.querySelectorAll('.fx-slider');
        sliders.forEach(sliderEl => {
            const slider = sliderEl as HTMLInputElement;
            const paramName = slider.getAttribute('data-param');
            if (!paramName) return;
            const num = container.querySelector(`.fx-num[data-param="${paramName}"]`) as HTMLInputElement;

            slider.addEventListener('input', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (num) num.value = val.toString();
                updateFn(paramName, val);
            });

            if (num) {
                num.addEventListener('change', (e) => {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    slider.value = val.toString();
                    updateFn(paramName, val);
                });
            }
        });
    }

    private renderModulatorTab(container: HTMLElement) {
        if (!this.node.properties.chain || !Array.isArray(this.node.properties.chain) || this.node.properties.chain.length === 0) {
            this.node.properties.chain = getDefaultModulatorChain();
            this.updateTrackNode('chain', this.node.properties.chain);
        }

        const chain: any[] = this.node.properties.chain;

        container.innerHTML = `
            <div class="td-param-group fx-chain-group">
                <div class="td-param-row" style="margin-bottom: 12px;">
                    <div class="td-param-label">Modulator Name</div>
                    <div class="td-param-control">
                        <input type="text" class="td-param-input" id="mod-name" value="${this.node.properties.node_name || 'Modulator'}" />
                    </div>
                </div>

                <div class="fx-chain-header">
                    <span class="fx-chain-title" style="color: #9333ea;">Modulation Signal Logic</span>
                    <span class="fx-chain-count">${chain.length} Modules</span>
                </div>
                <div class="fx-chain-list" id="mod-chain-list"></div>
            </div>
        `;

        const titleDisplay = this.container.querySelector('#td-title-display') as HTMLSpanElement;
        const nameInput = container.querySelector('#mod-name') as HTMLInputElement;
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

        const listContainer = container.querySelector('#mod-chain-list') as HTMLElement;

        const createAddBtn = () => {
            const addWrapper = document.createElement('div');
            addWrapper.className = 'fx-inline-add-container';
            const addBtn = document.createElement('button');
            addBtn.className = 'fx-inline-add-btn mod-inline-add-btn';
            addBtn.id = 'mod-add-btn';
            addBtn.innerHTML = `<span style="font-size: 13px; font-weight: bold; margin-right: 4px;">+</span> Add Signal Generator / Modifier`;

            addBtn.addEventListener('click', () => {
                const rect = addBtn.getBoundingClientRect();
                const popup = new ModulatorPopupMenu();
                popup.show(rect.left, rect.bottom + 5, (itemDef: ModulatorItemDef) => {
                    const newMod = {
                        id: itemDef.type + "_" + Math.random().toString(36).substring(2, 8),
                        type: itemDef.type,
                        name: itemDef.label,
                        enabled: true,
                        fixed: false,
                        params: { ...itemDef.defaultParams }
                    };
                    chain.push(newMod);
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                    this.renderModulatorTab(container);
                });
            });

            addWrapper.appendChild(addBtn);
            return addWrapper;
        };

        chain.forEach((module: any, index: number) => {
            const card = document.createElement('div');
            card.className = `fx-module-card ${!module.enabled ? 'bypassed' : ''}`;

            const canMoveUp = index > 0;
            const canMoveDown = index < chain.length - 1;

            card.innerHTML = `
                <div class="fx-card-header">
                    <div class="fx-card-info">
                        <input type="checkbox" class="fx-enable-checkbox" ${module.enabled ? 'checked' : ''} title="${module.enabled ? 'Enabled' : 'Bypassed'}" />
                        <span class="fx-card-name">${module.name}</span>
                        <span class="fx-card-type-badge" style="background: #9333ea; color: #ffffff;">${module.type.toUpperCase()}</span>
                    </div>
                    <div class="fx-card-actions">
                        <button class="fx-action-btn fx-move-up" ${!canMoveUp ? 'disabled' : ''} title="Move Up">▲</button>
                        <button class="fx-action-btn fx-move-down" ${!canMoveDown ? 'disabled' : ''} title="Move Down">▼</button>
                        <button class="fx-action-btn fx-delete" title="Delete Module">✕</button>
                    </div>
                </div>
                <div class="fx-card-params" id="mod-params-${module.id}"></div>
            `;

            const enableCb = card.querySelector('.fx-enable-checkbox') as HTMLInputElement;
            enableCb.addEventListener('change', (e) => {
                module.enabled = (e.target as HTMLInputElement).checked;
                card.classList.toggle('bypassed', !module.enabled);
                this.updateTrackNode('chain', chain);
                this.node.setDirtyCanvas(true, true);
            });

            const upBtn = card.querySelector('.fx-move-up') as HTMLButtonElement;
            if (upBtn && canMoveUp) {
                upBtn.addEventListener('click', () => {
                    const temp = chain[index];
                    chain[index] = chain[index - 1];
                    chain[index - 1] = temp;
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                    this.renderModulatorTab(container);
                });
            }

            const downBtn = card.querySelector('.fx-move-down') as HTMLButtonElement;
            if (downBtn && canMoveDown) {
                downBtn.addEventListener('click', () => {
                    const temp = chain[index];
                    chain[index] = chain[index + 1];
                    chain[index + 1] = temp;
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                    this.renderModulatorTab(container);
                });
            }

            const delBtn = card.querySelector('.fx-delete') as HTMLButtonElement;
            if (delBtn) {
                delBtn.addEventListener('click', () => {
                    chain.splice(index, 1);
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                    this.renderModulatorTab(container);
                });
            }

            const paramsContainer = card.querySelector(`#mod-params-${module.id}`) as HTMLElement;
            if (paramsContainer) {
                this.renderModulatorModuleParams(module, paramsContainer, () => {
                    this.updateTrackNode('chain', chain);
                    this.node.setDirtyCanvas(true, true);
                });
            }

            listContainer.appendChild(card);
        });

        listContainer.appendChild(createAddBtn());
    }

    private renderModulatorModuleParams(module: any, container: HTMLElement, onChange: () => void) {
        if (!module.params) module.params = {};

        const updateParam = (key: string, val: any) => {
            module.params[key] = val;
            onChange();
        };

        if (module.type === "lfo") {
            const shape = module.params?.shape || "sine";
            const rate = module.params?.rate ?? 1.0;
            const depth = module.params?.depth ?? 1.0;
            const phase = module.params?.phase ?? 0.0;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Wave Shape</label>
                    <div class="fx-param-control">
                        <select class="td-param-select mod-param-shape">
                            <option value="sine" ${shape === 'sine' ? 'selected' : ''}>Sine</option>
                            <option value="square" ${shape === 'square' ? 'selected' : ''}>Square</option>
                            <option value="saw" ${shape === 'saw' ? 'selected' : ''}>Sawtooth</option>
                            <option value="triangle" ${shape === 'triangle' ? 'selected' : ''}>Triangle</option>
                        </select>
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Rate (Hz)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.1" max="20.0" step="0.1" value="${rate}" class="fx-slider" data-param="rate" />
                        <input type="number" min="0.1" max="50.0" step="0.1" value="${rate}" class="fx-num" data-param="rate" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Depth</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${depth}" class="fx-slider" data-param="depth" />
                        <input type="number" min="0" max="1" step="0.05" value="${depth}" class="fx-num" data-param="depth" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Phase (°)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="360" step="5" value="${phase}" class="fx-slider" data-param="phase" />
                        <input type="number" min="0" max="360" step="5" value="${phase}" class="fx-num" data-param="phase" />
                    </div>
                </div>
            `;

            container.querySelector('.mod-param-shape')?.addEventListener('change', (e) => {
                updateParam("shape", (e.target as HTMLSelectElement).value);
            });
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "envelope") {
            const attack = module.params?.attack ?? 0.01;
            const decay = module.params?.decay ?? 0.2;
            const sustain = module.params?.sustain ?? 0.8;
            const release = module.params?.release ?? 0.5;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Attack (s)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.001" max="2.0" step="0.01" value="${attack}" class="fx-slider" data-param="attack" />
                        <input type="number" min="0.001" max="5.0" step="0.01" value="${attack}" class="fx-num" data-param="attack" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Decay (s)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.01" max="3.0" step="0.01" value="${decay}" class="fx-slider" data-param="decay" />
                        <input type="number" min="0.01" max="5.0" step="0.01" value="${decay}" class="fx-num" data-param="decay" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Sustain</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${sustain}" class="fx-slider" data-param="sustain" />
                        <input type="number" min="0" max="1" step="0.05" value="${sustain}" class="fx-num" data-param="sustain" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Release (s)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.01" max="5.0" step="0.05" value="${release}" class="fx-slider" data-param="release" />
                        <input type="number" min="0.01" max="10.0" step="0.05" value="${release}" class="fx-num" data-param="release" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "trigger") {
            const rate = module.params?.rate ?? 2.0;
            const pulseWidth = module.params?.pulse_width ?? 0.5;
            const thresh = module.params?.threshold ?? 0.5;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Trig Rate (Hz)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.1" max="20.0" step="0.1" value="${rate}" class="fx-slider" data-param="rate" />
                        <input type="number" min="0.1" max="50.0" step="0.1" value="${rate}" class="fx-num" data-param="rate" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Pulse Width</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.05" max="0.95" step="0.05" value="${pulseWidth}" class="fx-slider" data-param="pulse_width" />
                        <input type="number" min="0.05" max="0.95" step="0.05" value="${pulseWidth}" class="fx-num" data-param="pulse_width" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Threshold</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${thresh}" class="fx-slider" data-param="threshold" />
                        <input type="number" min="0" max="1" step="0.05" value="${thresh}" class="fx-num" data-param="threshold" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "noise") {
            const nType = module.params?.type || "white";
            const rate = module.params?.rate ?? 4.0;
            const smooth = module.params?.smooth ?? 0.1;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Noise Mode</label>
                    <div class="fx-param-control">
                        <select class="td-param-select mod-param-noise-type">
                            <option value="white" ${nType === 'white' ? 'selected' : ''}>White Noise</option>
                            <option value="pink" ${nType === 'pink' ? 'selected' : ''}>Pink Noise</option>
                            <option value="sample_and_hold" ${nType === 'sample_and_hold' ? 'selected' : ''}>Sample & Hold</option>
                        </select>
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Rate (Hz)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.1" max="30.0" step="0.1" value="${rate}" class="fx-slider" data-param="rate" />
                        <input type="number" min="0.1" max="50.0" step="0.1" value="${rate}" class="fx-num" data-param="rate" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Smooth</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${smooth}" class="fx-slider" data-param="smooth" />
                        <input type="number" min="0" max="1" step="0.05" value="${smooth}" class="fx-num" data-param="smooth" />
                    </div>
                </div>
            `;

            container.querySelector('.mod-param-noise-type')?.addEventListener('change', (e) => {
                updateParam("type", (e.target as HTMLSelectElement).value);
            });
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "scale") {
            const mult = module.params?.multiplier ?? 1.0;
            const offset = module.params?.offset ?? 0.0;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Multiplier</label>
                    <div class="fx-param-control">
                        <input type="range" min="-3.0" max="3.0" step="0.1" value="${mult}" class="fx-slider" data-param="multiplier" />
                        <input type="number" min="-10.0" max="10.0" step="0.1" value="${mult}" class="fx-num" data-param="multiplier" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Offset</label>
                    <div class="fx-param-control">
                        <input type="range" min="-1.0" max="1.0" step="0.05" value="${offset}" class="fx-slider" data-param="offset" />
                        <input type="number" min="-5.0" max="5.0" step="0.05" value="${offset}" class="fx-num" data-param="offset" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "clamp") {
            const min = module.params?.min ?? 0.0;
            const max = module.params?.max ?? 1.0;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Min Ceiling</label>
                    <div class="fx-param-control">
                        <input type="range" min="-1.0" max="1.0" step="0.05" value="${min}" class="fx-slider" data-param="min" />
                        <input type="number" min="-2.0" max="2.0" step="0.05" value="${min}" class="fx-num" data-param="min" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Max Ceiling</label>
                    <div class="fx-param-control">
                        <input type="range" min="-1.0" max="1.0" step="0.05" value="${max}" class="fx-slider" data-param="max" />
                        <input type="number" min="-2.0" max="2.0" step="0.05" value="${max}" class="fx-num" data-param="max" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "invert") {
            const amount = module.params?.amount ?? 1.0;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Invert Amount</label>
                    <div class="fx-param-control">
                        <input type="range" min="0" max="1" step="0.05" value="${amount}" class="fx-slider" data-param="amount" />
                        <input type="number" min="0" max="1" step="0.05" value="${amount}" class="fx-num" data-param="amount" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);

        } else if (module.type === "smooth") {
            const rise = module.params?.rise ?? 0.05;
            const fall = module.params?.fall ?? 0.05;

            container.innerHTML = `
                <div class="fx-param-row">
                    <label>Rise Time (s)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.001" max="1.0" step="0.01" value="${rise}" class="fx-slider" data-param="rise" />
                        <input type="number" min="0.001" max="5.0" step="0.01" value="${rise}" class="fx-num" data-param="rise" />
                    </div>
                </div>
                <div class="fx-param-row">
                    <label>Fall Time (s)</label>
                    <div class="fx-param-control">
                        <input type="range" min="0.001" max="1.0" step="0.01" value="${fall}" class="fx-slider" data-param="fall" />
                        <input type="number" min="0.001" max="5.0" step="0.01" value="${fall}" class="fx-num" data-param="fall" />
                    </div>
                </div>
            `;
            this.bindMultiSliderPairs(container, updateParam);
        }
    }
}


