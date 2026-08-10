import { type FieldSchema } from './FieldSchema';

export type SectionType =
    | 'fields'
    | 'info_table'
    | 'waveform_crop'
    | 'sequence_grid'
    | 'arrangement_timeline'
    | 'fx_chain'
    | 'pool_editor';

export interface PanelSectionConfig {
    type: SectionType;
    title?: string;
    fields?: Array<FieldSchema | string>;
    filepathKey?: string;
    cropStartKey?: string;
    cropEndKey?: string;
    chainKey?: string;
}

export interface PanelTabConfig {
    id: string;
    label: string;
    sections: PanelSectionConfig[];
}

export interface NodePanelSchema {
    tabs: PanelTabConfig[];
}
