import {
    clearRuntimeLog,
    runtimeLog,
    subscribeRuntimeLog,
    subscribeEngineTelemetry,
    type RuntimeLogEntry,
    type EngineTelemetrySummary
} from '../runtimeLog';

function formatTimestamp(timestamp: Date): string {
    return timestamp.toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
    });
}

export type RuntimeLogFilter = 'all' | 'app' | 'engine' | 'error';

export class RuntimeLogPanel {
    private readonly panel: HTMLDivElement;
    private readonly rows: HTMLDivElement;
    private readonly toggle: HTMLButtonElement;
    private readonly errorEcho: HTMLButtonElement;
    private readonly telemetryRender: HTMLElement;
    private readonly telemetryStream: HTMLElement;
    private readonly telemetryTotal: HTMLElement;
    private readonly telemetryBuffer: HTMLElement;
    private readonly unsubscribe: () => void;
    private readonly unsubscribeTelemetry: () => void;
    private hiddenErrorCount = 0;
    private currentEntries: RuntimeLogEntry[] = [];
    private activeFilter: RuntimeLogFilter = 'all';

    constructor(parent: HTMLElement) {
        this.toggle = document.createElement('button');
        this.toggle.type = 'button';
        this.toggle.className = 'runtime-log-toggle';
        this.toggle.title = 'Toggle runtime log';
        this.toggle.setAttribute('aria-label', this.toggle.title);
        this.toggle.setAttribute('aria-expanded', 'false');
        this.toggle.innerHTML = '<span aria-hidden="true">&gt;_</span>';

        this.errorEcho = document.createElement('button');
        this.errorEcho.type = 'button';
        this.errorEcho.className = 'runtime-log-error-echo';
        this.errorEcho.hidden = true;
        this.errorEcho.setAttribute('aria-live', 'assertive');
        this.errorEcho.title = 'Open runtime log';

        this.panel = document.createElement('div');
        this.panel.className = 'runtime-log-panel';
        this.panel.hidden = true;
        this.panel.innerHTML = `
            <div class="runtime-log-header">
                <span>Runtime log</span>
                <div class="runtime-log-filters" role="tablist" aria-label="Log category filter">
                    <button type="button" class="is-active" data-filter="all">All</button>
                    <button type="button" data-filter="app">App</button>
                    <button type="button" data-filter="engine">Engine</button>
                    <button type="button" data-filter="error">Errors</button>
                </div>
                <div class="runtime-log-actions">
                    <button type="button" data-action="clear">Clear</button>
                    <button type="button" data-action="close" aria-label="Close runtime log">×</button>
                </div>
            </div>
            <div class="runtime-log-telemetry-bar" aria-label="Engine Telemetry Profiler">
                <span>Render: <b data-telemetry="render">--</b></span>
                <span>Stream: <b data-telemetry="stream">--</b></span>
                <span>Total: <b data-telemetry="total">--</b></span>
                <span>Buffer: <b data-telemetry="buffer">--</b></span>
            </div>
            <div class="runtime-log-columns" aria-hidden="true">
                <span>TIME</span><span>LEVEL</span><span>EVENT</span>
            </div>
            <div class="runtime-log-rows" role="log" aria-live="polite"></div>
        `;
        this.rows = this.panel.querySelector('.runtime-log-rows') as HTMLDivElement;
        this.telemetryRender = this.panel.querySelector('[data-telemetry="render"]') as HTMLElement;
        this.telemetryStream = this.panel.querySelector('[data-telemetry="stream"]') as HTMLElement;
        this.telemetryTotal = this.panel.querySelector('[data-telemetry="total"]') as HTMLElement;
        this.telemetryBuffer = this.panel.querySelector('[data-telemetry="buffer"]') as HTMLElement;

        this.toggle.addEventListener('click', () => this.setOpen(Boolean(this.panel.hidden)));
        this.errorEcho.addEventListener('click', () => this.setOpen(true));
        this.panel.querySelector('[data-action="close"]')?.addEventListener('click', () => this.setOpen(false));
        this.panel.querySelector('[data-action="clear"]')?.addEventListener('click', () => clearRuntimeLog());

        const filterBtns = this.panel.querySelectorAll<HTMLButtonElement>('.runtime-log-filters button');
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.dataset.filter as RuntimeLogFilter;
                if (filter) this.setFilter(filter);
            });
        });

        parent.append(this.panel, this.toggle, this.errorEcho);
        this.unsubscribe = subscribeRuntimeLog((entries, appendedEntries) => this.render(entries, appendedEntries));
        this.unsubscribeTelemetry = subscribeEngineTelemetry(t => this.renderTelemetry(t));

        (window as any).runtimeLogPanel = this;
        runtimeLog('Editor runtime ready', 'common');
    }

    dispose(): void {
        this.unsubscribe();
        this.unsubscribeTelemetry();
        this.panel.remove();
        this.toggle.remove();
        this.errorEcho.remove();
        if ((window as any).runtimeLogPanel === this) {
            delete (window as any).runtimeLogPanel;
        }
    }

    setOpen(open: boolean): void {
        this.panel.hidden = !open;
        this.toggle.classList.toggle('is-active', open);
        this.toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            this.hiddenErrorCount = 0;
            this.errorEcho.hidden = true;
            this.renderFilteredRows();
            this.rows.scrollTop = this.rows.scrollHeight;
        }
    }

    openWithFilter(filter: RuntimeLogFilter): void {
        this.setFilter(filter);
        this.setOpen(true);
    }

    setFilter(filter: RuntimeLogFilter): void {
        this.activeFilter = filter;
        const filterBtns = this.panel.querySelectorAll<HTMLButtonElement>('.runtime-log-filters button');
        filterBtns.forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.filter === filter);
        });
        this.renderFilteredRows();
    }

    private renderTelemetry(t: EngineTelemetrySummary): void {
        if (this.telemetryRender) {
            this.telemetryRender.textContent = t.renderMs != null ? `${t.renderMs}ms` : '--';
        }
        if (this.telemetryStream) {
            this.telemetryStream.textContent = t.streamMs != null ? `${t.streamMs}ms` : '--';
        }
        if (this.telemetryTotal) {
            this.telemetryTotal.textContent = t.totalMs != null ? `${t.totalMs}ms` : '--';
        }
        if (this.telemetryBuffer) {
            this.telemetryBuffer.textContent = t.bufferedPercent != null ? `${Math.round(t.bufferedPercent)}%` : '--';
        }
    }

    private render(entries: RuntimeLogEntry[], appendedEntries: RuntimeLogEntry[]): void {
        this.currentEntries = entries;
        const newErrors = appendedEntries.filter(entry => entry.level === 'error');
        if (newErrors.length > 0 && this.panel.hidden) {
            this.hiddenErrorCount += newErrors.length;
            const latest = newErrors[newErrors.length - 1];
            this.errorEcho.textContent = this.hiddenErrorCount > 1
                ? `${latest.message} (+${this.hiddenErrorCount - 1})`
                : latest.message;
            this.errorEcho.hidden = false;
        }
        if (this.panel.hidden) return;

        this.renderFilteredRows();
    }

    private getFilteredEntries(): RuntimeLogEntry[] {
        if (this.activeFilter === 'all') return this.currentEntries;
        if (this.activeFilter === 'error') return this.currentEntries.filter(e => e.level === 'error');
        if (this.activeFilter === 'engine') return this.currentEntries.filter(e => e.category === 'engine' || e.category === 'telemetry');
        return this.currentEntries.filter(e => !e.category || e.category === 'app');
    }

    private renderFilteredRows(): void {
        const filtered = this.getFilteredEntries();
        const shouldFollow = this.rows.scrollHeight - this.rows.scrollTop - this.rows.clientHeight < 36;
        const fragment = document.createDocumentFragment();
        for (const entry of filtered) {
            fragment.appendChild(this.createRow(entry));
        }
        this.rows.replaceChildren(fragment);
        if (shouldFollow) this.rows.scrollTop = this.rows.scrollHeight;
    }

    private createRow(entry: RuntimeLogEntry): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'runtime-log-row';
        row.dataset.level = entry.level;
        if (entry.category) row.dataset.category = entry.category;

        const timestamp = document.createElement('time');
        timestamp.dateTime = entry.timestamp.toISOString();
        timestamp.textContent = formatTimestamp(entry.timestamp);

        const level = document.createElement('span');
        level.className = 'runtime-log-level';
        level.textContent = entry.level.toUpperCase();

        const message = document.createElement('span');
        message.className = 'runtime-log-message';
        message.textContent = entry.message;
        message.title = entry.message;

        row.append(timestamp, level, message);
        return row;
    }
}
