/**
 * Fast waveform peak extraction and decimation.
 * Extracts interleaved [min, max] pairs for each horizontal column.
 */
export function extractPeaksFromBuffer(
    buffer: AudioBuffer,
    targetColumns: number
): Float32Array {
    const columns = Math.max(1, Math.floor(targetColumns));
    const peaks = new Float32Array(columns * 2);
    const numChannels = buffer.numberOfChannels;
    const channelDataList: Float32Array[] = [];

    for (let c = 0; c < numChannels; c++) {
        channelDataList.push(buffer.getChannelData(c));
    }

    const totalSamples = buffer.length;
    const step = totalSamples / columns;

    for (let col = 0; col < columns; col++) {
        const start = Math.floor(col * step);
        const end = Math.min(totalSamples, Math.floor((col + 1) * step));

        let min = 1.0;
        let max = -1.0;

        for (let i = start; i < end; i++) {
            for (let c = 0; c < numChannels; c++) {
                const sample = channelDataList[c][i];
                if (sample < min) min = sample;
                if (sample > max) max = sample;
            }
        }

        if (start >= end) {
            min = 0;
            max = 0;
        }

        peaks[col * 2] = min;
        peaks[col * 2 + 1] = max;
    }

    return peaks;
}

export function extractPeaksFromRawChannel(
    channelData: Float32Array,
    targetColumns: number
): Float32Array {
    const columns = Math.max(1, Math.floor(targetColumns));
    const peaks = new Float32Array(columns * 2);
    const totalSamples = channelData.length;
    const step = totalSamples / columns;

    for (let col = 0; col < columns; col++) {
        const start = Math.floor(col * step);
        const end = Math.min(totalSamples, Math.floor((col + 1) * step));

        let min = 1.0;
        let max = -1.0;

        for (let i = start; i < end; i++) {
            const sample = channelData[i];
            if (sample < min) min = sample;
            if (sample > max) max = sample;
        }

        if (start >= end) {
            min = 0;
            max = 0;
        }

        peaks[col * 2] = min;
        peaks[col * 2 + 1] = max;
    }

    return peaks;
}
