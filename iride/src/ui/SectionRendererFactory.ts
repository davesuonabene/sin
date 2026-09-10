import { type PanelSectionConfig } from '../fields/NodePanelSchema';
import { type FieldSchema } from '../fields/FieldSchema';
import { type BaseNode } from '../nodes/BaseNode';
import { WidgetFactory } from './WidgetFactory';
import { WaveformCropSection } from './components/WaveformCropSection';
import { SequenceGridSection } from './components/SequenceGridSection';
import { ArrangementTimelineSection } from './components/ArrangementTimelineSection';
import { FxChainSection } from './components/FxChainSection';
import { AssetPoolSection } from './components/AssetPoolSection';
import { RandomDestinationsSection } from './components/RandomDestinationsSection';
import { NEON_ICONS, NODE_SHAPES } from '../nodes/NodeVisuals';
import { APPEARANCE_COLOR_PRESETS } from '../config/appearance';

export class SectionRendererFactory {
    static async renderSection(
        section: PanelSectionConfig,
        node: BaseNode,
        windowContext: any
    ): Promise<HTMLElement> {
        const wrapper = document.createElement('div');
        wrapper.className = `td-section-container td-section-${section.type}`;

        if (section.title) {
            const heading = document.createElement('h4');
            heading.className = 'td-section-title';
            heading.textContent = section.title;
            wrapper.appendChild(heading);
        }

        switch (section.type) {
            case 'fields':
                this.renderFieldsSection(wrapper, section, node, windowContext);
                break;
            case 'appearance':
                this.renderAppearanceSection(wrapper, node, windowContext);
                break;
            case 'info_table':
                this.renderInfoTableSection(wrapper, node, windowContext);
                break;
            case 'fx_chain':
                await FxChainSection.render(wrapper, node, windowContext);
                break;
            case 'pool_editor':
                await AssetPoolSection.render(wrapper, node, windowContext);
                break;
            case 'random_panel':
                await RandomDestinationsSection.render(wrapper, node, windowContext);
                break;
            case 'waveform_crop':
                await WaveformCropSection.render(wrapper, node, windowContext);
                break;
            case 'sequence_grid':
                await SequenceGridSection.render(wrapper, node, windowContext);
                break;
            case 'arrangement_timeline':
                await ArrangementTimelineSection.render(wrapper, node, windowContext);
                break;
            default:
                this.renderFieldsSection(wrapper, section, node, windowContext);
                break;
        }

        return wrapper;
    }

    private static renderFieldsSection(
        container: HTMLElement,
        section: PanelSectionConfig,
        node: BaseNode,
        windowContext: any
    ) {
        const group = document.createElement('div');
        group.className = 'td-param-group';
        if (section.layout === 'inline') group.classList.add('td-param-group-inline');

        const nodeFieldsMap = new Map<string, FieldSchema>();
        for (const f of node.getFields()) {
            nodeFieldsMap.set(f.key, f);
        }

        const fieldsToRender: FieldSchema[] = [];
        if (section.fields && section.fields.length > 0) {
            for (const item of section.fields) {
                if (typeof item === 'string') {
                    const schema = nodeFieldsMap.get(item);
                    if (schema) fieldsToRender.push(schema);
                } else {
                    fieldsToRender.push(item);
                }
            }
        } else {
            fieldsToRender.push(...node.getFields());
        }

        const titleDisplay = windowContext.container.querySelector('#td-title-display') as HTMLSpanElement;

        for (const field of fieldsToRender) {
            const row = WidgetFactory.createRow(field, node, async (key, val, previousValue) => {
                try {
                    await node.onPropertyEdited(key, val, previousValue);
                    if (key === 'node_name' && titleDisplay) {
                        titleDisplay.innerText = String(val);
                    }
                    windowContext.refreshAudioPreview();
                    if (field.type === 'filepath' && windowContext.currentWaveformVisualizer) {
                        await windowContext.renderTabContent();
                    }
                } catch (error) {
                    node.updateProperty(key, previousValue);
                    console.error(`Could not save ${field.label}`, error);
                    window.alert(error instanceof Error ? error.message : `Could not save ${field.label}`);
                    await windowContext.renderTabContent();
                }
            });
            group.appendChild(row);
        }

        container.appendChild(group);
    }

    private static renderAppearanceSection(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ) {
        const group = document.createElement('div');
        group.className = 'td-appearance-group';

        const heading = document.createElement('div');
        heading.className = 'td-appearance-title';
        heading.textContent = 'Appearance';
        group.appendChild(heading);

        const currentColor = node.nodeColor;
        const currentIcon = node.nodeIcon;
        const currentShape = node.nodeShape;
        const colorPresets = [...APPEARANCE_COLOR_PRESETS];
        if (!colorPresets.some(preset => preset.value.toLowerCase() === currentColor.toLowerCase())) {
            colorPresets.unshift({ value: currentColor, label: `Current (${currentColor})` });
        }

        const createRow = (
            label: string,
            key: 'color' | 'icon' | 'shape',
            currentValue: string,
            options: Array<{ value: string; label: string }>,
            currentColorIndicator?: HTMLElement
        ) => {
            const row = document.createElement('div');
            row.className = 'td-appearance-row td-param-row';

            const labelElement = document.createElement('div');
            labelElement.className = 'td-param-label';
            labelElement.textContent = label;
            row.appendChild(labelElement);

            const control = document.createElement('div');
            control.className = 'td-param-control td-appearance-control';

            if (currentColorIndicator) control.appendChild(currentColorIndicator);

            const select = document.createElement('select');
            select.className = 'td-param-select td-appearance-select sin-select';
            select.setAttribute('aria-label', label);
            for (const optionConfig of options) {
                const option = document.createElement('option');
                option.value = optionConfig.value;
                option.textContent = optionConfig.label;
                option.selected = optionConfig.value === currentValue;
                select.appendChild(option);
            }
            select.dataset.appearanceKey = key;
            control.appendChild(select);
            row.appendChild(control);
            group.appendChild(row);

            return select;
        };

        const currentColorIndicator = document.createElement('span');
        currentColorIndicator.className = 'td-appearance-color-preview';
        currentColorIndicator.style.backgroundColor = currentColor;
        currentColorIndicator.setAttribute('aria-hidden', 'true');

        const colorSelect = createRow(
            'Color',
            'color',
            currentColor,
            colorPresets,
            currentColorIndicator
        );
        const iconSelect = createRow(
            'Icon',
            'icon',
            currentIcon,
            NEON_ICONS.map(icon => ({ value: icon.id, label: icon.label }))
        );
        const shapeSelect = createRow(
            'Shape',
            'shape',
            currentShape,
            NODE_SHAPES.map(shape => ({
                value: shape,
                label: shape.charAt(0).toUpperCase() + shape.slice(1)
            }))
        );

        const previousValueFor = (key: 'color' | 'icon' | 'shape'): string => {
            if (key === 'color') return node.nodeColor;
            if (key === 'icon') return node.nodeIcon;
            return node.nodeShape;
        };

        const applyAppearance = async (key: 'color' | 'icon' | 'shape', value: string, select: HTMLSelectElement) => {
            const previousValue = previousValueFor(key);
            if (value === previousValue) return;

            node.updateProperty(key, value);
            if (key === 'color') {
                node.color = value;
                node.bgcolor = value;
                currentColorIndicator.style.backgroundColor = value;
            }
            node.setDirtyCanvas(true, true);

            try {
                await node.onPropertyEdited(key, value, previousValue);
            } catch (error) {
                node.updateProperty(key, previousValue);
                select.value = previousValue;
                if (key === 'color') currentColorIndicator.style.backgroundColor = previousValue;
                node.setDirtyCanvas(true, true);
                console.error(`Could not save ${key}`, error);
                window.alert(error instanceof Error ? error.message : `Could not save ${key}`);
            }
        };

        colorSelect.addEventListener('change', () => void applyAppearance('color', colorSelect.value, colorSelect));
        iconSelect.addEventListener('change', () => void applyAppearance('icon', iconSelect.value, iconSelect));
        shapeSelect.addEventListener('change', () => void applyAppearance('shape', shapeSelect.value, shapeSelect));

        container.appendChild(group);
    }

    private static renderInfoTableSection(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ) {
        const pos = node.pos ? `X: ${Math.round(node.pos[0])}, Y: ${Math.round(node.pos[1])}` : 'N/A';
        const inputsCount = node.inputs ? node.inputs.length : 0;
        const outputsCount = node.outputs ? node.outputs.length : 0;

        const table = document.createElement('table');
        table.className = 'td-info-table';
        table.innerHTML = `
            <tr><td>ID</td><td>#${node.id}</td></tr>
            <tr><td>Type</td><td>${node.type}</td></tr>
            <tr><td>Position</td><td>${pos}</td></tr>
            <tr><td>Inputs</td><td>${inputsCount} slot(s)</td></tr>
            <tr><td>Outputs</td><td>${outputsCount} slot(s)</td></tr>
        `;
        container.appendChild(table);
    }
}
