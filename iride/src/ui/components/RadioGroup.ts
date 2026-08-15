export interface RadioGroupOption {
    value: string;
    label: string;
}

export interface RadioGroupConfig {
    name: string;
    value: string;
    options: RadioGroupOption[];
    ariaLabel: string;
    onChange: (value: string) => void;
}

/** Schema-friendly radio control shared by inspector widgets. */
export class RadioGroup {
    static create(config: RadioGroupConfig): HTMLElement {
        const group = document.createElement('div');
        group.className = 'td-radio-group';
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', config.ariaLabel);

        for (const option of config.options) {
            const label = document.createElement('label');
            label.className = 'td-radio-option';

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = config.name;
            input.value = option.value;
            input.checked = option.value === config.value;
            input.setAttribute('aria-label', option.label);
            input.addEventListener('change', () => {
                if (input.checked) config.onChange(input.value);
            });

            const text = document.createElement('span');
            text.textContent = option.label;
            label.append(input, text);
            group.appendChild(label);
        }

        return group;
    }
}
