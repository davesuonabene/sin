import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode';

export type RefreshMode = "parent_render" | "self_render" | "manual";

export class SamplePoolNode extends BaseNode {
    constructor() {
        super();
        this.title = "Sample Pool";
        this.size = [64, 64];
        
        // Distinct purple style for pool nodes
        this.color = "#8b5cf6";
        this.bgcolor = "#8b5cf6";
        this.boxcolor = "#7c3aed";
        
        this.properties = {
            node_name: "New Pool",
            node_type: "sample_pool",
            filters: {
                tags: "",
                bpm_min: null,
                bpm_max: null,
                type: ""
            },
            playbackMode: "Random",
            seed: Math.random(),
            refresh_mode: "manual",
            start_beat: 0,
            color: "#8b5cf6",
            icon: "📦"
        };
        
        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }
}

(SamplePoolNode as any).title = "Sample Pool";
LiteGraph.registerNodeType("Audio/SamplePool", SamplePoolNode);
