import { type BaseNode } from '../../nodes/BaseNode';
import { WaveformVisualizer } from '../WaveformVisualizer';

export class WaveformCropSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        container.innerHTML = `
            <div class="waveform-crop-wrapper" style="display: flex; flex-direction: column; gap: 8px;">
                <div class="waveform-visualizer" style="height: 120px; background: #0f172a; border-radius: 6px; position: relative; overflow: hidden;"></div>
                <div class="crop-time-display" style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; font-family: monospace;">
                    <span class="crop-time-start">0.00s</span>
                    <span class="crop-time-end">0.00s</span>
                </div>
            </div>
        `;

        const visContainer = container.querySelector('.waveform-visualizer') as HTMLElement;
        const timeStartEl = container.querySelector('.crop-time-start') as HTMLElement;
        const timeEndEl = container.querySelector('.crop-time-end') as HTMLElement;

        if (!visContainer) return;

        const updateTimeLabels = (s: number, e: number) => {
            const dur = node.properties.duration_seconds || 0;
            if (dur > 0 && timeStartEl && timeEndEl) {
                timeStartEl.textContent = `Start: ${(s * dur).toFixed(2)}s`;
                timeEndEl.textContent = `End: ${(e * dur).toFixed(2)}s`;
            }
        };

        const visualizer = new WaveformVisualizer({
            container: visContainer,
            cropStart: node.properties.crop_start || 0.0,
            cropEnd: node.properties.crop_end || 1.0,
            onCropChange: (s: number, e: number) => {
                node.updateProperty('crop_start', s);
                node.updateProperty('crop_end', e);
                updateTimeLabels(s, e);
                windowContext.refreshAudioPreview();
            }
        });

        windowContext.currentWaveformVisualizer = visualizer;

        const filepath = node.properties.filepath;
        if (filepath) {
            await visualizer.loadAudio(filepath);
            updateTimeLabels(visualizer.getCrop().start, visualizer.getCrop().end);
        }
    }
}
