import { registerParameterWheelControl } from './ParameterWheelMenu';

export class TrackPropertiesWindow {
    container: HTMLElement;
    onClose: () => void;
    private disposed: boolean = false;
    private onGlobalParamsChanged: (e: Event) => void;

    constructor(container: HTMLElement, onClose: () => void) {
        this.container = container;
        this.onClose = onClose;

        this.onGlobalParamsChanged = () => {
            if (!this.disposed) {
                this.updateFieldsFromGlobal();
            }
        };

        window.addEventListener('global-parameters-changed', this.onGlobalParamsChanged);
        this.render();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        window.removeEventListener('global-parameters-changed', this.onGlobalParamsChanged);
    }

    private getBpm(): number {
        const getGlobal = (window as any).getGlobalParameter;
        const val = getGlobal ? getGlobal('bpm') : 120;
        return Number.isFinite(val) ? val : 120;
    }

    private getTotalBars(): number {
        const getGlobal = (window as any).getGlobalParameter;
        const val = getGlobal ? getGlobal('total_bars') : 4;
        return Number.isFinite(val) ? val : 4;
    }

    private getKey(): string {
        const getGlobal = (window as any).getGlobalParameter;
        const val = getGlobal ? getGlobal('key') : 'C';
        return val || 'C';
    }

    private setGlobal(params: { bpm?: number; total_bars?: number; key?: string }) {
        const setParams = (window as any).setGlobalParameters;
        if (setParams) {
            setParams(params);
        }
    }

    private computeDuration(): { seconds: number; formatted: string; beats: number } {
        const bpm = this.getBpm();
        const bars = this.getTotalBars();
        const beats = bars * 4;
        const seconds = (beats * 60) / Math.max(20, bpm);
        const mins = Math.floor(seconds / 60);
        const remSecs = (seconds % 60).toFixed(1);
        const formatted = `${String(mins).padStart(2, '0')}:${remSecs.padStart(4, '0')}`;
        return { seconds, formatted, beats };
    }

    private getGraphStats(): { nodesCount: number; sampleCount: number; seqCount: number; trackCount: number } {
        const graph = (window as any).editorGraph;
        const nodes = (graph?._nodes || []) as any[];
        let sampleCount = 0;
        let seqCount = 0;
        let trackCount = 0;

        for (const n of nodes) {
            if (n.type === 'Audio/Sample') sampleCount++;
            else if (n.type === 'Audio/Sequence') seqCount++;
            else if (n.type === 'Audio/Track') trackCount++;
        }

        return {
            nodesCount: nodes.length,
            sampleCount,
            seqCount,
            trackCount
        };
    }

    private render() {
        const bpm = this.getBpm();
        const totalBars = this.getTotalBars();
        const key = this.getKey();
        const duration = this.computeDuration();
        const stats = this.getGraphStats();

        const rootKeys = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

        this.container.innerHTML = `
            <div class="td-param-container td-track-param-container">
                <!-- Header -->
                <div class="td-param-header">
                    <div class="header-left">
                        <span class="node-badge" style="background: #4f46e5; color: #ffffff;">TRACK</span>
                        <span class="node-title">Track Parameters</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <button class="close-btn" id="track-close-btn" title="Close Panel">✕</button>
                    </div>
                </div>

                <!-- Body -->
                <div class="td-param-body td-track-param-body">
                    <!-- Timing & Tempo Section -->
                    <div class="td-section">
                        <div class="td-section-title">TEMPO & LENGTH</div>
                        <div class="td-track-fields-grid">
                            <!-- BPM -->
                            <div class="td-field-row">
                                <label class="td-field-label">Tempo (BPM)</label>
                                <div class="td-number-stepper">
                                    <button type="button" class="td-stepper-btn" id="bpm-dec-btn" title="Decrease BPM">-</button>
                                    <input type="number" id="track-bpm-input" class="td-track-input" min="20" max="300" step="1" value="${bpm}">
                                    <button type="button" class="td-stepper-btn" id="bpm-inc-btn" title="Increase BPM">+</button>
                                </div>
                            </div>

                            <!-- Total Bars -->
                            <div class="td-field-row">
                                <label class="td-field-label">Length (Bars)</label>
                                <div class="td-number-stepper">
                                    <button type="button" class="td-stepper-btn" id="bars-dec-btn" title="Decrease Bars">-</button>
                                    <input type="number" id="track-bars-input" class="td-track-input" min="0.25" max="128" step="0.25" value="${totalBars}">
                                    <button type="button" class="td-stepper-btn" id="bars-inc-btn" title="Increase Bars">+</button>
                                </div>
                            </div>
                        </div>

                        <!-- Quick Bar Presets -->
                        <div class="td-quick-presets-row">
                            <span class="td-presets-label">Bar Presets:</span>
                            <div class="td-preset-chips">
                                ${[1, 2, 4, 8, 16, 32].map(b => `
                                    <button type="button" class="td-preset-chip ${totalBars === b ? 'active' : ''}" data-bars="${b}">${b}</button>
                                `).join('')}
                            </div>
                        </div>

                        <!-- Computed Duration Badge -->
                        <div class="td-duration-badge" id="track-duration-display">
                            <span class="td-duration-icon">⏱</span>
                            <span class="td-duration-text">${duration.seconds.toFixed(2)}s (${duration.formatted}) · ${duration.beats} beats @ 4/4</span>
                        </div>
                    </div>

                    <!-- Musical Key Section -->
                    <div class="td-section">
                        <div class="td-section-title">MUSICAL KEY & SCALE</div>
                        <div class="td-field-row">
                            <label class="td-field-label">Current Key</label>
                            <input type="text" id="track-key-input" class="td-track-input td-key-input" value="${key}" maxlength="8" spellcheck="false" placeholder="e.g. C, Am, F#m">
                        </div>

                        <!-- Quick Root Key Chips -->
                        <div class="td-root-keys-grid">
                            ${rootKeys.map(k => `
                                <button type="button" class="td-key-chip ${key.startsWith(k) ? 'active' : ''}" data-root="${k}">${k}</button>
                            `).join('')}
                        </div>
                        <div class="td-mode-chips-row">
                            <button type="button" class="td-mode-chip ${!key.includes('m') ? 'active' : ''}" data-mode="maj">Major</button>
                            <button type="button" class="td-mode-chip ${key.includes('m') ? 'active' : ''}" data-mode="min">Minor</button>
                        </div>
                    </div>

                    <!-- Composition Overview Section -->
                    <div class="td-section">
                        <div class="td-section-title">GRAPH OVERVIEW</div>
                        <div class="td-stats-grid">
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-nodes">${stats.nodesCount}</span>
                                <span class="td-stat-label">Total Nodes</span>
                            </div>
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-samples">${stats.sampleCount}</span>
                                <span class="td-stat-label">Samples</span>
                            </div>
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-seqs">${stats.seqCount}</span>
                                <span class="td-stat-label">Sequences</span>
                            </div>
                            <div class="td-stat-card">
                                <span class="td-stat-val" id="stat-tracks">${stats.trackCount}</span>
                                <span class="td-stat-label">Tracks</span>
                            </div>
                        </div>
                    </div>

                    <!-- Quick Actions Section -->
                    <div class="td-section td-actions-section">
                        <button type="button" class="td-track-action-btn primary" id="track-refresh-pools-btn">
                            ↻ Recalculate All Pools
                        </button>
                        <button type="button" class="td-track-action-btn secondary" id="track-reset-defaults-btn">
                            Reset to Defaults (120 BPM, 4 Bars, C)
                        </button>
                    </div>
                </div>
            </div>
        `;

        this.bindEvents();
    }

    private bindEvents() {
        this.container.querySelector('#track-close-btn')?.addEventListener('click', this.onClose);

        const bpmInput = this.container.querySelector('#track-bpm-input') as HTMLInputElement | null;
        if (bpmInput) {
            registerParameterWheelControl(bpmInput);
            bpmInput.addEventListener('change', () => {
                const val = parseFloat(bpmInput.value);
                if (!isNaN(val)) this.setGlobal({ bpm: val });
            });
            bpmInput.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 1 : -1;
                const next = Math.max(20, Math.min(300, this.getBpm() + delta));
                this.setGlobal({ bpm: next });
            });
        }

        this.container.querySelector('#bpm-dec-btn')?.addEventListener('click', () => {
            const next = Math.max(20, this.getBpm() - 1);
            this.setGlobal({ bpm: next });
        });
        this.container.querySelector('#bpm-inc-btn')?.addEventListener('click', () => {
            const next = Math.min(300, this.getBpm() + 1);
            this.setGlobal({ bpm: next });
        });

        const barsInput = this.container.querySelector('#track-bars-input') as HTMLInputElement | null;
        if (barsInput) {
            registerParameterWheelControl(barsInput);
            barsInput.addEventListener('change', () => {
                const val = parseFloat(barsInput.value);
                if (!isNaN(val)) this.setGlobal({ total_bars: val });
            });
            barsInput.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 0.25 : -0.25;
                const next = Math.max(0.25, Math.min(128, this.getTotalBars() + delta));
                this.setGlobal({ total_bars: next });
            });
        }

        this.container.querySelector('#bars-dec-btn')?.addEventListener('click', () => {
            const next = Math.max(0.25, this.getTotalBars() - 1);
            this.setGlobal({ total_bars: next });
        });
        this.container.querySelector('#bars-inc-btn')?.addEventListener('click', () => {
            const next = Math.min(128, this.getTotalBars() + 1);
            this.setGlobal({ total_bars: next });
        });

        // Quick bar preset chips
        this.container.querySelectorAll<HTMLButtonElement>('.td-preset-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const b = parseFloat(btn.dataset.bars || '4');
                if (!isNaN(b)) this.setGlobal({ total_bars: b });
            });
        });

        // Key text input
        const keyInput = this.container.querySelector('#track-key-input') as HTMLInputElement | null;
        if (keyInput) {
            keyInput.addEventListener('change', () => {
                this.setGlobal({ key: keyInput.value.trim() || 'C' });
            });
        }

        // Root key chips
        this.container.querySelectorAll<HTMLButtonElement>('.td-key-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const root = btn.dataset.root || 'C';
                const current = this.getKey();
                const isMinor = current.includes('m') && !current.includes('maj');
                const newKey = isMinor ? `${root}m` : root;
                this.setGlobal({ key: newKey });
            });
        });

        // Mode chips (Major / Minor)
        this.container.querySelectorAll<HTMLButtonElement>('.td-mode-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                const current = this.getKey();
                const rootMatch = current.match(/^[A-G][#b]?/);
                const root = rootMatch ? rootMatch[0] : 'C';
                const newKey = mode === 'min' ? `${root}m` : root;
                this.setGlobal({ key: newKey });
            });
        });

        // Quick actions
        this.container.querySelector('#track-refresh-pools-btn')?.addEventListener('click', () => {
            const btn = document.querySelector('#preview-recalculate-btn') as HTMLButtonElement | null;
            if (btn && !btn.disabled) {
                btn.click();
            } else {
                fetch('/api/preview/invalidate', { method: 'POST' }).catch(() => {});
            }
        });

        this.container.querySelector('#track-reset-defaults-btn')?.addEventListener('click', () => {
            this.setGlobal({ bpm: 120, total_bars: 4, key: 'C' });
        });
    }

    private updateFieldsFromGlobal() {
        const bpm = this.getBpm();
        const totalBars = this.getTotalBars();
        const key = this.getKey();
        const duration = this.computeDuration();
        const stats = this.getGraphStats();

        const bpmInput = this.container.querySelector('#track-bpm-input') as HTMLInputElement | null;
        if (bpmInput && document.activeElement !== bpmInput) bpmInput.value = String(bpm);

        const barsInput = this.container.querySelector('#track-bars-input') as HTMLInputElement | null;
        if (barsInput && document.activeElement !== barsInput) barsInput.value = String(totalBars);

        const keyInput = this.container.querySelector('#track-key-input') as HTMLInputElement | null;
        if (keyInput && document.activeElement !== keyInput) keyInput.value = key;

        const durationDisplay = this.container.querySelector('#track-duration-display .td-duration-text');
        if (durationDisplay) {
            durationDisplay.textContent = `${duration.seconds.toFixed(2)}s (${duration.formatted}) · ${duration.beats} beats @ 4/4`;
        }

        this.container.querySelectorAll<HTMLButtonElement>('.td-preset-chip').forEach(chip => {
            const b = parseFloat(chip.dataset.bars || '4');
            chip.classList.toggle('active', totalBars === b);
        });

        this.container.querySelectorAll<HTMLButtonElement>('.td-key-chip').forEach(chip => {
            const root = chip.dataset.root || 'C';
            chip.classList.toggle('active', key.startsWith(root));
        });

        this.container.querySelectorAll<HTMLButtonElement>('.td-mode-chip').forEach(chip => {
            const mode = chip.dataset.mode;
            const isMinor = key.includes('m') && !key.includes('maj');
            chip.classList.toggle('active', mode === 'min' ? isMinor : !isMinor);
        });

        const statNodes = this.container.querySelector('#stat-nodes');
        if (statNodes) statNodes.textContent = String(stats.nodesCount);
        const statSamples = this.container.querySelector('#stat-samples');
        if (statSamples) statSamples.textContent = String(stats.sampleCount);
        const statSeqs = this.container.querySelector('#stat-seqs');
        if (statSeqs) statSeqs.textContent = String(stats.seqCount);
        const statTracks = this.container.querySelector('#stat-tracks');
        if (statTracks) statTracks.textContent = String(stats.trackCount);
    }
}
