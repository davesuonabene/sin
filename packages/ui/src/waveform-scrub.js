export function downsamplePeakPairs(pairs, columns) {
  const count = Math.max(0, Math.floor(Number(columns) || 0));
  if (count === 0 || !Array.isArray(pairs) || pairs.length === 0) {
    return new Float32Array(0);
  }
  const out = new Float32Array(count);
  const srcLen = pairs.length;
  for (let x = 0; x < count; x++) {
    const startIdx = Math.floor((x / count) * srcLen);
    const endIdx = Math.max(startIdx + 1, Math.floor(((x + 1) / count) * srcLen));
    let peak = 0;
    for (let i = startIdx; i < endIdx && i < srcLen; i++) {
      const pair = pairs[i];
      if (!pair) continue;
      const lo = Math.abs(Number(pair[0]) || 0);
      const hi = Math.abs(Number(pair[1]) || 0);
      peak = Math.max(peak, lo, hi);
    }
    out[x] = Math.min(1, peak);
  }
  return out;
}

export function downsampleInterleavedPeaks(flat, columns) {
  const count = Math.max(0, Math.floor(Number(columns) || 0));
  const pairCount = Math.floor((flat?.length || 0) / 2);
  if (count === 0 || pairCount === 0) {
    return new Float32Array(0);
  }
  const out = new Float32Array(count);
  for (let x = 0; x < count; x++) {
    const startIdx = Math.floor((x / count) * pairCount);
    const endIdx = Math.max(startIdx + 1, Math.floor(((x + 1) / count) * pairCount));
    let peak = 0;
    for (let i = startIdx; i < endIdx && i < pairCount; i++) {
      const lo = Math.abs(Number(flat[i * 2]) || 0);
      const hi = Math.abs(Number(flat[i * 2 + 1]) || 0);
      peak = Math.max(peak, lo, hi);
    }
    out[x] = Math.min(1, peak);
  }
  return out;
}

function formatSec(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatTransportTime(seconds) {
  return formatSec(seconds);
}

// Direct dual-color processing tier palette:
// 0 = Raw Tier-1 (slate), 1 = Fast DSP (teal), 2 = Complex ML (violet), 3 = Stale hold (amber)
const TIER_COLORS = ['#94a3b8', '#0891b2', '#7c3aed', '#d97706'];
const TIER_RAIL_COLORS = ['rgba(148, 163, 184, 0.30)', '#06b6d4', '#8b5cf6', '#f59e0b'];
const TIER_BG_COLORS = [null, 'rgba(6, 182, 212, 0.11)', 'rgba(139, 92, 246, 0.13)', 'rgba(245, 158, 11, 0.15)'];
const COVERAGE_SLOTS = 256;

export class WaveformScrubCanvas {
  constructor(container, options = {}) {
    this.container = container;
    this.onSeek = typeof options.onSeek === 'function' ? options.onSeek : null;
    this.onSeekStart = typeof options.onSeekStart === 'function' ? options.onSeekStart : null;
    this.onSeekEnd = typeof options.onSeekEnd === 'function' ? options.onSeekEnd : null;
    this.onViewportChange = typeof options.onViewportChange === 'function' ? options.onViewportChange : null;
    this.enableZoom = Boolean(options.enableZoom);
    this.emptyMessage = options.emptyMessage || 'No audio';

    this.mode = 'empty'; // 'empty' | 'buffer' | 'interleaved' | 'pairs' | 'progress'
    this.audioBuffer = null;
    this.interleavedPeaks = null;
    this.tierStates = null; // Uint8Array aligned to interleavedPeaks pairs (0..3)
    this.coverageSlots = new Uint8Array(COVERAGE_SLOTS); // Full-timeline [0..duration] coverage map independent of peaks
    this.hasCoverage = false;
    this.peakPairs = null;
    this.knownDuration = 0;
    this.currentTime = 0;
    this.progress = 0;
    this.hoverProgress = null;
    this.isSeeking = false;
    this.isPanning = false;
    this.isScrollbarDragging = false;
    this.panAnchorX = 0;
    this.panAnchorStartSec = 0;
    this.cueSec = 0;
    this.cueActive = false;

    // Zoomable viewport [viewStartSec .. viewEndSec] inside [0 .. duration]
    this.zoom = 1;
    this.viewStartSec = 0;
    this.viewEndSec = 0;
    this.peaksStartSec = 0;
    this.peaksEndSec = 0;
    this._vpNotifyTimer = null;

    this.peakCache = null;
    this.peakCacheColumns = 0;
    this.peakCacheSource = null;
    this.tierCache = null;
    this._covCache = null;
    this._covCacheKey = '';
    this._peaksRev = 0;
    this._waveLayer = null;
    this._waveLayerKey = '';

    this.cachedCssWidth = 0;
    this.cachedCssHeight = 0;
    this.lastAriaSecond = -1;
    this.lastAriaDuration = -1;

    this.canvas = document.createElement('canvas');
    this.canvas.className = options.canvasClassName || 'ui-transport-timeline-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'slider');
    this.canvas.setAttribute('aria-label', options.ariaLabel || 'Audio timeline');
    this.canvas.setAttribute('aria-valuemin', '0');
    this.container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d');

    this._resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            this.cachedCssWidth = entry.contentRect.width;
            this.cachedCssHeight = entry.contentRect.height;
          } else {
            this.cachedCssWidth = 0;
            this.cachedCssHeight = 0;
          }
          this.draw();
        })
      : null;
    this._resizeObserver?.observe(this.container);

    this._onPointerDown = (event) => {
      if (this.duration <= 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const localY = event.clientY - rect.top;
      const isZoomed = this.zoom > 1.01;

      // Overview scrollbar hit along bottom 7px when zoomed
      if (event.button === 0 && isZoomed && localY >= rect.height - 7) {
        event.preventDefault();
        this.isScrollbarDragging = true;
        try { this.canvas.setPointerCapture(event.pointerId); } catch {}
        this._panViewportToScrollbarX(event.clientX - rect.left, rect.width);
        return;
      }

      // Middle-click or Shift+left-drag pans when zoomed
      if (isZoomed && (event.button === 1 || (event.button === 0 && event.shiftKey))) {
        event.preventDefault();
        this.isPanning = true;
        this.panAnchorX = event.clientX;
        this.panAnchorStartSec = this.viewStartSec;
        try { this.canvas.setPointerCapture(event.pointerId); } catch {}
        return;
      }

      if (event.button !== 0) return;
      event.preventDefault();
      this.isSeeking = true;
      this.canvas.focus({ preventScroll: true });
      try { this.canvas.setPointerCapture(event.pointerId); } catch {}
      const p = this._progressFromPointer(event);
      this.onSeekStart?.(p);
      this._applySeekPointer(p, true);
    };

    this._onPointerMove = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      if (this.isScrollbarDragging) {
        this._panViewportToScrollbarX(event.clientX - rect.left, rect.width);
        return;
      }
      if (this.isPanning && rect.width > 0) {
        const dx = event.clientX - this.panAnchorX;
        const span = Math.max(0.01, this.viewEndSec - this.viewStartSec);
        const deltaSec = -(dx / rect.width) * span;
        this._setViewport(this.panAnchorStartSec + deltaSec, span);
        return;
      }
      this.hoverProgress = this._progressFromPointer(event);
      if (this.isSeeking) {
        this._applySeekPointer(this.hoverProgress, true);
      } else {
        this.draw();
      }
    };

    this._onPointerUp = (event) => {
      if (this.isScrollbarDragging) {
        this.isScrollbarDragging = false;
        try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
        this._scheduleViewportNotify(true);
        return;
      }
      if (this.isPanning) {
        this.isPanning = false;
        try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
        this._scheduleViewportNotify(true);
        return;
      }
      if (!this.isSeeking) return;
      const p = this._progressFromPointer(event);
      this._applySeekPointer(p, false);
      this.isSeeking = false;
      try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
      this.onSeekEnd?.(p);
      this.draw();
    };

    this._onPointerCancel = () => {
      this.isPanning = false;
      this.isScrollbarDragging = false;
      if (!this.isSeeking) return;
      this.isSeeking = false;
      this.onSeekEnd?.(this.progress);
      this.draw();
    };

    this._onPointerLeave = () => {
      if (this.isSeeking || this.isPanning || this.isScrollbarDragging) return;
      this.hoverProgress = null;
      this.draw();
    };

    this._onDoubleClick = () => {
      if (this.zoom > 1.01) {
        this.resetZoom();
      }
    };

    this._onKeyDown = (event) => {
      if (this.duration <= 0) return;
      let nextTime = this.currentTime;
      if (event.key === 'ArrowLeft') nextTime -= 5;
      else if (event.key === 'ArrowRight') nextTime += 5;
      else if (event.key === 'Home') nextTime = 0;
      else if (event.key === 'End') nextTime = this.duration;
      else return;
      event.preventDefault();
      const nextP = Math.max(0, Math.min(1, nextTime / this.duration));
      this.progress = nextP;
      this.currentTime = nextP * this.duration;
      this._updateAria();
      this.draw();
      this.onSeek?.(nextP, { scrubbing: false });
      this.onSeekEnd?.(nextP);
    };

    this._onWheel = (event) => {
      event.preventDefault();
      if (!this.enableZoom || this.duration <= 4) return;
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const xFrac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const curSpan = this._viewportSpan();

      // Horizontal scroll or Shift+wheel pans when zoomed
      if ((event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) && this.zoom > 1.01) {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        const shiftSec = (delta / 360) * curSpan;
        this._setViewport(this.viewStartSec + shiftSec, curSpan);
        return;
      }

      const maxZoom = Math.max(1, Math.min(1200, this.duration / 4.0));
      const factor = event.deltaY < 0 ? 1.28 : (1 / 1.28);
      const nextZoom = Math.max(1, Math.min(maxZoom, this.zoom * factor));
      if (Math.abs(nextZoom - this.zoom) < 1e-4) return;

      const anchorSec = this.viewStartSec + xFrac * curSpan;
      const nextSpan = this.duration / nextZoom;
      this.zoom = nextZoom;
      this._setViewport(anchorSec - xFrac * nextSpan, nextSpan);
    };

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this.canvas.addEventListener('dblclick', this._onDoubleClick);
    this.canvas.addEventListener('keydown', this._onKeyDown);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

    this._updateAria(true);
    this.draw();
  }

  get duration() {
    return this.knownDuration || this.audioBuffer?.duration || 0;
  }

  setMessage(message) {
    this.emptyMessage = message || '';
    if (this.mode === 'empty') {
      this.draw();
    }
  }

  setAudioBuffer(buffer, totalExpectedDuration) {
    this.mode = buffer ? 'buffer' : 'empty';
    this.audioBuffer = buffer || null;
    this.interleavedPeaks = null;
    this.peakPairs = null;
    this._invalidatePeaks();
    if (totalExpectedDuration && totalExpectedDuration > 0) {
      this.knownDuration = totalExpectedDuration;
    } else if (buffer && (!this.knownDuration || this.knownDuration < buffer.duration)) {
      this.knownDuration = buffer.duration;
    }
    this.emptyMessage = '';
    this._updateAria();
    this.draw();
  }

  setInterleavedPeaks(interleavedMinMax, durationSeconds, options = {}) {
    const prevDur = this.knownDuration;
    this.interleavedPeaks = interleavedMinMax?.length >= 2 ? Float32Array.from(interleavedMinMax) : null;
    this.audioBuffer = null;
    this.peakPairs = null;
    this.mode = this.interleavedPeaks ? 'interleaved' : 'progress';
    this._invalidatePeaks();
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      this.knownDuration = durationSeconds;
    }
    const dur = this.duration;
    const durChanged = Math.abs(dur - prevDur) > 0.25;
    if (durChanged || this.viewEndSec <= this.viewStartSec || this.zoom <= 1.01) {
      this.zoom = 1;
      this.viewStartSec = 0;
      this.viewEndSec = dur;
    } else {
      this.viewEndSec = Math.min(dur, this.viewEndSec);
      this.viewStartSec = Math.max(0, Math.min(this.viewStartSec, this.viewEndSec));
    }

    this.peaksStartSec = Number.isFinite(options?.viewStartSec) ? options.viewStartSec : 0;
    this.peaksEndSec = (Number.isFinite(options?.viewEndSec) && options.viewEndSec > this.peaksStartSec)
      ? options.viewEndSec
      : dur;

    const pairCount = this.interleavedPeaks ? Math.floor(this.interleavedPeaks.length / 2) : 0;
    const hasExplicitTiers = Boolean(
      options
      && ((Array.isArray(options.tiers) && options.tiers.length > 0)
        || (options.tiers instanceof Uint8Array && options.tiers.length > 0))
    );
    if (hasExplicitTiers && pairCount > 0) {
      this.tierStates = new Uint8Array(pairCount);
      let anyNonZero = false;
      for (let i = 0; i < pairCount; i++) {
        const t = Number(options.tiers[i] ?? 0) & 3;
        this.tierStates[i] = t;
        if (t !== 0) anyNonZero = true;
      }
      // Mirror explicit tiers into full-timeline coverageSlots so zoom/reloads never lose dual-color state
      if (dur > 0) {
        if (durChanged) {
          this.coverageSlots.fill(0);
          this.hasCoverage = false;
        }
        const pStart = this.peaksStartSec;
        const pEnd = this.peaksEndSec > pStart ? this.peaksEndSec : dur;
        const pSpan = Math.max(1e-4, pEnd - pStart);
        const s0 = Math.max(0, Math.floor((pStart / dur) * COVERAGE_SLOTS));
        const s1 = Math.min(COVERAGE_SLOTS, Math.ceil((pEnd / dur) * COVERAGE_SLOTS));
        for (let s = s0; s < s1; s++) {
          const slotT = ((s + 0.5) / COVERAGE_SLOTS) * dur;
          if (slotT < pStart || slotT > pEnd) continue;
          const idx = Math.max(0, Math.min(pairCount - 1, Math.floor(((slotT - pStart) / pSpan) * pairCount)));
          const t = this.tierStates[idx];
          this.coverageSlots[s] = t;
          if (t !== 0) anyNonZero = true;
        }
        if (anyNonZero) this.hasCoverage = true;
      }
    } else if (durChanged) {
      this.tierStates = null;
      this.coverageSlots.fill(0);
      this.hasCoverage = false;
    } else if (options && options.preserveTiers === false) {
      this.tierStates = null;
      this.coverageSlots.fill(0);
      this.hasCoverage = false;
    } else if (this.hasCoverage && pairCount > 0 && dur > 0) {
      // Reconstruct tierStates from preserved coverageSlots when peaks arrive AFTER early tile_update deltas!
      this.tierStates = new Uint8Array(pairCount);
      const pStart = this.peaksStartSec;
      const pEnd = this.peaksEndSec > pStart ? this.peaksEndSec : dur;
      const pSpan = Math.max(1e-4, pEnd - pStart);
      for (let i = 0; i < pairCount; i++) {
        const tSec = pStart + ((i + 0.5) / pairCount) * pSpan;
        const slot = Math.max(0, Math.min(COVERAGE_SLOTS - 1, Math.floor((tSec / dur) * COVERAGE_SLOTS)));
        this.tierStates[i] = this.coverageSlots[slot];
      }
    } else if (!options || options.preserveTiers !== true) {
      this.tierStates = null;
    }

    this.emptyMessage = '';
    this._updateAria();
    this.draw();
  }

  applyTileDelta({ startSec, endSec, durationSec, tier = 0, stale = false, peaks = null, clearAll = false } = {}) {
    if (clearAll) {
      this.clearTileTiers();
      return;
    }
    if (Number.isFinite(durationSec) && durationSec > 0 && this.knownDuration <= 0) {
      this.knownDuration = durationSec;
      if (this.mode === 'empty') {
        this.mode = 'progress';
        this.emptyMessage = '';
      }
      if (this.viewEndSec <= this.viewStartSec) {
        this.viewStartSec = 0;
        this.viewEndSec = durationSec;
      }
    }
    const dur = this.duration;
    if (dur <= 0) return;

    const effTier = stale ? 3 : Math.max(0, Math.min(3, Number(tier) || 0));

    // ALWAYS record tile tier into full-timeline coverageSlots — even before master_peaks arrives!
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
      const s0 = Math.max(0, Math.floor((startSec / dur) * COVERAGE_SLOTS));
      const s1 = Math.min(COVERAGE_SLOTS, Math.ceil((endSec / dur) * COVERAGE_SLOTS));
      for (let s = s0; s < s1; s++) {
        if (effTier === 3 || effTier >= this.coverageSlots[s] || this.coverageSlots[s] === 3) {
          this.coverageSlots[s] = effTier;
        }
      }
      if (effTier > 0) this.hasCoverage = true;
    }

    if (this.interleavedPeaks) {
      const pStart = this.peaksStartSec;
      const pEnd = this.peaksEndSec > pStart ? this.peaksEndSec : dur;
      const pSpan = pEnd - pStart;
      const pairCount = Math.floor(this.interleavedPeaks.length / 2);
      if (pSpan > 0 && pairCount > 0 && endSec > pStart && startSec < pEnd) {
        if (!this.tierStates || this.tierStates.length !== pairCount) {
          this.tierStates = new Uint8Array(pairCount);
        }
        const c0 = Math.max(0, Math.floor(((startSec - pStart) / pSpan) * pairCount));
        const c1 = Math.min(pairCount, Math.ceil(((endSec - pStart) / pSpan) * pairCount));
        const tilePairs = Array.isArray(peaks) ? Math.floor(peaks.length / 2) : 0;
        const tileSpan = Math.max(1e-4, endSec - startSec);

        for (let c = c0; c < c1; c++) {
          const colT0 = pStart + (c / pairCount) * pSpan;
          const colT1 = pStart + ((c + 1) / pairCount) * pSpan;
          if (colT1 <= startSec || colT0 >= endSec) continue;
          // Highest cooked tier wins (unless explicitly marking stale)
          if (effTier === 3 || effTier >= this.tierStates[c] || this.tierStates[c] === 3) {
            this.tierStates[c] = effTier;
          }
          if (tilePairs > 0) {
            const u0 = Math.max(0, Math.min(1, (colT0 - startSec) / tileSpan));
            const u1 = Math.max(u0, Math.min(1, (colT1 - startSec) / tileSpan));
            const tp0 = Math.max(0, Math.min(tilePairs - 1, Math.floor(u0 * tilePairs)));
            const tp1 = Math.max(tp0 + 1, Math.min(tilePairs, Math.ceil(u1 * tilePairs)));
            let mn = 1;
            let mx = -1;
            for (let k = tp0; k < tp1; k++) {
              const lo = Number(peaks[k * 2]) || 0;
              const hi = Number(peaks[k * 2 + 1]) || 0;
              if (lo < mn) mn = lo;
              if (hi > mx) mx = hi;
            }
            if (mn <= mx) {
              this.interleavedPeaks[c * 2] = mn;
              this.interleavedPeaks[c * 2 + 1] = mx;
            }
          }
        }
      }
    }
    this._invalidatePeaks();
    this.draw();
  }

  clearTileTiers() {
    this.coverageSlots.fill(0);
    this.hasCoverage = false;
    this.tierStates = null;
    this._invalidatePeaks();
    this.draw();
  }

  markAllTiersStale() {
    let changed = false;
    if (this.tierStates) {
      for (let i = 0; i < this.tierStates.length; i++) {
        if (this.tierStates[i] > 0) {
          this.tierStates[i] = 3;
          changed = true;
        }
      }
    }
    for (let s = 0; s < COVERAGE_SLOTS; s++) {
      if (this.coverageSlots[s] > 0) {
        this.coverageSlots[s] = 3;
        changed = true;
      }
    }
    if (changed) {
      this._invalidatePeaks();
      this.draw();
    }
  }

  getViewport() {
    const dur = this.duration;
    const startSec = this.zoom > 1.01 ? this.viewStartSec : 0;
    const endSec = this.zoom > 1.01 ? this.viewEndSec : dur;
    const columns = Math.max(128, Math.min(1024, Math.floor(this.cachedCssWidth || 512)));
    return { startSec, endSec, zoom: this.zoom, columns };
  }

  resetZoom() {
    this.zoom = 1;
    this.viewStartSec = 0;
    this.viewEndSec = this.duration;
    this._scheduleViewportNotify(true);
    this.draw();
  }

  _viewportSpan() {
    const dur = this.duration;
    if (dur <= 0) return 0;
    if (this.zoom <= 1.01 || this.viewEndSec <= this.viewStartSec) return dur;
    return Math.max(0.01, Math.min(dur, this.viewEndSec - this.viewStartSec));
  }

  _setViewport(startSec, spanSec) {
    const dur = this.duration;
    if (dur <= 0) return;
    const clampedSpan = Math.max(Math.min(dur, 4.0), Math.min(dur, spanSec));
    const maxStart = Math.max(0, dur - clampedSpan);
    this.viewStartSec = Math.max(0, Math.min(maxStart, startSec));
    this.viewEndSec = Math.min(dur, this.viewStartSec + clampedSpan);
    this.zoom = clampedSpan > 0 ? Math.max(1, dur / clampedSpan) : 1;
    if (this.zoom <= 1.01) {
      this.zoom = 1;
      this.viewStartSec = 0;
      this.viewEndSec = dur;
    }
    this._scheduleViewportNotify(false);
    this.draw();
  }

  _panViewportToScrollbarX(localX, width) {
    if (width <= 0 || this.duration <= 0) return;
    const span = this._viewportSpan();
    const frac = Math.max(0, Math.min(1, localX / width));
    this._setViewport(frac * this.duration - span * 0.5, span);
  }

  _scheduleViewportNotify(immediate) {
    if (!this.onViewportChange || this.duration <= 0) return;
    if (this._vpNotifyTimer !== null) {
      clearTimeout(this._vpNotifyTimer);
      this._vpNotifyTimer = null;
    }
    const fire = () => {
      this._vpNotifyTimer = null;
      const vp = this.getViewport();
      this.onViewportChange?.(vp.startSec, vp.endSec, vp.columns);
    };
    if (immediate) {
      fire();
    } else {
      this._vpNotifyTimer = setTimeout(fire, 55);
    }
  }

  setPeakPairs(pairs, durationSeconds) {
    this.peakPairs = Array.isArray(pairs) && pairs.length > 0 ? pairs : null;
    this.audioBuffer = null;
    this.interleavedPeaks = null;
    this.mode = this.peakPairs ? 'pairs' : 'progress';
    this._invalidatePeaks();
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      this.knownDuration = durationSeconds;
    }
    this.emptyMessage = '';
    this._updateAria();
    this.draw();
  }

  setProgressOnly(durationSeconds = 0, message = '') {
    this.mode = 'progress';
    this.audioBuffer = null;
    this.interleavedPeaks = null;
    this.peakPairs = null;
    this._invalidatePeaks();
    this.knownDuration = Math.max(0, Number(durationSeconds) || 0);
    this.emptyMessage = message;
    this._updateAria();
    this.draw();
  }

  setPlayback(currentTime, duration) {
    if (Number.isFinite(duration) && duration > 0) {
      this.knownDuration = duration;
    }
    const dur = this.duration;
    if (this.mode === 'empty' && dur > 0) {
      this.mode = 'progress';
      this.emptyMessage = '';
    }
    this.currentTime = Math.max(0, Math.min(dur, Number.isFinite(currentTime) ? currentTime : 0));
    this.progress = dur > 0 ? this.currentTime / dur : 0;
    // Auto-follow playhead cleanly when zoomed in and not manually dragging
    if (this.zoom > 1.01 && !this.isSeeking && !this.isPanning && !this.isScrollbarDragging && dur > 0) {
      const span = this._viewportSpan();
      if (this.currentTime > this.viewEndSec || this.currentTime < this.viewStartSec) {
        this._setViewport(this.currentTime - span * 0.12, span);
        this._updateAria();
        return;
      }
    }
    this._updateAria();
    this.draw();
  }

  setCue(cueSec, active) {
    this.cueSec = Math.max(0, Number(cueSec) || 0);
    this.cueActive = Boolean(active);
    this.draw();
  }

  clear(message = 'Ready') {
    this.mode = 'empty';
    this.audioBuffer = null;
    this.interleavedPeaks = null;
    this.tierStates = null;
    this.coverageSlots.fill(0);
    this.hasCoverage = false;
    this.peakPairs = null;
    this._invalidatePeaks();
    this.progress = 0;
    this.currentTime = 0;
    this.knownDuration = 0;
    this.zoom = 1;
    this.viewStartSec = 0;
    this.viewEndSec = 0;
    this.peaksStartSec = 0;
    this.peaksEndSec = 0;
    this.hoverProgress = null;
    this.emptyMessage = message;
    this._updateAria(true);
    this.draw();
  }

  destroy() {
    if (this._vpNotifyTimer !== null) {
      clearTimeout(this._vpNotifyTimer);
      this._vpNotifyTimer = null;
    }
    this._resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this.canvas.removeEventListener('dblclick', this._onDoubleClick);
    this.canvas.removeEventListener('keydown', this._onKeyDown);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.remove();
  }

  _progressFromPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || this.duration <= 0) return 0;
    const xFrac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    if (this.zoom > 1.01) {
      const span = this._viewportSpan();
      const targetSec = this.viewStartSec + xFrac * span;
      return Math.max(0, Math.min(1, targetSec / this.duration));
    }
    return xFrac;
  }

  _timeToCanvasX(sec, cssWidth) {
    const dur = this.duration;
    if (dur <= 0 || cssWidth <= 0) return 0;
    if (this.zoom > 1.01) {
      const span = this._viewportSpan();
      return ((sec - this.viewStartSec) / span) * cssWidth;
    }
    return (sec / dur) * cssWidth;
  }

  _applySeekPointer(progress, scrubbing) {
    this.hoverProgress = progress;
    this.progress = progress;
    this.currentTime = progress * this.duration;
    this._updateAria();
    this.draw();
    this.onSeek?.(progress, { scrubbing });
  }

  _updateAria(force = false) {
    const curSec = Math.round(this.currentTime);
    const durSec = Math.round(this.duration);
    if (!force && curSec === this.lastAriaSecond && durSec === this.lastAriaDuration) return;
    this.lastAriaSecond = curSec;
    this.lastAriaDuration = durSec;
    this.canvas.setAttribute('aria-valuemax', String(durSec));
    this.canvas.setAttribute('aria-valuenow', String(curSec));
    this.canvas.setAttribute('aria-valuetext', `${formatSec(this.currentTime)} of ${formatSec(this.duration)}`);
  }

  _invalidatePeaks() {
    this.peakCache = null;
    this.tierCache = null;
    this.peakCacheSource = null;
    this.peakCacheColumns = 0;
    this._covCache = null;
    this._covCacheKey = '';
    this._waveLayerKey = '';
    this._peaksRev++;
  }

  _resolveInterleavedForViewport(columns) {
    const flat = this.interleavedPeaks;
    const pairCount = Math.floor((flat?.length || 0) / 2);
    if (columns <= 0 || pairCount === 0) {
      return { peaks: new Float32Array(0), tiers: null, bufferedCols: 0 };
    }
    const dur = this.duration;
    const vStart = this.zoom > 1.01 ? this.viewStartSec : 0;
    const vEnd = this.zoom > 1.01 ? this.viewEndSec : dur;
    const pStart = this.peaksStartSec;
    const pEnd = this.peaksEndSec > pStart ? this.peaksEndSec : dur;
    const pSpan = Math.max(1e-4, pEnd - pStart);
    const vSpan = Math.max(1e-4, vEnd - vStart);

    const out = new Float32Array(columns);
    const hasTiers = Boolean(this.tierStates && this.tierStates.length >= pairCount);
    const outTiers = hasTiers ? new Uint8Array(columns) : null;

    // Fast path when peaks match viewport 1:1
    const aligned = Math.abs(vStart - pStart) < 1e-3 && Math.abs(vEnd - pEnd) < 1e-3;
    for (let x = 0; x < columns; x++) {
      let sIdx, eIdx;
      if (aligned) {
        sIdx = Math.floor((x / columns) * pairCount);
        eIdx = Math.max(sIdx + 1, Math.floor(((x + 1) / columns) * pairCount));
      } else {
        const t0 = vStart + (x / columns) * vSpan;
        const t1 = vStart + ((x + 1) / columns) * vSpan;
        if (t1 <= pStart || t0 >= pEnd) continue;
        sIdx = Math.max(0, Math.min(pairCount - 1, Math.floor(((t0 - pStart) / pSpan) * pairCount)));
        eIdx = Math.max(sIdx + 1, Math.min(pairCount, Math.ceil(((t1 - pStart) / pSpan) * pairCount)));
      }
      let peak = 0;
      let bestTier = 0;
      let anyStale = false;
      for (let i = sIdx; i < eIdx && i < pairCount; i++) {
        const lo = Math.abs(Number(flat[i * 2]) || 0);
        const hi = Math.abs(Number(flat[i * 2 + 1]) || 0);
        if (lo > peak) peak = lo;
        if (hi > peak) peak = hi;
        if (hasTiers) {
          const t = this.tierStates[i];
          if (t === 3) anyStale = true;
          else if (t > bestTier) bestTier = t;
        }
      }
      out[x] = Math.min(1, peak);
      if (outTiers) {
        outTiers[x] = (anyStale && bestTier < 2) ? 3 : bestTier;
      }
    }
    return { peaks: out, tiers: outTiers, bufferedCols: columns };
  }

  _resolvePeaks(columns) {
    if (columns <= 0) return { peaks: new Float32Array(0), tiers: null, bufferedCols: 0 };

    if (this.mode === 'pairs' && this.peakPairs) {
      if (this.peakCache && this.peakCacheSource === this.peakPairs && this.peakCacheColumns === columns) {
        return { peaks: this.peakCache, tiers: null, bufferedCols: columns };
      }
      const out = downsamplePeakPairs(this.peakPairs, columns);
      this.peakCache = out;
      this.peakCacheSource = this.peakPairs;
      this.peakCacheColumns = columns;
      return { peaks: out, tiers: null, bufferedCols: columns };
    }

    if (this.mode === 'interleaved' && this.interleavedPeaks) {
      const vpKey = `${this.viewStartSec.toFixed(2)}:${this.viewEndSec.toFixed(2)}:${this.peaksStartSec.toFixed(2)}:${this.peaksEndSec.toFixed(2)}`;
      if (this.peakCache && this.peakCacheSource === vpKey && this.peakCacheColumns === columns) {
        return { peaks: this.peakCache, tiers: this.tierCache, bufferedCols: columns };
      }
      const resolved = this._resolveInterleavedForViewport(columns);
      this.peakCache = resolved.peaks;
      this.tierCache = resolved.tiers;
      this.peakCacheSource = vpKey;
      this.peakCacheColumns = columns;
      return resolved;
    }

    if (this.mode === 'buffer' && this.audioBuffer) {
      const totalDur = this.duration > 0 ? this.duration : this.audioBuffer.duration;
      const bufferRatio = Math.min(1.0, Math.max(0.01, this.audioBuffer.duration / Math.max(0.01, totalDur)));
      const bufferedCols = Math.max(1, Math.min(columns, Math.floor(columns * bufferRatio)));
      if (this.peakCache && this.peakCacheSource === this.audioBuffer && this.peakCacheColumns === columns) {
        return { peaks: this.peakCache, tiers: null, bufferedCols };
      }
      const channels = Array.from(
        { length: this.audioBuffer.numberOfChannels },
        (_, ch) => this.audioBuffer.getChannelData(ch)
      );
      const sampleCount = this.audioBuffer.length;
      const samplesPerCol = Math.max(1, Math.floor(sampleCount / bufferedCols));
      const peaks = new Float32Array(columns);
      for (let x = 0; x < bufferedCols; x++) {
        const start = x * samplesPerCol;
        const end = Math.min(sampleCount, start + samplesPerCol);
        let peak = 0;
        for (let i = start; i < end; i += 4) {
          for (const samples of channels) peak = Math.max(peak, Math.abs(samples[i] || 0));
        }
        peaks[x] = Math.min(1, peak);
      }
      this.peakCache = peaks;
      this.tierCache = null;
      this.peakCacheSource = this.audioBuffer;
      this.peakCacheColumns = columns;
      return { peaks, tiers: null, bufferedCols };
    }

    return { peaks: new Float32Array(0), tiers: null, bufferedCols: 0 };
  }

  _resolveCoverageForViewport(columns) {
    const dur = this.duration;
    if (!this.hasCoverage || dur <= 0 || columns <= 0) return new Uint8Array(columns);
    const vStart = this.zoom > 1.01 ? this.viewStartSec : 0;
    const vEnd = this.zoom > 1.01 ? this.viewEndSec : dur;
    const key = `${this._peaksRev}:${columns}:${vStart.toFixed(2)}:${vEnd.toFixed(2)}`;
    if (this._covCache && this._covCacheKey === key) return this._covCache;
    const out = new Uint8Array(columns);
    const vSpan = Math.max(1e-4, vEnd - vStart);
    for (let x = 0; x < columns; x++) {
      const t = vStart + ((x + 0.5) / columns) * vSpan;
      const slot = Math.max(0, Math.min(COVERAGE_SLOTS - 1, Math.floor((t / dur) * COVERAGE_SLOTS)));
      out[x] = this.coverageSlots[slot];
    }
    this._covCache = out;
    this._covCacheKey = key;
    return out;
  }

  _getWaveLayerCtx(width, height, dpr) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (!this._waveLayer) {
      this._waveLayer = document.createElement('canvas');
    }
    if (this._waveLayer.width !== width || this._waveLayer.height !== height) {
      this._waveLayer.width = width;
      this._waveLayer.height = height;
      this._waveLayerKey = '';
    }
    const lctx = this._waveLayer.getContext?.('2d');
    if (!lctx || typeof lctx.setTransform !== 'function') return null;
    return lctx;
  }

  _drawTierRuns(ctx, colTiers, palette, y, height) {
    const len = colTiers.length;
    let runStart = 0;
    let runTier = colTiers[0];
    for (let x = 1; x <= len; x++) {
      const cur = x < len ? colTiers[x] : -1;
      if (cur !== runTier) {
        const color = palette[runTier];
        if (color) {
          ctx.fillStyle = color;
          ctx.fillRect(runStart, y, x - runStart, height);
        }
        runStart = x;
        runTier = cur;
      }
    }
  }

  draw() {
    if (!this.ctx) return;
    let cssWidth = this.cachedCssWidth;
    let cssHeight = this.cachedCssHeight;
    if (cssWidth <= 0 || cssHeight <= 0) {
      const rect = this.canvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      if (cssWidth > 0 && cssHeight > 0) {
        this.cachedCssWidth = cssWidth;
        this.cachedCssHeight = cssHeight;
      }
    }
    if (cssWidth <= 0 || cssHeight <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(cssWidth * dpr));
    const height = Math.max(1, Math.floor(cssHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    cssWidth = width / dpr;
    cssHeight = height / dpr;

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const hasTimeline = this.mode !== 'empty' && this.duration > 0;
    const hasWave = this.mode === 'buffer' || this.mode === 'interleaved' || this.mode === 'pairs';

    if (hasWave) {
      const isZoomed = this.zoom > 1.01;
      const scrollReserve = isZoomed ? 5 : 0;
      const columns = Math.max(1, Math.floor(cssWidth));
      const { peaks, tiers, bufferedCols } = this._resolvePeaks(columns);

      let hasActiveTier = false;
      if (tiers) {
        for (let x = 0; x < tiers.length; x++) {
          if (tiers[x] !== 0) { hasActiveTier = true; break; }
        }
      }
      const hasTierVisual = hasActiveTier || this.hasCoverage;
      const colTiers = hasTierVisual ? (hasActiveTier && tiers ? tiers : this._resolveCoverageForViewport(columns)) : null;
      const railReserve = hasTierVisual ? 4 : 0;
      const waveH = Math.max(8, cssHeight - scrollReserve - railReserve);
      const middle = waveH / 2;

      const rawPlayheadX = this._timeToCanvasX(this.currentTime, cssWidth);
      const playheadX = Math.max(0, Math.min(cssWidth, rawPlayheadX));
      const bufferFrontX = bufferedCols < columns ? (bufferedCols / columns) * cssWidth : null;
      const endActiveX = bufferFrontX != null ? Math.min(cssWidth, bufferFrontX) : cssWidth;

      // Subtle center hairline
      ctx.fillStyle = 'rgba(15, 23, 42, 0.06)';
      ctx.fillRect(0, Math.floor(middle), cssWidth, 1);

      if (bufferFrontX != null) {
        ctx.fillStyle = 'rgba(241, 245, 249, 0.75)';
        ctx.fillRect(bufferFrontX, 0, cssWidth - bufferFrontX, waveH);
      }

      const scaleH = waveH * 0.4;
      if (hasTierVisual && colTiers) {
        // Cache static dual-color waveform + background wash + 4px rail onto offscreen canvas
        // so 30 Hz playhead ticks take ~0.08ms (single drawImage + 1.5px needle) instead of 4 full stroke passes!
        const layerKey = `t:${this._peaksRev}:${width}:${height}:${this.viewStartSec.toFixed(2)}:${this.viewEndSec.toFixed(2)}:${bufferedCols}`;
        const lctx = this._getWaveLayerCtx(width, height, dpr);
        if (lctx && typeof ctx.drawImage === 'function') {
          if (this._waveLayerKey !== layerKey) {
            this._waveLayerKey = layerKey;
            lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            lctx.clearRect(0, 0, cssWidth, cssHeight);
            lctx.fillStyle = '#f8fafc';
            lctx.fillRect(0, 0, cssWidth, cssHeight);
            lctx.fillStyle = 'rgba(15, 23, 42, 0.06)';
            lctx.fillRect(0, Math.floor(middle), cssWidth, 1);
            if (bufferFrontX != null) {
              lctx.fillStyle = 'rgba(241, 245, 249, 0.75)';
              lctx.fillRect(bufferFrontX, 0, cssWidth - bufferFrontX, waveH);
            }
            this._drawTierRuns(lctx, colTiers, TIER_BG_COLORS, 0, waveH);
            for (let t = 0; t <= 3; t++) {
              lctx.strokeStyle = TIER_COLORS[t];
              lctx.lineWidth = 1;
              lctx.beginPath();
              let any = false;
              for (let x = 0; x < bufferedCols; x++) {
                if (colTiers[x] !== t) continue;
                const h = Math.max(1, peaks[x] * scaleH);
                const px = x + 0.5;
                lctx.moveTo(px, middle - h);
                lctx.lineTo(px, middle + h);
                any = true;
              }
              if (any) lctx.stroke();
            }
            this._drawTierRuns(lctx, colTiers, TIER_RAIL_COLORS, waveH, railReserve);
          }
          ctx.drawImage(this._waveLayer, 0, 0, cssWidth, cssHeight);
        } else {
          // Direct draw fallback (headless/test canvas without offscreen layer)
          this._drawTierRuns(ctx, colTiers, TIER_BG_COLORS, 0, waveH);
          for (let t = 0; t <= 3; t++) {
            ctx.strokeStyle = TIER_COLORS[t];
            ctx.lineWidth = 1;
            ctx.beginPath();
            let any = false;
            for (let x = 0; x < bufferedCols; x++) {
              if (colTiers[x] !== t) continue;
              const h = Math.max(1, peaks[x] * scaleH);
              const px = x + 0.5;
              ctx.moveTo(px, middle - h);
              ctx.lineTo(px, middle + h);
              any = true;
            }
            if (any) ctx.stroke();
          }
          this._drawTierRuns(ctx, colTiers, TIER_RAIL_COLORS, waveH, railReserve);
        }
        // Subtle played tint behind cursor without obscuring tier colors
        if (rawPlayheadX > 0) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.05)';
          ctx.fillRect(0, 0, Math.min(playheadX, endActiveX), waveH);
        }
      } else {
        const drawRange = (color, startX, endX) => {
          const lo = Math.max(0, Math.floor(startX));
          const hi = Math.min(bufferedCols, Math.ceil(endX));
          if (hi <= lo) return;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = lo; x < hi; x++) {
            const h = Math.max(1, peaks[x] * scaleH);
            const px = x + 0.5;
            ctx.moveTo(px, middle - h);
            ctx.lineTo(px, middle + h);
          }
          ctx.stroke();
        };

        drawRange('#94a3b8', playheadX, endActiveX);
        drawRange('#059669', 0, Math.min(playheadX, endActiveX));

        ctx.fillStyle = 'rgba(5, 150, 105, 0.08)';
        ctx.fillRect(0, 0, Math.min(playheadX, endActiveX), waveH);
      }

      if (bufferFrontX != null && bufferFrontX < cssWidth - 1) {
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bufferFrontX, 0);
        ctx.lineTo(bufferFrontX, waveH);
        ctx.stroke();
      }

      // Thin overview viewport scrollbar when zoomed in (with full-track dual-color tier overview)
      if (isZoomed && this.duration > 0) {
        const barY = cssHeight - 4;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.09)';
        ctx.fillRect(0, barY, cssWidth, 4);
        if (this.hasCoverage) {
          const slotW = cssWidth / COVERAGE_SLOTS;
          for (let s = 0; s < COVERAGE_SLOTS; s++) {
            const t = this.coverageSlots[s];
            if (t > 0) {
              ctx.fillStyle = TIER_RAIL_COLORS[t];
              ctx.fillRect(s * slotW, barY, Math.ceil(slotW), 4);
            }
          }
        }
        const vx0 = (this.viewStartSec / this.duration) * cssWidth;
        const vx1 = (this.viewEndSec / this.duration) * cssWidth;
        const vw = Math.max(10, vx1 - vx0);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
        ctx.fillRect(Math.min(cssWidth - vw, vx0), barY, vw, 4);
        // Playhead dot inside overview rail
        const ox = Math.max(0, Math.min(cssWidth - 2, (this.currentTime / this.duration) * cssWidth));
        ctx.fillStyle = '#059669';
        ctx.fillRect(ox, barY, 2, 4);
      }
    } else if (hasTimeline) {
      const playheadX = Math.max(0, Math.min(cssWidth, this._timeToCanvasX(this.currentTime, cssWidth)));
      if (this.hasCoverage) {
        const columns = Math.max(1, Math.floor(cssWidth));
        const colTiers = this._resolveCoverageForViewport(columns);
        const railH = 4;
        const bodyH = Math.max(4, cssHeight - railH);
        this._drawTierRuns(ctx, colTiers, TIER_BG_COLORS, 0, bodyH);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.07)';
        ctx.fillRect(0, 0, playheadX, bodyH);
        this._drawTierRuns(ctx, colTiers, TIER_RAIL_COLORS, bodyH, railH);
      } else {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.09)';
        ctx.fillRect(0, 0, playheadX, cssHeight);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
        ctx.fillRect(0, cssHeight - 2, playheadX, 2);
      }
    } else if (this.emptyMessage) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10.5px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyMessage, cssWidth / 2, cssHeight / 2);
    }

    if (this.cueActive && this.duration > 0) {
      const cueX = this._timeToCanvasX(this.cueSec, cssWidth);
      if (cueX >= 0 && cueX <= cssWidth) {
        ctx.strokeStyle = 'rgba(217, 119, 6, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(cueX, 4);
        ctx.lineTo(cueX, cssHeight);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#d97706';
        ctx.beginPath();
        ctx.moveTo(cueX - 3.5, 0);
        ctx.lineTo(cueX + 3.5, 0);
        ctx.lineTo(cueX, 4.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (hasTimeline || hasWave) {
      const rawPlayX = this._timeToCanvasX(this.currentTime, cssWidth);
      if (rawPlayX >= -1 && rawPlayX <= cssWidth + 1) {
        const playheadX = Math.max(0, Math.min(cssWidth, rawPlayX));
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, cssHeight - (this.zoom > 1.01 ? 5 : 0));
        ctx.stroke();
      }

      if (this.hoverProgress !== null && !this.isSeeking && this.duration > 0) {
        const hoverSec = this.hoverProgress * this.duration;
        const hoverX = this._timeToCanvasX(hoverSec, cssWidth);
        if (hoverX >= 0 && hoverX <= cssWidth) {
          const hoverTime = formatSec(hoverSec);
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hoverX, 0);
          ctx.lineTo(hoverX, cssHeight - (this.zoom > 1.01 ? 5 : 0));
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Consolas, monospace';
          const w = ctx.measureText(hoverTime).width + 8;
          const tx = Math.max(2, Math.min(cssWidth - w - 2, hoverX - w / 2));
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(tx, 2, w, 13);
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 1;
          ctx.strokeRect(tx, 2, w, 13);
          ctx.fillStyle = '#0f172a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(hoverTime, tx + w / 2, 8.5);
        }
      }
    }

    ctx.restore();
  }
}
