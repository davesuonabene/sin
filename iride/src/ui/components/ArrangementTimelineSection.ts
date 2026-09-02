import { type BaseNode } from '../../nodes/BaseNode';
import { type FieldSchema } from '../../fields/FieldSchema';
import { type ArrangementNode, type ArrangementSectionStructure } from '../../nodes/ArrangementNode';
import { ArrangementVisualizer } from '../ArrangementVisualizer';
import { resolveArrangementSourceVisual } from '../arrangementSourceVisual';

export class ArrangementTimelineSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        node.properties.total_bars = Math.max(0.25, Number(node.properties.total_bars) || 4);
        const arrangementNode = node as ArrangementNode;
        const initialStructure = arrangementNode.migrateLegacySectionSettings();
        const totalBars = node.properties.total_bars;

        const wrapper = document.createElement('div');
        wrapper.className = 'arrangement-timeline-group';
        wrapper.innerHTML = `
            <div class="arrangement-timeline-header">
                <div class="arrangement-timeline-title">Sections</div>
                <div class="arrangement-timeline-length">${totalBars} ${totalBars === 1 ? 'bar' : 'bars'}</div>
            </div>
            <div class="arrangement-visualizer"></div>
            <div class="arrangement-section-editor"></div>
        `;
        container.appendChild(wrapper);

        const visualizerContainer = wrapper.querySelector('.arrangement-visualizer') as HTMLElement;
        const sectionEditor = wrapper.querySelector('.arrangement-section-editor') as HTMLElement;
        if (!visualizerContainer || !sectionEditor) return;

        let selectedSection = 0;
        let visualizer: ArrangementVisualizer;

        const findField = (key: string) => arrangementNode.getFields().find(field => field.key === key);
        const populateSelect = (
            select: HTMLSelectElement | null,
            options: FieldSchema['options'],
            currentValue: string
        ) => {
            if (!select) return;
            for (const option of options || []) {
                const normalized = typeof option === 'string' ? { value: option, label: option } : option;
                select.add(new Option(normalized.label, String(normalized.value), false, String(normalized.value) === currentValue));
            }
        };

        const updateSectionControls = () => {
            const structure = arrangementNode.getSectionStructure();
            if (selectedSection >= structure.probability.length) selectedSection = 0;
            const index = selectedSection;
            const probabilityField = findField('section_probability');
            const sampleStartField = findField('section_sample_start');
            const quantField = findField('section_quant');
            const anchorField = findField('section_quant_anchor');

            sectionEditor.innerHTML = `
                <div class="arrangement-section-heading">Section ${index + 1}</div>
                <div class="td-param-row">
                    <div class="td-param-label">${probabilityField?.label || 'Probability'}</div>
                    <div class="td-param-control">
                        <input class="td-param-input" id="sec-prob-input" type="number" min="0" max="1" step="0.05" value="${structure.probability[index]}">
                    </div>
                </div>
                <div class="td-param-row">
                    <div class="td-param-label">${sampleStartField?.label || 'Sample Start'}</div>
                    <div class="td-param-control">
                        <input class="td-param-input" id="sec-sample-start-input" type="number" min="${sampleStartField?.min ?? 0}" max="${sampleStartField?.max ?? 1}" step="${sampleStartField?.step ?? 0.01}" value="${structure.sampleStart[index]}">
                    </div>
                </div>
                <div class="td-param-row">
                    <div class="td-param-label">${quantField?.label || 'Quantize'}</div>
                    <div class="td-param-control">
                        <select class="td-param-input sin-select" id="prop-sec-quant"></select>
                    </div>
                </div>
                <div class="td-param-row">
                    <div class="td-param-label">${anchorField?.label || 'Anchor'}</div>
                    <div class="td-param-control">
                        <select class="td-param-input sin-select" id="prop-sec-quant-anchor"></select>
                    </div>
                </div>
                ${structure.points.length > 0 && index < structure.points.length
                    ? '<div class="arrangement-section-actions"><button type="button" class="arrangement-btn-sm danger" id="btn-delete-cut">Remove following cut</button></div>'
                    : ''}
            `;

            const quantSelect = sectionEditor.querySelector('#prop-sec-quant') as HTMLSelectElement | null;
            const anchorSelect = sectionEditor.querySelector('#prop-sec-quant-anchor') as HTMLSelectElement | null;
            populateSelect(quantSelect, quantField?.options, structure.quant[index]);
            populateSelect(anchorSelect, anchorField?.options, structure.quantAnchor[index]);

            sectionEditor.querySelector('#sec-prob-input')?.addEventListener('change', event => {
                const value = Number((event.target as HTMLInputElement).value);
                arrangementNode.updateSectionProbability(index, value);
                visualizer.setSectionProbability(index, value);
                windowContext.refreshAudioPreview();
            });
            sectionEditor.querySelector('#sec-sample-start-input')?.addEventListener('change', event => {
                const value = Number((event.target as HTMLInputElement).value);
                arrangementNode.updateSectionSampleStart(index, value);
                visualizer.setSectionSampleStart(index, value);
                windowContext.refreshAudioPreview();
            });
            quantSelect?.addEventListener('change', () => {
                arrangementNode.updateSectionQuant(index, quantSelect.value);
                visualizer.setSectionQuant(index, quantSelect.value);
                windowContext.refreshAudioPreview();
            });
            anchorSelect?.addEventListener('change', () => {
                const anchor = anchorSelect.value === 'end' ? 'end' : 'start';
                arrangementNode.updateSectionQuantAnchor(index, anchor);
                visualizer.setSectionQuantAnchor(index, anchor);
                windowContext.refreshAudioPreview();
            });
            sectionEditor.querySelector('#btn-delete-cut')?.addEventListener('click', () => {
                arrangementNode.removeSectionCut(index);
                windowContext.refreshAudioPreview();
                windowContext.currentArrangementVisualizer?.destroy();
                container.replaceChildren();
                void ArrangementTimelineSection.render(container, node, windowContext);
            });
        };

        visualizer = new ArrangementVisualizer({
            container: visualizerContainer,
            totalBars,
            sectionPoints: initialStructure.points,
            sectionProbability: initialStructure.probability,
            sectionSampleStart: initialStructure.sampleStart,
            sectionQuant: initialStructure.quant,
            sectionQuantAnchor: initialStructure.quantAnchor,
            selectedSection,
            source: resolveArrangementSourceVisual(node),
            onSectionSelect: (index: number) => {
                selectedSection = index;
                updateSectionControls();
            },
            onSectionStructureChange: (points, probability, sampleStart, quant, quantAnchor) => {
                const structure: ArrangementSectionStructure = {
                    points,
                    probability: probability || [],
                    sampleStart: sampleStart || [],
                    quant: quant || [],
                    quantAnchor: quantAnchor || []
                };
                arrangementNode.updateSectionStructure(structure);
                windowContext.refreshAudioPreview();
                updateSectionControls();
            }
        });

        windowContext.currentArrangementVisualizer = visualizer;
        updateSectionControls();
    }
}
