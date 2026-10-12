/**
 * EngineSyncManager.ts
 * Manages the state machine and UI indicators for the backend DSP audio engine.
 * Displays engine synchronization status, calculation timings, and streaming progress
 * without interfering with stage saving or the runtime log console.
 */

export type EngineSyncState =
    | 'idle_synced'        // Engine in sync with UI parameters, buffer ready
    | 'dirty_pending'      // Parameter changes pending debounce/compile
    | 'dsp_rendering'      // Backend compiling/rendering DSP graph
    | 'streaming_chunks'   // Progressively streaming bar chunks
    | 'hot_swapping'       // Live playback hot-swap in flight
    | 'global_refreshing'  // Global recalculation of pools/seeds (playback stopped)
    | 'error';             // DSP or communication failure

export interface EngineSyncMetrics {
    lastRenderDurationMs?: number;
    barsReceived?: number;
    totalBars?: number;
    nodeId?: number;
    nodeName?: string;
    errorMessage?: string;
}

export class EngineSyncManager {
    private static instance: EngineSyncManager | null = null;
    private state: EngineSyncState = 'idle_synced';
    private metrics: EngineSyncMetrics = {};
    private readonly statusElement: HTMLDivElement | null = null;
    private readonly iconElement: HTMLSpanElement | null = null;
    private readonly labelElement: HTMLSpanElement | null = null;

    static getInstance(): EngineSyncManager {
        if (!EngineSyncManager.instance) {
            EngineSyncManager.instance = new EngineSyncManager();
        }
        return EngineSyncManager.instance;
    }

    private constructor() {
        if (typeof document !== 'undefined') {
            this.statusElement = document.createElement('div');
            this.statusElement.className = 'engine-sync-status';
            this.statusElement.setAttribute('role', 'status');
            this.statusElement.setAttribute('aria-live', 'polite');

            this.iconElement = document.createElement('span');
            this.iconElement.className = 'engine-sync-icon';
            this.iconElement.setAttribute('aria-hidden', 'true');

            this.labelElement = document.createElement('span');
            this.labelElement.className = 'engine-sync-label';

            this.statusElement.append(this.iconElement, this.labelElement);
            this.statusElement.addEventListener('click', () => {
                const panel = (window as any).runtimeLogPanel;
                if (panel) {
                    panel.openWithFilter('engine');
                }
            });
            this.updateView();
        }
    }

    attachTo(container: HTMLElement): void {
        if (this.statusElement) {
            container.appendChild(this.statusElement);
        }
    }

    getState(): EngineSyncState {
        return this.state;
    }

    getMetrics(): EngineSyncMetrics {
        return { ...this.metrics };
    }

    setState(state: EngineSyncState, metrics?: Partial<EngineSyncMetrics>): void {
        this.state = state;
        if (metrics) {
            this.metrics = { ...this.metrics, ...metrics };
        }
        this.updateView();

        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('engine-sync-state-changed', {
                detail: { state: this.state, metrics: this.metrics }
            }));
        }
    }

    private updateView(): void {
        if (!this.statusElement || !this.iconElement || !this.labelElement) return;
        this.statusElement.dataset.state = this.state;

        let icon = '●';
        let label = 'In Sync';
        let tooltip = 'Engine in sync (Ready)';

        switch (this.state) {
            case 'idle_synced':
                icon = '●';
                label = this.metrics.lastRenderDurationMs != null
                    ? `${this.metrics.lastRenderDurationMs}ms`
                    : 'Synced';
                tooltip = this.metrics.lastRenderDurationMs != null
                    ? `Engine in sync · Rendered in ${this.metrics.lastRenderDurationMs} ms`
                    : 'Engine in sync with current graph parameters';
                break;

            case 'dirty_pending':
                icon = '◐';
                label = 'Pending...';
                tooltip = 'Parameter modifications pending compilation...';
                break;

            case 'dsp_rendering':
                icon = '↻';
                label = 'Rendering...';
                tooltip = this.metrics.nodeName
                    ? `Rendering DSP for "${this.metrics.nodeName}"...`
                    : 'Backend DSP engine calculating audio graph...';
                break;

            case 'streaming_chunks':
                const bars = this.metrics.barsReceived ?? 0;
                const total = this.metrics.totalBars ?? 0;
                icon = '◉';
                label = total > 0 ? `Bar ${bars}/${total}` : 'Buffering...';
                tooltip = `Streaming audio chunks: Bar ${bars} of ${total}`;
                break;

            case 'hot_swapping':
                icon = '≋';
                label = 'Swapping...';
                tooltip = 'Hot-swapping audio buffer during active playback';
                break;

            case 'global_refreshing':
                icon = '↻';
                label = 'Refreshing...';
                tooltip = 'Global re-roll of pools, seeds, and sequences...';
                break;

            case 'error':
                icon = '▲';
                label = 'Engine Error';
                tooltip = this.metrics.errorMessage || 'Audio engine error occurred';
                break;
        }

        this.iconElement.textContent = icon;
        this.labelElement.textContent = label;
        this.statusElement.title = tooltip;
        this.statusElement.setAttribute('aria-label', tooltip);
    }
}

export const engineSync = EngineSyncManager.getInstance();
