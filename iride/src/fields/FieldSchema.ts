export type FieldType = 'string' | 'int' | 'float' | 'global_float' | 'select' | 'radio' | 'boolean' | 'db' | 'seed' | 'filepath' | 'slider';

export interface SelectOption {
    value: string | number;
    label: string;
}

export type StepVisualMode = 'fill' | 'fragments';
export type StepValuePolarity = 'unipolar' | 'bipolar';
export type StepFillDirection = 'vertical' | 'horizontal';

export interface StepVisualSchema {
    mode: StepVisualMode;
    polarity?: StepValuePolarity;
    direction?: StepFillDirection;
}

export interface FieldSchema<T = any> {
    key: string;
    label: string;
    type: FieldType;
    default: T;
    tab?: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    options?: Array<SelectOption | string>;
    placeholder?: string;
    description?: string;
    nestedFields?: string[];
    stepVisual?: StepVisualSchema;
}
