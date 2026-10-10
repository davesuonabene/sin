export type NodeShape = 'circle' | 'triangle' | 'pentagon' | 'square' | 'diamond';

export type NeonIcon =
    | 'mixer'
    | 'sequence'
    | 'sample'
    | 'arrangement'
    | 'pulse'
    | 'search'
    | 'warning'
    | 'speaker'
    | 'shuffle'
    | 'wave'
    | 'target'
    | 'spark';

export const NODE_SHAPES: NodeShape[] = ['circle', 'triangle', 'pentagon', 'square', 'diamond'];

export const NEON_ICONS: Array<{ id: NeonIcon; label: string }> = [
    { id: 'sample', label: 'Sample' },
    { id: 'mixer', label: 'Mixer' },
    { id: 'sequence', label: 'Sequence' },
    { id: 'arrangement', label: 'Arrangement' },
    { id: 'pulse', label: 'Pulse' },
    { id: 'search', label: 'Search' },
    { id: 'speaker', label: 'Speaker' },
    { id: 'shuffle', label: 'Shuffle' },
    { id: 'wave', label: 'Wave' },
    { id: 'target', label: 'Target' },
    { id: 'spark', label: 'Spark' },
    { id: 'warning', label: 'Warning' }
];

const legacyIcons: Record<string, NeonIcon> = {
    '🎛️': 'mixer',
    '🎹': 'sequence',
    '🎵': 'sample',
    '🎼': 'arrangement',
    '⚡': 'pulse',
    '⌕': 'search',
    '⚠': 'warning',
    '🔊': 'speaker',
    '🔀': 'shuffle',
    '🌊': 'wave',
    '🎯': 'target',
    '🔮': 'spark'
};

export function normalizeNeonIcon(value: unknown, fallback: NeonIcon = 'mixer'): NeonIcon {
    const icon = String(value || '');
    if (NEON_ICONS.some(preset => preset.id === icon)) return icon as NeonIcon;
    return legacyIcons[icon] || fallback;
}

export function normalizeNodeShape(value: unknown, fallback: NodeShape = 'square'): NodeShape {
    const shape = String(value || '').toLowerCase();
    if (shape === 'triang') return 'triangle';
    if (shape === 'pentag') return 'pentagon';
    if (shape === 'rotated-square' || shape === 'rotated_square') return 'diamond';
    return NODE_SHAPES.includes(shape as NodeShape) ? shape as NodeShape : fallback;
}

export function traceNodeShape(
    ctx: CanvasRenderingContext2D,
    shape: NodeShape,
    x: number,
    y: number,
    size: number
): void {
    const cx = x + size / 2;
    const cy = y + size / 2;
    const inset = shape === 'diamond' ? size * 0.04 : 0;
    const radius = size / 2 - inset;

    ctx.beginPath();
    if (shape === 'circle') {
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        return;
    }
    if (shape === 'square') {
        ctx.rect(x, y, size, size);
        return;
    }

    const sides = shape === 'triangle' ? 3 : shape === 'pentagon' ? 5 : 4;
    const startAngle = shape === 'diamond' ? -Math.PI / 2 : -Math.PI / 2;
    for (let index = 0; index < sides; index += 1) {
        const angle = startAngle + index * Math.PI * 2 / sides;
        const px = cx + Math.cos(angle) * radius;
        const py = cy + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.closePath();
}

export function drawNeonIcon(
    ctx: CanvasRenderingContext2D,
    iconValue: unknown,
    centerX: number,
    centerY: number,
    size: number,
    color = '#f8fafc'
): void {
    const icon = normalizeNeonIcon(iconValue);
    const scale = size / 24;
    const x = (value: number) => centerX + (value - 12) * scale;
    const y = (value: number) => centerY + (value - 12) * scale;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.35, 1.75 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    switch (icon) {
        case 'mixer':
            [[6, 8], [12, 15], [18, 10]].forEach(([lineX, knobY]) => {
                ctx.moveTo(x(lineX), y(4)); ctx.lineTo(x(lineX), y(20));
                ctx.moveTo(x(lineX - 2), y(knobY)); ctx.lineTo(x(lineX + 2), y(knobY));
            });
            ctx.stroke();
            break;
        case 'sequence':
            [5, 10, 15, 20].forEach((stepX, index) => {
                const top = index % 2 === 0 ? 7 : 11;
                ctx.rect(x(stepX - 1.5), y(top), 3 * scale, (18 - top) * scale);
            });
            ctx.stroke();
            break;
        case 'sample':
            ctx.moveTo(x(9), y(18)); ctx.lineTo(x(9), y(6)); ctx.lineTo(x(18), y(4)); ctx.lineTo(x(18), y(15));
            ctx.stroke();
            ctx.beginPath(); ctx.ellipse(x(6.5), y(18), 2.5 * scale, 1.8 * scale, -0.2, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.ellipse(x(15.5), y(15), 2.5 * scale, 1.8 * scale, -0.2, 0, Math.PI * 2); ctx.stroke();
            break;
        case 'arrangement':
            ctx.moveTo(x(4), y(17)); ctx.lineTo(x(4), y(9)); ctx.lineTo(x(9), y(9)); ctx.lineTo(x(9), y(5));
            ctx.lineTo(x(14), y(5)); ctx.lineTo(x(14), y(12)); ctx.lineTo(x(20), y(12)); ctx.lineTo(x(20), y(19));
            ctx.stroke();
            break;
        case 'pulse':
            ctx.moveTo(x(3), y(13)); ctx.lineTo(x(8), y(13)); ctx.lineTo(x(11), y(6)); ctx.lineTo(x(14), y(18)); ctx.lineTo(x(17), y(11)); ctx.lineTo(x(21), y(11));
            ctx.stroke();
            break;
        case 'search':
            ctx.arc(x(10), y(10), 5 * scale, 0, Math.PI * 2); ctx.moveTo(x(14), y(14)); ctx.lineTo(x(20), y(20)); ctx.stroke();
            break;
        case 'warning':
            ctx.moveTo(x(12), y(4)); ctx.lineTo(x(21), y(20)); ctx.lineTo(x(3), y(20)); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x(12), y(9)); ctx.lineTo(x(12), y(14)); ctx.stroke();
            ctx.beginPath(); ctx.arc(x(12), y(17), 0.7 * scale, 0, Math.PI * 2); ctx.fill();
            break;
        case 'speaker':
            ctx.moveTo(x(4), y(10)); ctx.lineTo(x(8), y(10)); ctx.lineTo(x(13), y(6)); ctx.lineTo(x(13), y(18)); ctx.lineTo(x(8), y(14)); ctx.lineTo(x(4), y(14)); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.arc(x(13), y(12), 5 * scale, -0.8, 0.8); ctx.stroke();
            break;
        case 'shuffle':
            ctx.moveTo(x(4), y(7)); ctx.lineTo(x(8), y(7)); ctx.bezierCurveTo(x(13), y(7), x(13), y(17), x(19), y(17));
            ctx.moveTo(x(16), y(14)); ctx.lineTo(x(20), y(17)); ctx.lineTo(x(16), y(20));
            ctx.moveTo(x(4), y(17)); ctx.lineTo(x(8), y(17)); ctx.bezierCurveTo(x(12), y(17), x(13), y(7), x(19), y(7));
            ctx.stroke();
            break;
        case 'wave':
            ctx.moveTo(x(3), y(12));
            for (let px = 4; px <= 21; px += 1) ctx.lineTo(x(px), y(12 + Math.sin((px - 3) * Math.PI / 4) * 4));
            ctx.stroke();
            break;
        case 'target':
            ctx.arc(x(12), y(12), 8 * scale, 0, Math.PI * 2); ctx.moveTo(x(16), y(12)); ctx.arc(x(12), y(12), 4 * scale, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(x(12), y(12), 1.2 * scale, 0, Math.PI * 2); ctx.fill();
            break;
        case 'spark':
            ctx.moveTo(x(12), y(3)); ctx.lineTo(x(14), y(10)); ctx.lineTo(x(21), y(12)); ctx.lineTo(x(14), y(14)); ctx.lineTo(x(12), y(21)); ctx.lineTo(x(10), y(14)); ctx.lineTo(x(3), y(12)); ctx.lineTo(x(10), y(10)); ctx.closePath(); ctx.stroke();
            break;
    }
    ctx.restore();
}
