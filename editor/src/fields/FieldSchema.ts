import { type UnitFieldConfig } from './UnitConverter.ts';

export type FieldType = 'string' | 'int' | 'float' | 'unit_float' | 'global_float' | 'select' | 'radio' | 'boolean' | 'db' | 'seed' | 'filepath' | 'asset_call' | 'tuple' | 'slider' | 'directory';

export interface SelectOption {
    value: string | number | boolean;
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
    unitConfig?: UnitFieldConfig;
    options?: Array<SelectOption | string>;
    placeholder?: string;
    description?: string;
    dynamic?: boolean;
    commitOnChange?: boolean;
    subFields?: string[];
    nestedFields?: string[];
    stepVisual?: StepVisualSchema;
    getValue?: (node: any) => T;
    setValue?: (node: any, value: T) => T;
}
