/**
 * Zero-RAM, zoom-dynamic per-track waveform peak resolver for the Horizontal Timeline View.
 *
 * Resolution order per lane (preferring highest dynamic precision for the active viewport):
 * 1. Active tiled overlay (`TimelineTileOverlayStore`, refreshed via `query_peaks` on zoom/resize)
 * 2. Viewport-sliced in-memory `AudioBuffer` (`manifestStemBuffer` / `_lastRenderedBuffer` / `getAudioBuffer()`)
 *    for sample-accurate continuous zoom on short clips & stems
 * 3. Active realtime peak-pyramid viewport slice (for long >60s files even without RX nodes)
 * 4. High-res server-side `/api/audio/peaks` (`zoomSlice` when zoomed, or `overview` when >= resolution)
 * 5. Instant overview fallback (`trackNode.realtimePeaks` / `activeRealtimeMasterPeaks`) while async peaks load
 */

import { fetchAudioPeaks } from '../audioBufferCache.ts';
import { type TimelineTrackLane, type TimelineTileOverlayStore } from './timelineModel.ts';

export interface ResolvedTrackPeaks {
    peaks: Float32Array; // interleaved [min0, max0, min1, max1, ...]
    startSec: number;
    endSec: number;
    tiers: Uint8Array | null;
    isTiled: boolean;
}

interface CachedFilePeaks {
    filepath: string;
    peaks: Float32Array;
    startSec: number;
    endSec: number;
    durationSec: number;
    columns: number;
}

interface CachedFileEntry {
    overview: CachedFilePeaks;
    zoomSlice: CachedFilePeaks | null;
}

interface PyramidViewportPeaks {
    peaks: Float32Array;
    startSec: number;
    endSec: number;
    durationSec: number;
    columns: number;
}

export class TimelineWaveformCache {
    private readonly filePeaks = new Map<string, CachedFileEntry>();
    private readonly fileDurations = new Map<string, number>();
    private readonly pendingFetches = new Set<string>();
    private pyramidViewport: PyramidViewportPeaks | null = null;
    private onPeaksReady: ((durationChanged: boolean) => void) | null = null;
    private zoomTimer: number | null = null;

    constructor(onPeaksReady?: (durationChanged: boolean) => void) {
        this.onPeaksReady = onPeaksReady || null;
    }

    public getKnownDurations(): ReadonlyMap<string, number> {
        return this.fileDurations;
    }

    public setPyramidViewportPeaks(peaks: number[] | Float32Array, startSec: number, endSec: number, durationSec: number): void {
        const arr = peaks instanceof Float32Array ? peaks : Float32Array.from(peaks || []);
        const pairs = Math.floor(arr.length / 2);
        if (pairs <= 0 || endSec <= startSec) return;
        this.pyramidViewport = {
            peaks: arr,
            startSec,
            endSec,
            durationSec: Math.max(durationSec, endSec),
            columns: pairs,
        };
    }

    public clearPyramidViewportPeaks(): void {
        this.pyramidViewport = null;
    }

    public clear(): void {
        this.filePeaks.clear();
        this.pendingFetches.clear();
        this.pyramidViewport = null;
        if (this.zoomTimer !== null) {
            window.clearTimeout(this.zoomTimer);
            this.zoomTimer = null;
        }
    }

    public dispose(): void {
        this.clear();
        this.onPeaksReady = null;
    }

    /**
     * Requests crisp zoom-dynamic peaks for any non-tiled Sample clips visible in `[viewStartSec..viewEndSec]`.
     */
    public scheduleViewportFetch(
        lanes: readonly TimelineTrackLane[],
        tileStore: TimelineTileOverlayStore,
        viewStartSec: number,
        viewEndSec: number,
        columns: number,
        zoom: number = 1
    ): void {
        if (this.zoomTimer !== null) {
            window.clearTimeout(this.zoomTimer);
        }
        this.zoomTimer = window.setTimeout(() => {
            this.zoomTimer = null;
            this.fetchMissingSamplePeaks(lanes, tileStore, viewStartSec, viewEndSec, columns, zoom);
        }, 70);
    }

    public fetchMissingSamplePeaks(
        lanes: readonly TimelineTrackLane[],
        tileStore: TimelineTileOverlayStore,
        viewStartSec: number,
        viewEndSec: number,
        columns: number,
        zoom: number = 1
    ): void {
        const cols = Math.max(256, Math.min(2048, Math.round(columns || 512)));
        for (const lane of lanes) {
            if (tileStore.isLaneTiled(lane)) continue;
            if (lane.clips.length !== 1) continue;
            const clip = lane.clips[0];
            if (!clip.filepath) continue;

            const existing = this.filePeaks.get(clip.filepath);
            const clipSrcDur = clip.sourceDurationSec > 0 ? clip.sourceDurationSec : (existing?.overview.durationSec || 0);
            const wantStart = clipSrcDur > 0
                ? Math.max(0, clip.cropStart * clipSrcDur + Math.max(0, viewStartSec - clip.startSec) * clip.playbackRate)
                : 0;
            const wantEnd = clipSrcDur > 0
                ? Math.min(clipSrcDur, clip.cropStart * clipSrcDur + Math.max(0.02, viewEndSec - clip.startSec) * clip.playbackRate)
                : 0;

            // Refetch overview if missing OR viewport grew significantly wider than cached overview columns
            const needOverview = !existing || (zoom <= 1.05 && existing.overview.columns < cols * 0.72);
            const wantSpan = Math.max(0, wantEnd - wantStart);
            const isActuallyZoomed = zoom > 1.05 && clipSrcDur > 5 && wantSpan > 0.01 && wantSpan < clipSrcDur * 0.92;
            const curZoom = existing?.zoomSlice;
            const needZoomRefetch = Boolean(
                existing
                && isActuallyZoomed
                && (!curZoom
                    || curZoom.columns < cols * 0.72
                    || Math.abs(curZoom.startSec - wantStart) > wantSpan * 0.06
                    || Math.abs(curZoom.endSec - wantEnd) > wantSpan * 0.06)
            );
            if (!needOverview && !needZoomRefetch) continue;

            const fetchStart = needZoomRefetch ? wantStart : 0;
            const fetchEnd = needZoomRefetch ? wantEnd : 0;
            const reqKey = needZoomRefetch
                ? `${clip.filepath}|z|${cols}|${Math.round(fetchStart * 100)}|${Math.round(fetchEnd * 100)}`
                : `${clip.filepath}|ov|${cols}`;
            if (this.pendingFetches.has(reqKey)) continue;
            this.pendingFetches.add(reqKey);

            void fetchAudioPeaks(clip.filepath, {
                columns: cols,
                startSec: fetchStart,
                endSec: fetchEnd,
            }).then((res) => {
                this.pendingFetches.delete(reqKey);
                if (!res || res.peaks.length < 2) return;
                const peakObj: CachedFilePeaks = {
                    filepath: clip.filepath,
                    peaks: res.peaks,
                    startSec: res.startSec,
                    endSec: res.endSec,
                    durationSec: res.durationSeconds,
                    columns: Math.floor(res.peaks.length / 2),
                };
                const prev = this.filePeaks.get(clip.filepath);
                if (needZoomRefetch && prev) {
                    prev.zoomSlice = peakObj;
                } else {
                    this.filePeaks.set(clip.filepath, {
                        overview: peakObj,
                        zoomSlice: prev?.zoomSlice ?? null,
                    });
                }
                const prevDur = this.fileDurations.get(clip.filepath) || 0;
                let durationChanged = false;
                if (res.durationSeconds > 0 && Math.abs(res.durationSeconds - prevDur) > 0.05) {
                    this.fileDurations.set(clip.filepath, res.durationSeconds);
                    durationChanged = true;
                }
                this.onPeaksReady?.(durationChanged);
            }).catch(() => {
                this.pendingFetches.delete(reqKey);
            });
        }
    }

    public resolveTrackPeaks(
        lane: TimelineTrackLane,
        trackNode: any,
        tileStore: TimelineTileOverlayStore,
        totalDurationSec: number,
        viewStartSec: number,
        viewEndSec: number,
        columns: number
    ): ResolvedTrackPeaks | null {
        const viewSpan = Math.max(1e-4, viewEndSec - viewStartSec);
        const safeCols = Math.max(64, Math.min(4096, Math.round(columns || 512)));

        // 1. Active tiled overlay (dual-color baked/unbaked, refreshed dynamically via query_peaks)
        const tileEntry = tileStore.getEntryForLane(lane);
        if (tileEntry && tileEntry.peaks && tileEntry.peaks.length >= 2) {
            const tiers = tileStore.resolveColumnTiers(tileEntry, viewStartSec, viewEndSec, safeCols);
            return {
                peaks: tileEntry.peaks,
                startSec: tileEntry.peaksStartSec,
                endSec: tileEntry.peaksEndSec > tileEntry.peaksStartSec ? tileEntry.peaksEndSec : (tileEntry.durationSec || totalDurationSec),
                tiers,
                isTiled: true,
            };
        }

        // 2. Viewport-sliced in-memory AudioBuffer (infinite sample-accurate zoom for short audio/stems!)
        const buf: AudioBuffer | null = trackNode?.manifestStemBuffer
            || trackNode?._lastRenderedBuffer
            || (typeof trackNode?.getAudioBuffer === 'function' ? trackNode.getAudioBuffer() : null);
        if (buf && buf.length > 0 && buf.duration > 0) {
            const s0 = Math.max(0, Math.min(buf.duration, viewStartSec));
            const s1 = Math.max(s0 + 1e-5, Math.min(buf.duration, viewEndSec));
            if (s1 > s0 && viewEndSec > 0 && viewStartSec < buf.duration) {
                const sliceCols = Math.max(16, Math.round(((s1 - s0) / viewSpan) * safeCols));
                const peaks = extractViewportPeaksFromAudioBuffer(buf, s0, s1, sliceCols);
                if (peaks.length >= 2) {
                    return {
                        peaks,
                        startSec: s0,
                        endSec: s1,
                        tiers: null,
                        isTiled: false,
                    };
                }
            }
        }

        // 3. Active realtime peak-pyramid viewport slice (crisp dynamic zoom on long >60s files)
        const pyr = this.pyramidViewport;
        if (
            pyr
            && pyr.peaks.length >= 2
            && (lane.isMainPreview || lane.isMasterRoot || lane.clips.length === 1)
            && pyr.startSec <= viewStartSec + viewSpan * 0.2
            && pyr.endSec >= viewEndSec - viewSpan * 0.2
        ) {
            return {
                peaks: pyr.peaks,
                startSec: pyr.startSec,
                endSec: pyr.endSec,
                tiers: null,
                isTiled: false,
            };
        }

        // 4. Server-side cached high-res file peaks for single-sample direct tracks (zoom slice preferred when zoomed!)
        let fileResolved: ResolvedTrackPeaks | null = null;
        let fileResolvedDensity = 0;
        if (lane.clips.length === 1 && lane.clips[0].filepath) {
            const clip = lane.clips[0];
            const entry = this.filePeaks.get(clip.filepath);
            if (entry) {
                const rate = Math.max(0.05, clip.playbackRate);
                const ov = entry.overview;
                const zs = entry.zoomSlice;
                const cropStartSec = clip.cropStart * ov.durationSec;
                const wantSrcStart = cropStartSec + Math.max(0, viewStartSec - clip.startSec) * rate;
                const wantSrcEnd = cropStartSec + Math.max(0.02, viewEndSec - clip.startSec) * rate;
                const wantSpan = Math.max(1e-4, wantSrcEnd - wantSrcStart);
                const useZoom = Boolean(
                    zs
                    && zs.peaks.length >= 2
                    && zs.durationSec > 0
                    && zs.startSec <= wantSrcStart + wantSpan * 0.12
                    && zs.endSec >= wantSrcEnd - wantSpan * 0.12
                );
                const cached = useZoom ? zs! : ov;
                if (cached && cached.peaks.length >= 2 && cached.durationSec > 0) {
                    const tlStart = clip.startSec + (cached.startSec - cropStartSec) / rate;
                    const tlEnd = Math.max(tlStart + 0.01, clip.startSec + (cached.endSec - cropStartSec) / rate);
                    fileResolvedDensity = (cached.peaks.length / 2) / Math.max(1e-4, tlEnd - tlStart);
                    fileResolved = {
                        peaks: cached.peaks,
                        startSec: tlStart,
                        endSec: tlEnd,
                        tiers: null,
                        isTiled: false,
                    };
                    if (useZoom) {
                        return fileResolved;
                    }
                }
            }
        }

        // 5. Live backend post-FX bus peaks (node.realtimePeaks) — compare density against file overview
        if (trackNode?.realtimePeaks instanceof Float32Array && trackNode.realtimePeaks.length >= 2) {
            const dur = Number(trackNode.realtimePeaksDuration) > 0
                ? Number(trackNode.realtimePeaksDuration)
                : totalDurationSec;
            const rtDensity = (trackNode.realtimePeaks.length / 2) / Math.max(1e-4, dur);
            if (fileResolved && fileResolvedDensity > rtDensity * 1.15) {
                return fileResolved;
            }
            return {
                peaks: trackNode.realtimePeaks,
                startSec: 0,
                endSec: dur,
                tiers: null,
                isTiled: false,
            };
        }

        if (fileResolved) {
            return fileResolved;
        }

        // 6. Direct master peaks fallback on primary Master root if bus peaks haven't populated yet
        if (lane.isMainPreview && typeof window !== 'undefined') {
            const masterPeaks = (window as any).activeRealtimeMasterPeaks;
            const masterDur = Number((window as any).activeRealtimeMasterDuration) || totalDurationSec;
            if (masterPeaks instanceof Float32Array && masterPeaks.length >= 2) {
                return {
                    peaks: masterPeaks,
                    startSec: 0,
                    endSec: masterDur,
                    tiers: null,
                    isTiled: false,
                };
            }
        }

        return null;
    }
}

const bufferSliceCache = new WeakMap<AudioBuffer, { key: string; peaks: Float32Array }>();

export function extractViewportPeaksFromAudioBuffer(
    buffer: AudioBuffer,
    startSec: number,
    endSec: number,
    columns: number
): Float32Array {
    const cols = Math.max(1, Math.floor(columns));
    const totalSamples = buffer.length;
    const sr = buffer.sampleRate || 44100;
    if (totalSamples <= 0 || endSec <= startSec) return new Float32Array(0);

    const fStart = Math.max(0, Math.min(totalSamples - 1, Math.floor(startSec * sr)));
    const fEnd = Math.max(fStart + 1, Math.min(totalSamples, Math.ceil(endSec * sr)));
    const cacheKey = `${fStart}:${fEnd}:${cols}`;
    const cached = bufferSliceCache.get(buffer);
    if (cached && cached.key === cacheKey) {
        return cached.peaks;
    }

    const frameSpan = fEnd - fStart;
    const out = new Float32Array(cols * 2);
    const numCh = buffer.numberOfChannels;
    const channels = Array.from({ length: numCh }, (_, c) => buffer.getChannelData(c));
    const samplesPerCol = frameSpan / cols;

    if (samplesPerCol <= 1.25) {
        // Sample-accurate continuous curve when zoomed into individual cycles
        for (let i = 0; i < cols; i++) {
            const pos = fStart + (i / Math.max(1, cols - 1)) * Math.max(0, frameSpan - 1);
            const idx0 = Math.max(0, Math.min(totalSamples - 1, Math.floor(pos)));
            const idx1 = Math.min(totalSamples - 1, idx0 + 1);
            const frac = pos - idx0;
            let v = 0;
            for (let c = 0; c < numCh; c++) {
                const ch = channels[c];
                v += (ch[idx0] || 0) * (1 - frac) + (ch[idx1] || 0) * frac;
            }
            v /= numCh;
            out[i * 2] = v;
            out[i * 2 + 1] = v;
        }
        bufferSliceCache.set(buffer, { key: cacheKey, peaks: out });
        return out;
    }

    const stride = samplesPerCol > 128 ? Math.max(1, Math.floor(samplesPerCol / 48)) : 1;
    for (let i = 0; i < cols; i++) {
        const s0 = fStart + Math.floor((i / cols) * frameSpan);
        const s1 = Math.min(fEnd, Math.max(s0 + 1, fStart + Math.ceil(((i + 1) / cols) * frameSpan)));
        let mn = 1;
        let mx = -1;
        for (let s = s0; s < s1; s += stride) {
            let sum = 0;
            for (let c = 0; c < numCh; c++) {
                sum += channels[c][s] || 0;
            }
            const v = sum / numCh;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        if (mn > mx) { mn = 0; mx = 0; }
        out[i * 2] = mn;
        out[i * 2 + 1] = mx;
    }
    bufferSliceCache.set(buffer, { key: cacheKey, peaks: out });
    return out;
}

export function extractInterleavedPeaksFromAudioBuffer(buffer: AudioBuffer, columns: number): Float32Array {
    return extractViewportPeaksFromAudioBuffer(buffer, 0, buffer.duration, columns);
}

/**
 * Sample interleaved `[min, max]` peaks mapped onto `[peaksStartSec..peaksEndSec]`
 * into a 1D per-column `[min, max]` envelope across `[viewStartSec..viewEndSec]`.
 *
 * Uses true min/max envelope reduction when downsampling (`pairs >= cols`) and smooth linear
 * interpolation when upsampling (`pairs < cols`) so waveforms never render as stairstep blocks.
 */
export function samplePeaksForColumns(
    peaks: Float32Array,
    peaksStartSec: number,
    peaksEndSec: number,
    viewStartSec: number,
    viewEndSec: number,
    columns: number,
    outMin: Float32Array,
    outMax: Float32Array
): void {
    outMin.fill(0);
    outMax.fill(0);
    const pairCount = Math.floor(peaks.length / 2);
    if (pairCount <= 0 || columns <= 0) return;
    const pSpan = peaksEndSec - peaksStartSec;
    const vSpan = viewEndSec - viewStartSec;
    if (pSpan <= 1e-5 || vSpan <= 1e-5) return;

    const pairsPerPixel = (pairCount * (vSpan / pSpan)) / columns;

    if (pairsPerPixel < 0.95 && pairCount > 1) {
        // Smooth linear interpolation (no flat horizontal blocks while zoomed or awaiting high-res fetch)
        for (let x = 0; x < columns; x++) {
            const tMid = viewStartSec + ((x + 0.5) / columns) * vSpan;
            if (tMid < peaksStartSec || tMid > peaksEndSec) continue;
            const pos = ((tMid - peaksStartSec) / pSpan) * (pairCount - 1);
            const i0 = Math.max(0, Math.min(pairCount - 1, Math.floor(pos)));
            const i1 = Math.min(pairCount - 1, i0 + 1);
            const f = pos - i0;
            const lo = peaks[i0 * 2] * (1 - f) + peaks[i1 * 2] * f;
            const hi = peaks[i0 * 2 + 1] * (1 - f) + peaks[i1 * 2 + 1] * f;
            outMin[x] = Math.max(-1, Math.min(1, lo));
            outMax[x] = Math.max(-1, Math.min(1, hi));
        }
        return;
    }

    for (let x = 0; x < columns; x++) {
        const t0 = viewStartSec + (x / columns) * vSpan;
        const t1 = viewStartSec + ((x + 1) / columns) * vSpan;
        if (t1 <= peaksStartSec || t0 >= peaksEndSec) continue;
        const i0 = Math.max(0, Math.min(pairCount - 1, Math.floor(((t0 - peaksStartSec) / pSpan) * pairCount)));
        const i1 = Math.max(i0 + 1, Math.min(pairCount, Math.ceil(((t1 - peaksStartSec) / pSpan) * pairCount)));
        let mn = 1;
        let mx = -1;
        for (let i = i0; i < i1; i++) {
            const lo = peaks[i * 2];
            const hi = peaks[i * 2 + 1];
            if (lo < mn) mn = lo;
            if (hi > mx) mx = hi;
        }
        if (mn <= mx) {
            outMin[x] = Math.max(-1, Math.min(1, mn));
            outMax[x] = Math.max(-1, Math.min(1, mx));
        }
    }
}
