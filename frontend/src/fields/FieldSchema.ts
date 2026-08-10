export type FieldType = 'string' | 'int' | 'float' | 'select' | 'boolean' | 'db' | 'seed' | 'filepath' | 'slider';

export interface SelectOption {
    value: string | number;
    label: string;
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
}
