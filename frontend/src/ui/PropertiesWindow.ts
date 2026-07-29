import { LGraphNode } from 'litegraph.js';
import { fetchLibrary } from '../api';

export class PropertiesWindow {
    container: HTMLElement;
    node: LGraphNode;
    onClose: () => void;

    constructor(container: HTMLElement, node: LGraphNode, onClose: () => void) {
        this.container = container;
        this.node = node;
        this.onClose = onClose;
    }

    async render() {
        if (this.node.type === "Audio/Track") {
            this.renderTrackForm();
        } else if (this.node.type === "Audio/Sample") {
            await this.renderSampleForm();
        } else if (this.node.type === "Audio/Sequence") {
            this.renderSequenceForm();
        } else {
            this.container.innerHTML = `
                <div style="padding:15px; color:red; background-color: #fef08a; height: 100%;">
                    <div style="margin-bottom:10px;">Unknown node type: ${this.node.type}</div>
                    <button id="err-close" style="padding:5px 10px; cursor:pointer;">Close</button>
                </div>
            `;
            this.container.querySelector('#err-close')?.addEventListener('click', this.onClose);
        }
    }

    private getHeaderHTML(title: string): string {
        return `
            <button id="close-btn" style="position: absolute; top: 12px; left: 12px; width: 28px; height: 28px; border-radius: 50%; background: #1f0d01; color: #e0f2fe; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; z-index: 10;">X</button>
            <h3 style="margin-top: 0; display: flex; justify-content: center; align-items: center; border-bottom: 1px solid #bae6fd; padding-bottom: 10px; padding-top: 4px;">
                <span id="title-display" style="font-size: 16px;">${title}</span>
            </h3>
        `;
    }

    private bindCloseEvent() {
        const closeBtn = this.container.querySelector('#close-btn') as HTMLButtonElement;
        if (closeBtn) closeBtn.addEventListener('click', this.onClose);
    }

    private updateTrackNode(prop: string, val: any) {
        const trackNodes = (window as any).trackNodes;
        if (!trackNodes) return;
        const data = trackNodes.get(this.node.id);
        if (data) {
            data[prop] = val;
        }
    }

    renderTrackForm() {
        this.container.innerHTML = `
            <div style="padding: 15px; font-family: sans-serif; color: #333; background: #e0f2fe; height: 100%; box-sizing: border-box; position: relative;">
                ${this.getHeaderHTML(this.node.properties.node_name || 'Track Properties')}
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Track Name</label>
                    <input type="text" id="prop-name" value="${this.node.properties.node_name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Mix Mode</label>
                    <select id="prop-mix" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                        <option value="sum" ${this.node.properties.mix_mode === 'sum' ? 'selected' : ''}>Sum (Layered)</option>
                        <option value="chained" ${this.node.properties.mix_mode === 'chained' ? 'selected' : ''}>Chained (Sequential)</option>
                    </select>
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Engine BPM</label>
                    <input type="number" id="prop-bpm" value="${this.node.properties.bpm || 120}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
                </div>
            </div>
        `;
        
        this.bindCloseEvent();

        const titleDisplay = this.container.querySelector('#title-display') as HTMLSpanElement;
        const nameInput = this.container.querySelector('#prop-name') as HTMLInputElement;
        
        nameInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            this.node.properties.node_name = val;
            this.node.title = val;
            titleDisplay.innerText = val;
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('name', val);
        });

        const mixSelect = this.container.querySelector('#prop-mix') as HTMLSelectElement;
        mixSelect.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            this.node.properties.mix_mode = val;
            this.updateTrackNode('mix_mode', val);
        });

        const bpmInput = this.container.querySelector('#prop-bpm') as HTMLInputElement;
        if (bpmInput) {
            bpmInput.addEventListener('change', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.node.properties.bpm = val;
                this.updateTrackNode('bpm', val);
            });
        }
    }

    async renderSampleForm() {
        // Show loading state initially
        this.container.innerHTML = `
            <div style="padding: 15px; font-family: sans-serif; color: #333; background: #e0f2fe; height: 100%; box-sizing: border-box; position: relative;">
                ${this.getHeaderHTML(this.node.properties.node_name || 'Sample Properties')}
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Load Sample</label>
                    <select id="prop-file" disabled style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                        <option>Loading samples...</option>
                    </select>
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Start Beat</label>
                    <input type="number" id="prop-start" value="${this.node.properties.start_beat || 0}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Detected BPM</label>
                    <input type="number" id="prop-original-bpm" value="${this.node.properties.original_bpm || 120}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
                </div>

                <div style="margin-top: 25px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 8px;">Preview</label>
                    <audio id="audio-preview" controls src="${this.node.properties.filepath ? '/assets/' + this.node.properties.filepath : ''}" style="width: 100%;"></audio>
                </div>
            </div>
        `;

        this.bindCloseEvent();

        const fileSelect = this.container.querySelector('#prop-file') as HTMLSelectElement;
        
        // Fetch library dynamically
        const files = await fetchLibrary();
        
        // Populate dropdown
        fileSelect.disabled = false;
        fileSelect.innerHTML = `<option value="" disabled ${!this.node.properties.filepath ? 'selected' : ''}>Select an asset...</option>`;
        
        for (const file of files) {
            const isSelected = this.node.properties.filepath === file;
            fileSelect.innerHTML += `<option value="${file}" ${isSelected ? 'selected' : ''}>${file}</option>`;
        }

        const audioPreview = this.container.querySelector('#audio-preview') as HTMLAudioElement;

        fileSelect.addEventListener('change', (e) => {
            const val = (e.target as HTMLSelectElement).value;
            this.node.properties.filepath = val;
            
            // Derive name from filename for simplicity
            const newName = val.split('.')[0];
            this.node.properties.node_name = newName;
            this.node.title = newName;
            
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('filepath', val);
            this.updateTrackNode('name', newName);

            // Update title and audio src
            const titleDisplay = this.container.querySelector('#title-display') as HTMLSpanElement;
            titleDisplay.innerText = newName;
            audioPreview.src = '/assets/' + val;
        });

        const startInput = this.container.querySelector('#prop-start') as HTMLInputElement;
        startInput.addEventListener('change', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            this.node.properties.start_beat = val;
            this.updateTrackNode('start_beat', val);
        });

        const originalBpmInput = this.container.querySelector('#prop-original-bpm') as HTMLInputElement;
        if (originalBpmInput) {
            originalBpmInput.addEventListener('change', (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                this.node.properties.original_bpm = val;
                this.updateTrackNode('original_bpm', val);
            });
        }
    }

    renderSequenceForm() {
        if (!this.node.properties.sequence) {
            this.node.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        }
        if (this.node.properties.step_length === undefined) {
            this.node.properties.step_length = 0.25;
        }

        this.container.innerHTML = `
            <div style="padding: 15px; font-family: sans-serif; color: #333; background: #e0f2fe; height: 100%; box-sizing: border-box; position: relative; overflow-y: auto;">
                ${this.getHeaderHTML(this.node.properties.node_name || 'Sequence Properties')}
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Sequence Name</label>
                    <input type="text" id="prop-name" value="${this.node.properties.node_name || ''}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">Step Length (beats)</label>
                    <input type="number" id="prop-step-length" step="0.0625" value="${this.node.properties.step_length || 0.25}" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;" />
                </div>

                <div style="margin-top: 15px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 8px; font-weight: bold;">Step Sequencer (16 Steps)</label>
                    <div id="sequence-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;"></div>
                </div>
            </div>
        `;

        this.bindCloseEvent();

        const titleDisplay = this.container.querySelector('#title-display') as HTMLSpanElement;
        const nameInput = this.container.querySelector('#prop-name') as HTMLInputElement;
        nameInput.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            this.node.properties.node_name = val;
            this.node.title = val;
            if (titleDisplay) titleDisplay.innerText = val;
            this.node.setDirtyCanvas(true, true);
            this.updateTrackNode('name', val);
        });

        const stepLengthInput = this.container.querySelector('#prop-step-length') as HTMLInputElement;
        stepLengthInput.addEventListener('change', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            this.node.properties.step_length = val;
            this.updateTrackNode('step_length', val);
        });

        const gridContainer = this.container.querySelector('#sequence-grid') as HTMLElement;
        const seq: number[] = this.node.properties.sequence;

        const activeColor = "#ec4899"; // Bright pink / primary accent
        const inactiveColor = "#94a3b8"; // Muted surface color

        seq.forEach((_, i) => {
            const stepBtn = document.createElement('button');
            stepBtn.type = 'button';
            stepBtn.innerText = `${i + 1}`;
            stepBtn.style.height = '42px';
            stepBtn.style.border = 'none';
            stepBtn.style.borderRadius = '6px';
            stepBtn.style.fontWeight = 'bold';
            stepBtn.style.fontSize = '14px';
            stepBtn.style.cursor = 'pointer';
            stepBtn.style.transition = 'all 0.15s ease';

            const updateStyle = () => {
                const isActive = this.node.properties.sequence[i] === 1;
                stepBtn.style.backgroundColor = isActive ? activeColor : inactiveColor;
                stepBtn.style.color = isActive ? '#ffffff' : '#f8fafc';
                stepBtn.style.boxShadow = isActive ? '0 2px 4px rgba(236, 72, 153, 0.4)' : 'none';
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
}

