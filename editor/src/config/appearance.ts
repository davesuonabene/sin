export interface AppearanceColorPreset {
    value: string;
    label: string;
}

/**
 * The colors offered by the node appearance selector.
 *
 * Keep this list intentionally small: edit this file to change the available
 * palette without changing the inspector renderer.
 */
export const APPEARANCE_COLOR_PRESETS: AppearanceColorPreset[] = [
    { value: '#10b981', label: 'Emerald' },
    { value: '#4f46e5', label: 'Indigo' },
    { value: '#ec4899', label: 'Pink' },
    { value: '#8b5cf6', label: 'Violet' },
    { value: '#f59e0b', label: 'Amber' },
    { value: '#9333ea', label: 'Purple' },
    { value: '#ef4444', label: 'Red' },
    { value: '#06b6d4', label: 'Cyan' },
    { value: '#3b82f6', label: 'Blue' },
    { value: '#64748b', label: 'Slate' }
];
