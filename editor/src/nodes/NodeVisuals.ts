export type NodeShape = 'source' | 'through' | 'sink' | 'isolated';

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

function resolveBorderRadii(shape: NodeShape, width: number, height: number): { leftR: number; rightR: number } {
    const maxR = Math.max(0, Math.min(width / 2, height / 2));
    const rFlat = Math.min(4, maxR);
    const rCurve = Math.abs(width - height) < 0.001 ? maxR : Math.min(22, Math.round(height * 0.32), maxR);
    return {
        leftR: (shape === 'source' || shape === 'isolated') ? rCurve : rFlat,
        rightR: (shape === 'sink' || shape === 'isolated') ? rCurve : rFlat
    };
}

export function traceNodeShape(
    ctx: CanvasRenderingContext2D,
    shape: NodeShape,
    x: number,
    y: number,
    width: number,
    height: number = width
): void {
    const { leftR, rightR } = resolveBorderRadii(shape, width, height);
    ctx.beginPath();
    ctx.moveTo(x + leftR, y);
    ctx.lineTo(x + width - rightR, y);
    ctx.arcTo(x + width, y, x + width, y + rightR, rightR);
    ctx.lineTo(x + width, y + height - rightR);
    ctx.arcTo(x + width, y + height, x + width - rightR, y + height, rightR);
    ctx.lineTo(x + leftR, y + height);
    ctx.arcTo(x, y + height, x, y + height - leftR, leftR);
    ctx.lineTo(x, y + leftR);
    ctx.arcTo(x, y, x + leftR, y, leftR);
    ctx.closePath();
}

export function getNodeShapePerimeter(shape: NodeShape, width: number, height: number = width): number {
    const { leftR, rightR } = resolveBorderRadii(shape, width, height);
    return 2 * (width + height) - (4 - Math.PI) * (leftR + rightR);
}

export function drawPerimeterProgressAccent(
    ctx: CanvasRenderingContext2D,
    shape: NodeShape,
    x: number,
    y: number,
    size: number,
    progress: number,
    color: string,
    lineWidth = 2.25
): void {
    const clamped = Math.max(0, Math.min(1, progress));
    if (clamped <= 0.001) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const perimeter = getNodeShapePerimeter(shape, size, size);
    ctx.setLineDash?.([perimeter * clamped, perimeter]);
    traceNodeShape(ctx, shape, x, y, size, size);
    ctx.stroke();
    ctx.setLineDash?.([]);
    ctx.restore();
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
