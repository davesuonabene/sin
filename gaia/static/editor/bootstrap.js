import { fetchRegistry } from './engine-registry.js';
import { createTransportController } from './transport.js';
import { createExportModal } from './export-modal.js';
import { createEditorHost } from './editor-host.js';
import { SinEngine } from './engines/sin-engine.js';
import { SimpleMediaEngine } from './engines/simple-media-engine.js';
import {
    enhanceSelect,
    enhanceAllSelects,
    enhanceRangeSlider,
    WaveformScrubCanvas,
    formatTransportTime,
    ICONS,
    renderIcon,
} from '/packages/ui/src/index.js?v=2';

window.sinUI = {
    enhanceSelect,
    enhanceAllSelects,
    enhanceRangeSlider,
    WaveformScrubCanvas,
    formatTransportTime,
    ICONS,
    renderIcon,
};

function enhanceStaticSelects() {
    document
        .querySelectorAll('select:not(.file-version-selector):not(.reference-version-selector)')
        .forEach((select) => {
            if (select instanceof HTMLSelectElement) {
                enhanceSelect(select);
            }
        });
}

function initGaiaEditor() {
    if (window.__gaiaEditorBootstrapped) return;
    window.__gaiaEditorBootstrapped = true;

    const transport = createTransportController();
    const exportModal = createExportModal();
    const host = createEditorHost({ exportModal, transport });

    host.registerEngine(new SinEngine());
    host.registerEngine(new SimpleMediaEngine());

    enhanceStaticSelects();
    void fetchRegistry();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGaiaEditor, { once: true });
} else {
    initGaiaEditor();
}
