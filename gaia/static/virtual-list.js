/**
 * High-FPS Virtualized List Renderer for GAIA's flat tree table (#asset-list).
 *
 * Uses a single fixed-height `position: relative` runway with an absolutely
 * positioned slice (`top: topPad`) and `overflow-anchor: none` so `scrollHeight`
 * stays 100% invariant and Chromium scroll-anchoring never causes self-scrolling
 * or jitter in the middle of long lists.
 */
(function initVirtualListModule() {
    class GaiaVirtualList {
        constructor(scrollContainer, { renderItem, overscan = 14, createEndSpacer = null } = {}) {
            this.container = scrollContainer;
            this.renderItem = renderItem;
            this.overscan = overscan;
            this.createEndSpacer = createEndSpacer;

            this.items = [];
            this.offsets = new Float64Array(1);
            this.totalHeight = 0;
            this.lastRange = { start: -1, end: -1 };
            this._rafPending = false;
            this._destroyed = false;

            this.runway = document.createElement('div');
            this.runway.className = 'virtual-runway';

            this.viewportSlice = document.createElement('div');
            this.viewportSlice.className = 'virtual-viewport-slice';
            this.runway.appendChild(this.viewportSlice);

            this.endSpacer = typeof createEndSpacer === 'function' ? createEndSpacer() : null;

            this._onScroll = () => {
                if (this._rafPending) return;
                this._rafPending = true;
                requestAnimationFrame(() => {
                    this._rafPending = false;
                    if (!this._destroyed) this.renderWindow(false);
                });
            };
            this._onResize = () => {
                if (!this._destroyed) this.renderWindow(false);
            };

            this.container.addEventListener('scroll', this._onScroll, { passive: true });
            if (typeof ResizeObserver !== 'undefined') {
                this._resizeObserver = new ResizeObserver(this._onResize);
                this._resizeObserver.observe(this.container);
            } else {
                window.addEventListener('resize', this._onResize, { passive: true });
            }
        }

        _ensureMountedStructure() {
            if (this.runway.parentNode !== this.container) {
                const nodes = [this.runway];
                if (this.endSpacer) nodes.push(this.endSpacer);
                this.container.replaceChildren(...nodes);
            }
        }

        setItems(items, { force = true, tableWidthPx = null } = {}) {
            this.items = Array.isArray(items) ? items : [];
            const n = this.items.length;
            const offsets = new Float64Array(n + 1);
            let y = 0;
            for (let i = 0; i < n; i++) {
                offsets[i] = y;
                y += this.items[i].height || 28;
            }
            offsets[n] = y;
            this.offsets = offsets;
            this.totalHeight = y;
            this.runway.style.height = `${y}px`;

            if (tableWidthPx !== null) {
                const px = `${tableWidthPx}px`;
                this.runway.style.setProperty('--main-table-width', px);
                if (this.endSpacer) this.endSpacer.style.setProperty('--main-table-width', px);
            }

            this._ensureMountedStructure();
            this.renderWindow(force);
        }

        _findStartIndex(scrollTop) {
            const n = this.items.length;
            if (n === 0 || scrollTop <= 0) return 0;
            let lo = 0;
            let hi = n - 1;
            const offsets = this.offsets;
            while (lo < hi) {
                const mid = (lo + hi + 1) >>> 1;
                if (offsets[mid] <= scrollTop) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        }

        renderWindow(force = false) {
            const n = this.items.length;
            if (n === 0) {
                this.runway.style.height = '0px';
                this.viewportSlice.style.top = '0px';
                if (this.lastRange.start !== 0 || this.lastRange.end !== 0 || force) {
                    this.viewportSlice.replaceChildren();
                    this.lastRange = { start: 0, end: 0 };
                }
                return;
            }

            // Preserve active inline cell editor so small scrolls don't destroy typing
            const activeEl = document.activeElement;
            const isEditingInside = activeEl
                && this.viewportSlice.contains(activeEl)
                && (activeEl.classList?.contains('cell-editor') || activeEl.classList?.contains('reference-label-editor'));
            if (isEditingInside && !force) return;

            const scrollTop = Math.max(0, this.container.scrollTop || 0);
            const viewHeight = Math.max(320, this.container.clientHeight || 720);
            const firstVisible = this._findStartIndex(scrollTop);
            const lastVisible = this._findStartIndex(scrollTop + viewHeight);

            const start = Math.max(0, firstVisible - this.overscan);
            const end = Math.min(n, lastVisible + 1 + this.overscan);

            if (!force && start === this.lastRange.start && end === this.lastRange.end) {
                return;
            }

            const topPad = this.offsets[start];
            this.viewportSlice.style.top = `${topPad}px`;

            const fragment = document.createDocumentFragment();
            for (let i = start; i < end; i++) {
                const spec = this.items[i];
                const node = this.renderItem(spec, i);
                if (node) {
                    const rowHeight = spec.height || 28;
                    node.style.height = `${rowHeight}px`;
                    node.style.boxSizing = 'border-box';
                    fragment.appendChild(node);
                }
            }
            this.viewportSlice.replaceChildren(fragment);
            this.lastRange = { start, end };
        }

        /** O(visible) selection class update without rebuilding DOM rows. */
        refreshSelection(selectedIds) {
            const rows = this.viewportSlice.querySelectorAll('.asset-row, .subfolder-row');
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const entryId = row.dataset.entryId || row.closest('.asset-entry')?.dataset.entryId;
                const selected = entryId ? selectedIds.has(entryId) : false;
                row.classList.toggle('selected', selected);
                row.setAttribute('aria-selected', String(selected));
            }
        }

        scrollToIndex(index, { block = 'nearest' } = {}) {
            const n = this.items.length;
            if (index < 0 || index >= n) return;
            const rowTop = this.offsets[index];
            const rowBottom = this.offsets[index + 1];
            const viewTop = this.container.scrollTop;
            const viewHeight = this.container.clientHeight || 600;
            const viewBottom = viewTop + viewHeight;

            if (block === 'center') {
                this.container.scrollTop = Math.max(0, rowTop - viewHeight / 2 + (rowBottom - rowTop) / 2);
            } else if (rowTop < viewTop) {
                this.container.scrollTop = Math.max(0, rowTop);
            } else if (rowBottom > viewBottom) {
                this.container.scrollTop = Math.max(0, rowBottom - viewHeight);
            }
            this.renderWindow(false);
        }

        findMountedRowByEntryId(entryId) {
            const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(entryId)) : String(entryId);
            return this.viewportSlice.querySelector(`.asset-row[data-entry-id="${escaped}"]`);
        }

        findMountedRowByItemId(itemId) {
            return this.viewportSlice.querySelector(`[data-item-id="${Number(itemId)}"]`);
        }

        destroy() {
            this._destroyed = true;
            this.container.removeEventListener('scroll', this._onScroll);
            if (this._resizeObserver) this._resizeObserver.disconnect();
            else window.removeEventListener('resize', this._onResize);
        }
    }

    window.GaiaVirtualList = GaiaVirtualList;
})();
