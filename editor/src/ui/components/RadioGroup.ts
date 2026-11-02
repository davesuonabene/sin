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

        const rawVal = String(config.value ?? '').toLowerCase().trim();
        let matchedValue = config.options.find(opt => opt.value.toLowerCase() === rawVal)?.value;
        if (!matchedValue) {
            if (config.name.includes('refresh_mode')) {
                if (rawVal.includes('parent')) matchedValue = 'parent';
                else if (rawVal.includes('local')) matchedValue = 'local';
                else if (rawVal.includes('ancestor')) matchedValue = 'ancestor';
                else if (rawVal.includes('off') || rawVal.includes('fixed')) matchedValue = 'off';
                else matchedValue = config.options.find(opt => opt.value.toLowerCase() === 'global')?.value;
            }
        }
        if (!matchedValue && config.options.length > 0) {
            matchedValue = config.options.find(opt => opt.value.toLowerCase() === 'global')?.value || config.options[0]?.value;
        }

        for (const option of config.options) {
            const label = document.createElement('label');
            label.className = 'td-radio-option';

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = config.name;
            input.value = option.value;
            input.checked = option.value === matchedValue;
            if (input.checked) {
                label.classList.add('is-checked');
            }
            input.setAttribute('aria-label', option.label);
            input.addEventListener('change', () => {
                if (input.checked) {
                    group.querySelectorAll('.td-radio-option').forEach(el => el.classList.remove('is-checked'));
                    label.classList.add('is-checked');
                    config.onChange(input.value);
                }
            });

            const text = document.createElement('span');
            text.textContent = option.label;
            label.append(input, text);
            group.appendChild(label);
        }

        return group;
    }
}
