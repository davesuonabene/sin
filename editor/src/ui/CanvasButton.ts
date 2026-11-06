import { LGraphNode } from 'litegraph.js';

export class CanvasButton {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    color: string;
    hoverColor: string;
    activeColor?: string;
    activeHoverColor?: string;
    isHovered: boolean = false;
    tooltip?: string;
    activeTooltip?: string;
    isToggled?: (node: LGraphNode) => boolean;
    getTooltip?: (node: LGraphNode) => string;
    isPanelOpen?: (node: LGraphNode) => boolean;
    isSelectedForDeletion?: (node: LGraphNode) => boolean;
    onClick: (e?: MouseEvent) => void;

    constructor(
        x: number,
        y: number,
        width: number,
        height: number,
        label: string,
        color: string,
        hoverColor: string,
        onClick: (e?: MouseEvent) => void,
        tooltip?: string,
        isToggled?: (node: LGraphNode) => boolean,
        activeColor?: string,
        activeHoverColor?: string,
        activeTooltip?: string
    ) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.label = label;
        this.color = color;
        this.hoverColor = hoverColor;
        this.onClick = onClick;
        this.tooltip = tooltip;
        this.isToggled = isToggled;
        this.activeColor = activeColor;
        this.activeHoverColor = activeHoverColor;
        this.activeTooltip = activeTooltip;
    }

    draw(ctx: CanvasRenderingContext2D, node: LGraphNode) {
        const selected = Boolean(this.isSelectedForDeletion?.(node));
        const panelOpen = Boolean(this.isPanelOpen?.(node));
        const toggled = Boolean(this.isToggled?.(node));

        const baseColor = toggled ? (this.activeColor || this.color) : this.color;
        const hoverColor = toggled ? (this.activeHoverColor || this.hoverColor) : this.hoverColor;
        const fillColor = selected ? "#db2777" : (this.isHovered ? hoverColor : baseColor);
        const strokeColor = selected ? "#f472b6" : (panelOpen ? "#c084fc" : null);

        // Handle negative x/y as right/bottom offsets
        const finalX = this.x < 0 ? node.size[0] + this.x : this.x;
        const finalY = this.y < 0 ? node.size[1] + this.y : this.y;

        const radius = 3;
        ctx.beginPath();
        if ((ctx as any).roundRect) {
            (ctx as any).roundRect(finalX, finalY, this.width, this.height, radius);
        } else {
            ctx.rect(finalX, finalY, this.width, this.height);
        }
        ctx.fillStyle = fillColor;
        ctx.fill();

        if (strokeColor) {
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = selected ? 2.0 : 1.75;
            ctx.stroke();
        }

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const isCompactText = this.label.length > 1 && this.height <= 14;
        ctx.font = isCompactText ? "700 8.5px Inter, system-ui, sans-serif" : "bold 11px sans-serif";
        ctx.fillText(this.label, finalX + this.width / 2, finalY + this.height / 2 + (isCompactText ? 0.5 : 1));
    }

    resolveTooltip(node: LGraphNode): string | undefined {
        if (this.isSelectedForDeletion?.(node)) {
            return `${this.label} (Selected): Press Backspace/Delete or right-click Delete to reset`;
        }
        if (this.isPanelOpen?.(node)) {
            return `${this.label} (Panel Open)`;
        }
        if (this.getTooltip) return this.getTooltip(node);
        if (this.isToggled?.(node) && this.activeTooltip) return this.activeTooltip;
        return this.tooltip;
    }

    checkHit(local_x: number, local_y: number, node: LGraphNode, paddingX: number = 0, paddingY: number = 0): boolean {
        const finalX = this.x < 0 ? node.size[0] + this.x : this.x;
        const finalY = this.y < 0 ? node.size[1] + this.y : this.y;

        return (
            local_x >= finalX - paddingX &&
            local_x <= finalX + this.width + paddingX &&
            local_y >= finalY - paddingY &&
            local_y <= finalY + this.height + paddingY
        );
    }
}
