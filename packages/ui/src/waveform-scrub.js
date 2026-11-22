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
  const mins = Math.floor(total / 60);
  return `${mins}:${String(total % 60).padStart(2, '0')}`;
}

export function formatTransportTime(seconds) {
  return formatSec(seconds);
}

export class WaveformScrubCanvas {
  constructor(container, options = {}) {
    this.container = container;
    this.onSeek = typeof options.onSeek === 'function' ? options.onSeek : null;
    this.onSeekStart = typeof options.onSeekStart === 'function' ? options.onSeekStart : null;
    this.onSeekEnd = typeof options.onSeekEnd === 'function' ? options.onSeekEnd : null;
    this.emptyMessage = options.emptyMessage || 'No audio';

    this.mode = 'empty'; // 'empty' | 'buffer' | 'interleaved' | 'pairs' | 'progress'
    this.audioBuffer = null;
    this.interleavedPeaks = null;
    this.peakPairs = null;
    this.knownDuration = 0;
    this.currentTime = 0;
    this.progress = 0;
    this.hoverProgress = null;
    this.isSeeking = false;
    this.cueSec = 0;
    this.cueActive = false;

    this.peakCache = null;
    this.peakCacheColumns = 0;
    this.peakCacheSource = null;

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
      if (event.button !== 0 || this.duration <= 0) return;
      event.preventDefault();
      this.isSeeking = true;
      this.canvas.focus({ preventScroll: true });
      try { this.canvas.setPointerCapture(event.pointerId); } catch {}
      const p = this._progressFromPointer(event);
      this.onSeekStart?.(p);
      this._applySeekPointer(p, true);
    };

    this._onPointerMove = (event) => {
      this.hoverProgress = this._progressFromPointer(event);
      if (this.isSeeking) {
        this._applySeekPointer(this.hoverProgress, true);
      } else {
        this.draw();
      }
    };

    this._onPointerUp = (event) => {
      if (!this.isSeeking) return;
      const p = this._progressFromPointer(event);
      this._applySeekPointer(p, false);
      this.isSeeking = false;
      try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
      this.onSeekEnd?.(p);
      this.draw();
    };

    this._onPointerCancel = () => {
      if (!this.isSeeking) return;
      this.isSeeking = false;
      this.onSeekEnd?.(this.progress);
      this.draw();
    };

    this._onPointerLeave = () => {
      if (this.isSeeking) return;
      this.hoverProgress = null;
      this.draw();
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

    this._onWheel = (event) => event.preventDefault();

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
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

  setInterleavedPeaks(interleavedMinMax, durationSeconds) {
    this.interleavedPeaks = interleavedMinMax?.length >= 2 ? interleavedMinMax : null;
    this.audioBuffer = null;
    this.peakPairs = null;
    this.mode = this.interleavedPeaks ? 'interleaved' : 'progress';
    this._invalidatePeaks();
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      this.knownDuration = durationSeconds;
    }
    this.emptyMessage = '';
    this._updateAria();
    this.draw();
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
    this.peakPairs = null;
    this._invalidatePeaks();
    this.progress = 0;
    this.currentTime = 0;
    this.knownDuration = 0;
    this.hoverProgress = null;
    this.emptyMessage = message;
    this._updateAria(true);
    this.draw();
  }

  destroy() {
    this._resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    this.canvas.removeEventListener('keydown', this._onKeyDown);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.remove();
  }

  _progressFromPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
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
    this.peakCacheSource = null;
    this.peakCacheColumns = 0;
  }

  _resolvePeaks(columns) {
    if (columns <= 0) return { peaks: new Float32Array(0), bufferedCols: 0 };

    if (this.mode === 'pairs' && this.peakPairs) {
      if (this.peakCache && this.peakCacheSource === this.peakPairs && this.peakCacheColumns === columns) {
        return { peaks: this.peakCache, bufferedCols: columns };
      }
      const out = downsamplePeakPairs(this.peakPairs, columns);
      this.peakCache = out;
      this.peakCacheSource = this.peakPairs;
      this.peakCacheColumns = columns;
      return { peaks: out, bufferedCols: columns };
    }

    if (this.mode === 'interleaved' && this.interleavedPeaks) {
      if (this.peakCache && this.peakCacheSource === this.interleavedPeaks && this.peakCacheColumns === columns) {
        return { peaks: this.peakCache, bufferedCols: columns };
      }
      const out = downsampleInterleavedPeaks(this.interleavedPeaks, columns);
      this.peakCache = out;
      this.peakCacheSource = this.interleavedPeaks;
      this.peakCacheColumns = columns;
      return { peaks: out, bufferedCols: columns };
    }

    if (this.mode === 'buffer' && this.audioBuffer) {
      const totalDur = this.duration > 0 ? this.duration : this.audioBuffer.duration;
      const bufferRatio = Math.min(1.0, Math.max(0.01, this.audioBuffer.duration / Math.max(0.01, totalDur)));
      const bufferedCols = Math.max(1, Math.min(columns, Math.floor(columns * bufferRatio)));
      if (this.peakCache && this.peakCacheSource === this.audioBuffer && this.peakCacheColumns === columns) {
        return { peaks: this.peakCache, bufferedCols };
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
      this.peakCacheSource = this.audioBuffer;
      this.peakCacheColumns = columns;
      return { peaks, bufferedCols };
    }

    return { peaks: new Float32Array(0), bufferedCols: 0 };
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
      const columns = Math.max(1, Math.floor(cssWidth));
      const middle = cssHeight / 2;
      const { peaks, bufferedCols } = this._resolvePeaks(columns);
      const playheadX = Math.max(0, Math.min(cssWidth, this.progress * cssWidth));
      const bufferFrontX = bufferedCols < columns ? (bufferedCols / columns) * cssWidth : null;
      const endActiveX = bufferFrontX != null ? Math.min(cssWidth, bufferFrontX) : cssWidth;

      // Subtle center hairline
      ctx.fillStyle = 'rgba(15, 23, 42, 0.06)';
      ctx.fillRect(0, Math.floor(middle), cssWidth, 1);

      if (bufferFrontX != null) {
        ctx.fillStyle = 'rgba(241, 245, 249, 0.75)';
        ctx.fillRect(bufferFrontX, 0, cssWidth - bufferFrontX, cssHeight);
      }

      const drawRange = (color, startX, endX) => {
        const lo = Math.max(0, Math.floor(startX));
        const hi = Math.min(bufferedCols, Math.ceil(endX));
        if (hi <= lo) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const scaleH = cssHeight * 0.4;
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
      ctx.fillRect(0, 0, Math.min(playheadX, endActiveX), cssHeight);

      if (bufferFrontX != null && bufferFrontX < cssWidth - 1) {
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bufferFrontX, 0);
        ctx.lineTo(bufferFrontX, cssHeight);
        ctx.stroke();
      }
    } else if (hasTimeline) {
      const playheadX = Math.max(0, Math.min(cssWidth, this.progress * cssWidth));
      ctx.fillStyle = 'rgba(15, 23, 42, 0.09)';
      ctx.fillRect(0, 0, playheadX, cssHeight);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
      ctx.fillRect(0, cssHeight - 2, playheadX, 2);
    } else if (this.emptyMessage) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10.5px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyMessage, cssWidth / 2, cssHeight / 2);
    }

    if (this.cueActive && this.duration > 0) {
      const cueX = Math.max(0, Math.min(cssWidth, (this.cueSec / this.duration) * cssWidth));
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

    if (hasTimeline || hasWave) {
      const playheadX = Math.max(0, Math.min(cssWidth, this.progress * cssWidth));
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, cssHeight);
      ctx.stroke();

      if (this.hoverProgress !== null && !this.isSeeking && this.duration > 0) {
        const hoverX = this.hoverProgress * cssWidth;
        const hoverTime = formatSec(this.hoverProgress * this.duration);
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hoverX, 0);
        ctx.lineTo(hoverX, cssHeight);
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

    ctx.restore();
  }
}
