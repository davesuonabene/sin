import {
    clearRuntimeLog,
    runtimeLog,
    subscribeRuntimeLog,
    type RuntimeLogEntry
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

export class RuntimeLogPanel {
    private readonly panel: HTMLDivElement;
    private readonly rows: HTMLDivElement;
    private readonly toggle: HTMLButtonElement;
    private readonly errorEcho: HTMLButtonElement;
    private readonly unsubscribe: () => void;
    private hiddenErrorCount = 0;
    private currentEntries: RuntimeLogEntry[] = [];
    private renderedFirstId = 0;
    private renderedLastId = 0;
    private renderedCount = 0;

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
                <div class="runtime-log-actions">
                    <button type="button" data-action="clear">Clear</button>
                    <button type="button" data-action="close" aria-label="Close runtime log">×</button>
                </div>
            </div>
            <div class="runtime-log-columns" aria-hidden="true">
                <span>TIME</span><span>LEVEL</span><span>EVENT</span>
            </div>
            <div class="runtime-log-rows" role="log" aria-live="polite"></div>
        `;
        this.rows = this.panel.querySelector('.runtime-log-rows') as HTMLDivElement;

        this.toggle.addEventListener('click', () => this.setOpen(Boolean(this.panel.hidden)));
        this.errorEcho.addEventListener('click', () => this.setOpen(true));
        this.panel.querySelector('[data-action="close"]')?.addEventListener('click', () => this.setOpen(false));
        this.panel.querySelector('[data-action="clear"]')?.addEventListener('click', () => clearRuntimeLog());

        parent.append(this.panel, this.toggle, this.errorEcho);
        this.unsubscribe = subscribeRuntimeLog((entries, appendedEntries) => this.render(entries, appendedEntries));
        runtimeLog('Editor runtime ready', 'common');
    }

    dispose(): void {
        this.unsubscribe();
        this.panel.remove();
        this.toggle.remove();
        this.errorEcho.remove();
    }

    private setOpen(open: boolean): void {
        this.panel.hidden = !open;
        this.toggle.classList.toggle('is-active', open);
        this.toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            this.hiddenErrorCount = 0;
            this.errorEcho.hidden = true;
            this.renderRows(this.currentEntries);
            this.rows.scrollTop = this.rows.scrollHeight;
        }
    }

    private render(entries: RuntimeLogEntry[], appendedEntries: RuntimeLogEntry[]): void {
        this.currentEntries = entries;
        // Inspect only the delta supplied by the logger. Scanning the complete
        // bounded history for every hidden-panel event made logging cost grow
        // with the size of the retained log.
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

        this.renderRows(entries);
    }

    private renderRows(entries: RuntimeLogEntry[]): void {
        const shouldFollow = this.rows.scrollHeight - this.rows.scrollTop - this.rows.clientHeight < 36;
        if (entries.length === 0) {
            this.rows.replaceChildren();
            this.renderedFirstId = 0;
            this.renderedLastId = 0;
            this.renderedCount = 0;
            return;
        }

        const canAppend = this.renderedCount > 0
            && entries.length >= this.renderedCount
            && entries[0].id === this.renderedFirstId
            && entries[this.renderedCount - 1]?.id === this.renderedLastId;
        const pendingEntries = canAppend ? entries.slice(this.renderedCount) : entries;
        const fragment = document.createDocumentFragment();
        for (const entry of pendingEntries) {
            fragment.appendChild(this.createRow(entry));
        }
        if (canAppend) this.rows.appendChild(fragment);
        else this.rows.replaceChildren(fragment);
        this.renderedFirstId = entries[0].id;
        this.renderedLastId = entries[entries.length - 1].id;
        this.renderedCount = entries.length;
        if (shouldFollow) this.rows.scrollTop = this.rows.scrollHeight;
    }

    private createRow(entry: RuntimeLogEntry): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'runtime-log-row';
        row.dataset.level = entry.level;

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
