import { type BaseNode } from '../nodes/BaseNode.ts';
import { type RandomDestination, isFieldMappableToRandom, getRangeColor } from '../../../ermes/ts/randomResolver.ts';

export function startBipolarDrag(
    startEvent: PointerEvent | MouseEvent,
    dest: RandomDestination,
    onUpdate: (spread: number) => void,
    onComplete?: () => void
): void {
    const startX = startEvent.clientX;
    const initialSpread = Math.max(0, Math.min(100, Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent))));

    let dragIndicator = document.getElementById('td-bipolar-drag-indicator');
    if (!dragIndicator) {
        dragIndicator = document.createElement('div');
        dragIndicator.id = 'td-bipolar-drag-indicator';
        dragIndicator.style.cssText = `
            position: fixed;
            z-index: 99999;
            pointer-events: none;
            background: #0f172a;
            border: 1.5px solid #ec4899;
            color: #f472b6;
            font-size: 11px;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 4px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
            display: none;
            transform: translate(-50%, -140%);
            white-space: nowrap;
            user-select: none;
        `;
        document.body.appendChild(dragIndicator);
    }

    const initColors = getRangeColor(-initialSpread, initialSpread);
    dragIndicator.textContent = initialSpread > 0 ? `±${initialSpread}%` : '0%';
    dragIndicator.style.color = initColors.text;
    dragIndicator.style.borderColor = initColors.border;
    dragIndicator.style.left = `${startEvent.clientX}px`;
    dragIndicator.style.top = `${startEvent.clientY}px`;
    dragIndicator.style.display = 'block';

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onPointerMove = (e: PointerEvent | MouseEvent) => {
        const deltaX = e.clientX - startX;
        const newSpread = Math.max(0, Math.min(100, Math.round(initialSpread + deltaX * 0.5)));
        dest.minPercent = -newSpread;
        dest.maxPercent = newSpread;

        if (dragIndicator) {
            const colors = getRangeColor(-newSpread, newSpread);
            dragIndicator.textContent = newSpread > 0 ? `±${newSpread}%` : '0%';
            dragIndicator.style.color = colors.text;
            dragIndicator.style.borderColor = colors.border;
            dragIndicator.style.left = `${e.clientX}px`;
            dragIndicator.style.top = `${e.clientY}px`;
        }

        onUpdate(newSpread);
    };

    const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove as EventListener);
        window.removeEventListener('pointerup', onPointerUp as EventListener);
        window.removeEventListener('pointercancel', onPointerUp as EventListener);
        window.removeEventListener('mousemove', onPointerMove as EventListener);
        window.removeEventListener('mouseup', onPointerUp as EventListener);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        if (dragIndicator) {
            dragIndicator.style.display = 'none';
        }
        onComplete?.();
    };

    window.addEventListener('pointermove', onPointerMove as EventListener);
    window.addEventListener('pointerup', onPointerUp as EventListener);
    window.addEventListener('pointercancel', onPointerUp as EventListener);
    window.addEventListener('mousemove', onPointerMove as EventListener);
    window.addEventListener('mouseup', onPointerUp as EventListener);
}

/**
 * Adjust a destination's bipolar spread via mouse wheel.
 * Each wheel tick changes spread by ±1% (clamped 0–100).
 */
export function adjustSpreadByWheel(
    dest: RandomDestination,
    deltaY: number,
): number {
    const currentSpread = Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent));
    const step = deltaY > 0 ? -1 : 1; // scroll down = shrink, scroll up = widen
    const newSpread = Math.max(0, Math.min(100, currentSpread + step));
    dest.minPercent = -newSpread;
    dest.maxPercent = newSpread;
    return newSpread;
}

export class RandomParamOverlay {

    static getAttachedRandomModifier(node: BaseNode): any | null {
        const graph = (window as any).editorGraph;
        if (!graph || !node) return null;
        return ((graph._nodes || []) as any[]).find(candidate =>
            ((candidate as any).isModifier || candidate.type === 'Audio/Random' || candidate.properties?.node_type === 'random') &&
            candidate.properties?.parentId === node.id &&
            (candidate.properties?.modifier_kind === 'random' || candidate.type === 'Audio/Random' || candidate.properties?.node_type === 'random')
        ) || null;
    }

    static getOrCreateRandomModifier(node: BaseNode): any {
        const existing = this.getAttachedRandomModifier(node);
        if (existing) return existing;

        if (typeof (window as any).addRandomNode === 'function') {
            const created = (window as any).addRandomNode(node.id, false);
            if (created) return created;
        }

        const graph = (window as any).editorGraph;
        if (!graph) return null;

        const randomNode = (window as any).LiteGraph?.createNode('Audio/Random');
        if (!randomNode) return null;

        const trackNodes = (window as any).trackNodes;
        let modCount = 0;
        if (trackNodes) {
            for (const data of trackNodes.values()) {
                if ((data.type === 'modulator' || data.type === 'asset_filter' || data.type === 'random') && data.parentId === node.id) {
                    modCount++;
                }
            }
        }

        const name = `Random ${modCount + 1}`;
        randomNode.properties = randomNode.properties || {};
        randomNode.properties.parentId = node.id;
        randomNode.properties.node_name = name;
        randomNode.properties.node_type = 'random';
        randomNode.properties.modifier_kind = 'random';
        randomNode.title = name;

        if (typeof (randomNode as any).computeSize === 'function') {
            randomNode.size = (randomNode as any).computeSize();
        }

        const parentWidth = node.size ? node.size[0] : 200;
        const parentHeight = node.size ? node.size[1] : 44;
        const offsetX = (modCount - 0.5) * 210;

        randomNode.pos = [
            node.pos[0] + parentWidth * 0.5 - 90 + offsetX,
            node.pos[1] + parentHeight + 60
        ];

        graph.add(randomNode);

        if (trackNodes) {
            trackNodes.set(randomNode.id, {
                id: randomNode.id,
                type: 'random',
                name: name,
                filepath: '',
                original_bpm: 120,
                start_beat: 0,
                mix_mode: 'sum',
                chain: [],
                parentId: node.id,
                children: []
            });
            const parentData = trackNodes.get(node.id);
            if (parentData) {
                parentData.modulators = parentData.modulators || [];
                parentData.modulators.push(randomNode.id);
            }
        }

        return randomNode;
    }

    static getWorkingVal(node: any, key: string, fallback: number = 0): number {
        const stepMatch = key.match(/^step_parameters\.(\d+)\.(.+)$/);
        if (stepMatch && Array.isArray(node.properties?.step_parameters)) {
            const stepIdx = parseInt(stepMatch[1], 10);
            const subKey = stepMatch[2];
            const val = Number(node.properties.step_parameters[stepIdx]?.[subKey]);
            return Number.isFinite(val) ? val : fallback;
        }
        const rawVal = node.properties?.[key];
        const val = Array.isArray(rawVal) ? Number(rawVal[0] ?? fallback) : Number(rawVal ?? fallback);
        return Number.isFinite(val) ? val : fallback;
    }

    static updateSliderGradient(
        slider: HTMLInputElement,
        dest: RandomDestination | undefined,
        colors: { text: string; bg: string; border: string }
    ) {
        if (!dest || !dest.enabled) {
            slider.style.background = '';
            return;
        }
        const minLimit = Number(slider.min || 0);
        const maxLimit = Number(slider.max || 100);
        const span = Math.abs(maxLimit - minLimit) || 1.0;
        const baseVal = Number(dest.baseValue ?? slider.value);

        const spread = Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent));
        const minVal = baseVal - (spread / 100) * span;
        const maxVal = baseVal + (spread / 100) * span;

        const startPct = Math.max(0, Math.min(100, ((minVal - minLimit) / span) * 100));
        const endPct = Math.max(0, Math.min(100, ((maxVal - minLimit) / span) * 100));

        slider.style.background = `linear-gradient(to right, #1e293b 0%, #1e293b ${startPct}%, ${colors.border}66 ${startPct}%, ${colors.border}66 ${endPct}%, #1e293b ${endPct}%, #1e293b 100%)`;
    }

    static startDragOnRow(
        e: PointerEvent,
        row: HTMLElement,
        targetDest: RandomDestination,
        mod: any,
        node: BaseNode,
        container: HTMLElement,
        isOverlayActive: boolean
    ) {
        const shield = row.querySelector<HTMLElement>('.td-param-overlay-shield');
        const rangeFill = shield?.querySelector<HTMLElement>('.shield-range-fill');
        const shieldIndicator = shield?.querySelector<HTMLElement>('.shield-indicator');
        const badge = row.querySelector<HTMLElement>('.td-random-row-badge');
        const slider = row.querySelector<HTMLInputElement>('input[type="range"]');

        startBipolarDrag(
            e,
            targetDest,
            (newSpread) => {
                const colors = getRangeColor(-newSpread, newSpread);
                const spreadStr = newSpread > 0 ? `±${newSpread}%` : '0%';

                if (rangeFill) {
                    rangeFill.style.left = `${Math.max(0, 50 - newSpread * 0.5)}%`;
                    rangeFill.style.width = `${newSpread}%`;
                    rangeFill.style.background = colors.border;
                    rangeFill.style.boxShadow = `0 0 6px ${colors.border}`;
                }
                if (shieldIndicator) {
                    shieldIndicator.textContent = spreadStr;
                    shieldIndicator.style.color = colors.text;
                    shieldIndicator.style.borderColor = colors.border;
                }
                if (shield) {
                    shield.style.borderColor = colors.border;
                    shield.style.background = colors.bg;
                    shield.style.boxShadow = `0 0 8px ${colors.border}44`;
                }
                if (badge) {
                    badge.textContent = spreadStr;
                    badge.style.color = colors.text;
                    badge.style.background = colors.bg;
                    badge.style.borderColor = colors.border;
                }
                if (slider) {
                    this.updateSliderGradient(slider, targetDest, colors);
                }
            },
            () => {
                mod.updateProperty('destinations', [...mod.properties.destinations]);
                this.updateVisualFeedback(container, node, isOverlayActive);
            }
        );
    }

    static startDragOnStep(
        e: PointerEvent,
        stepEl: HTMLElement,
        targetDest: RandomDestination,
        mod: any,
        node: BaseNode,
        container: HTMLElement,
        isOverlayActive: boolean
    ) {
        const shield = stepEl.querySelector<HTMLElement>('.td-step-overlay-shield');
        const stepFill = shield?.querySelector<HTMLElement>('.td-step-range-fill');
        const badge = shield?.querySelector<HTMLElement>('.td-step-range-badge');

        startBipolarDrag(
            e,
            targetDest,
            (newSpread) => {
                const colors = getRangeColor(-newSpread, newSpread);
                const spreadStr = newSpread > 0 ? `±${newSpread}%` : '0%';
                if (stepFill) {
                    stepFill.style.height = `${newSpread}%`;
                    stepFill.style.background = colors.border;
                    stepFill.style.boxShadow = `0 0 4px ${colors.border}`;
                }
                if (badge) {
                    badge.textContent = spreadStr;
                    badge.style.color = colors.text;
                }
                if (shield) {
                    shield.style.borderColor = colors.border;
                    shield.style.background = colors.bg;
                    shield.style.boxShadow = `0 0 6px ${colors.border}`;
                }
            },
            () => {
                mod.updateProperty('destinations', [...mod.properties.destinations]);
                this.updateVisualFeedback(container, node, isOverlayActive);
            }
        );
    }

    static getMappedSequenceRowDestinations(mod: any, fieldKey: string): RandomDestination[] {
        const currentDests: RandomDestination[] = Array.isArray(mod?.properties?.destinations)
            ? mod.properties.destinations
            : [];
        const all16Keys = Array.from({ length: 16 }, (_, i) => `step_parameters.${i}.${fieldKey}`);
        return all16Keys
            .map(key => currentDests.find(dest => dest.paramKey === key))
            .filter((dest): dest is RandomDestination => Boolean(dest?.enabled));
    }

    static startDragOnSequenceRowLabel(
        e: PointerEvent,
        rowLabel: HTMLElement,
        targets: RandomDestination[],
        mod: any,
        node: BaseNode,
        container: HTMLElement,
        isOverlayActive: boolean
    ) {
        if (targets.length === 0) return;

        // Use a copy as the drag anchor, then apply the resulting spread to
        // every currently mapped step without changing destination activation.
        const dragTarget = { ...targets[0] };
        const initialSpreads = targets.map(dest => Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent)));
        const initialAnchorSpread = Math.max(Math.abs(dragTarget.minPercent), Math.abs(dragTarget.maxPercent));
        startBipolarDrag(
            e,
            dragTarget,
            (newSpread) => {
                const spreadDelta = newSpread - initialAnchorSpread;
                targets.forEach((dest, index) => {
                    const adjustedSpread = Math.max(0, Math.min(100, initialSpreads[index] + spreadDelta));
                    dest.minPercent = -adjustedSpread;
                    dest.maxPercent = adjustedSpread;
                });
                rowLabel.title = `${targets.length} mapped ${rowLabel.dataset.rowFieldLabel || 'steps'}: ${newSpread > 0 ? `±${newSpread}%` : '0%'}\nRelease to apply`;
            },
            () => {
                mod.updateProperty('destinations', [...mod.properties.destinations]);
                this.updateVisualFeedback(container, node, isOverlayActive);
            }
        );
    }

    static updateVisualFeedback(container: HTMLElement, node: BaseNode, isOverlayActive: boolean) {
        this.closePopover();
        const modifierNode = this.getAttachedRandomModifier(node);
        const destinations: RandomDestination[] = modifierNode?.properties?.destinations || [];
        const destMap = new Map<string, RandomDestination>(destinations.map(d => [d.paramKey, d]));

        // 1. Regular parameter rows
        const rows = container.querySelectorAll<HTMLElement>('.td-param-row[data-field-key]');
        rows.forEach(row => {
            const key = row.getAttribute('data-field-key');
            if (!key) return;

            // Strict check: only numeric fields can be modulated by randomizer
            if (!isFieldMappableToRandom(node, key)) {
                const nonMappableShield = row.querySelector<HTMLElement>('.td-param-overlay-shield');
                if (nonMappableShield) nonMappableShield.remove();
                const nonMappableBadge = row.querySelector<HTMLElement>('.td-random-row-badge');
                if (nonMappableBadge) nonMappableBadge.remove();
                row.querySelectorAll<HTMLElement>('input, select, textarea, button').forEach(ctrl => {
                    ctrl.style.pointerEvents = '';
                    ctrl.removeAttribute('tabindex');
                });
                row.onpointerdown = null;
                return;
            }

            const dest = destMap.get(key);
            const isMapped = Boolean(dest && dest.enabled);

            row.classList.toggle('td-random-overlay-active-mode', isOverlayActive);
            row.classList.toggle('td-random-is-mapped', isMapped);

            const spread = dest ? Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent)) : 10;
            const spreadStr = spread > 0 ? `±${spread}%` : '0%';
            const colors = getRangeColor(dest ? dest.minPercent : -10, dest ? dest.maxPercent : 10);

            // Update or create random badge on label
            let badge = row.querySelector<HTMLElement>('.td-random-row-badge');
            if (dest) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'td-random-row-badge';
                    badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-left: 6px; display: inline-flex; align-items: center; cursor: ew-resize; user-select: none; transition: background 0.15s ease, border-color 0.15s ease;';
                    const label = row.querySelector('.td-param-label');
                    if (label) label.appendChild(badge);
                }
                badge.style.background = dest.enabled ? colors.bg : 'rgba(100, 116, 139, 0.2)';
                badge.style.border = `1px solid ${dest.enabled ? colors.border : '#475569'}`;
                badge.style.color = dest.enabled ? colors.text : '#94a3b8';
                badge.textContent = spreadStr;
                badge.title = 'Drag horizontally to adjust ± range (or Ctrl+Drag)';

                badge.onpointerdown = (e: PointerEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const mod = this.getAttachedRandomModifier(node);
                    if (mod && dest) {
                        this.startDragOnRow(e, row, dest, mod, node, container, isOverlayActive);
                    }
                };
            } else if (badge) {
                badge.remove();
            }

            // Visual spread feedback on slider inputs
            const slider = row.querySelector<HTMLInputElement>('input[type="range"]');
            if (slider) {
                this.updateSliderGradient(slider, dest, colors);
            }

            // --- OVERLAY SHIELD: LOCKS NORMAL EDITING WHEN IN OVERLAY MODE ---
            let shield = row.querySelector<HTMLElement>('.td-param-overlay-shield');

            if (isOverlayActive) {
                row.style.position = 'relative';

                // Lock all interactive controls in row so editing is completely prevented
                row.querySelectorAll<HTMLElement>('input, select, textarea, button').forEach(ctrl => {
                    if (ctrl.classList.contains('td-param-overlay-shield') || ctrl.closest('.td-param-overlay-shield')) return;
                    ctrl.style.pointerEvents = 'none';
                    ctrl.setAttribute('tabindex', '-1');
                });

                if (!shield) {
                    shield = document.createElement('div');
                    shield.className = 'td-param-overlay-shield';
                    row.appendChild(shield);
                }

                shield.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    z-index: 50;
                    cursor: pointer;
                    border-radius: 5px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0 8px;
                    box-sizing: border-box;
                    user-select: none;
                    transition: border-color 0.15s ease, background 0.15s ease;
                    background: ${isMapped ? colors.bg : 'rgba(15, 23, 42, 0.65)'};
                    border: 1.5px ${isMapped ? 'solid' : 'dashed'} ${isMapped ? colors.border : 'rgba(236, 72, 153, 0.45)'};
                    box-shadow: ${isMapped ? `0 0 8px ${colors.border}44` : 'none'};
                `;

                if (isMapped && dest) {
                    shield.title = `${dest.paramLabel || key}: ${spreadStr} (Mapped)\nClick to unmap · Ctrl+Drag to adjust range`;
                    shield.innerHTML = `
                        <div class="shield-range-track" style="position: relative; flex: 1; height: 7px; background: rgba(15, 23, 42, 0.9); border: 1px solid ${colors.border}; border-radius: 3px; overflow: hidden; margin-right: 8px; pointer-events: none;">
                            <div class="shield-range-fill" style="position: absolute; left: ${Math.max(0, 50 - spread * 0.5)}%; width: ${spread}%; height: 100%; background: ${colors.border}; opacity: 0.75; box-shadow: 0 0 6px ${colors.border};"></div>
                            <div style="position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; background: #ffffff; transform: translateX(-50%); opacity: 0.9; z-index: 2;"></div>
                        </div>
                        <div class="shield-indicator" style="display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; color: ${colors.text}; background: #0f172a; border: 1px solid ${colors.border}; padding: 1px 7px; border-radius: 3px; pointer-events: none; flex-shrink: 0;">
                            ${spreadStr}
                        </div>
                    `;
                } else {
                    shield.title = `Click to map ${key} to Randomizer · Ctrl+Drag for range`;
                    shield.innerHTML = `
                        <div style="flex: 1;"></div>
                        <div class="shield-indicator" style="display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600; color: #f472b6; background: #0f172a; border: 1px dashed rgba(236, 72, 153, 0.5); padding: 2px 7px; border-radius: 3px; pointer-events: none; flex-shrink: 0;">
                            + Map
                        </div>
                    `;
                }

                // Hover styling
                shield.onmouseenter = () => {
                    shield!.style.borderColor = isMapped ? colors.text : '#ec4899';
                    shield!.style.background = isMapped ? colors.bg : 'rgba(236, 72, 153, 0.2)';
                };
                shield.onmouseleave = () => {
                    shield!.style.borderColor = isMapped ? colors.border : 'rgba(236, 72, 153, 0.45)';
                    shield!.style.background = isMapped ? colors.bg : 'rgba(15, 23, 42, 0.65)';
                };

                shield.onpointerdown = (e: PointerEvent) => {
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        const mod = this.getOrCreateRandomModifier(node);
                        let targetDest = mod.properties.destinations?.find((d: RandomDestination) => d.paramKey === key);
                        if (!targetDest) {
                            const labelText = row.getAttribute('data-param-label') || key;
                            const currentVal = this.getWorkingVal(node, key, 0);
                            targetDest = {
                                id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                                paramKey: key,
                                paramLabel: labelText,
                                minPercent: -10,
                                maxPercent: 10,
                                baseValue: currentVal,
                                enabled: true
                            };
                            mod.properties.destinations = [...(mod.properties.destinations || []), targetDest];
                            mod.updateProperty('destinations', mod.properties.destinations);
                            this.updateVisualFeedback(container, node, isOverlayActive);
                        }
                        this.startDragOnRow(e, row, targetDest, mod, node, container, isOverlayActive);
                    }
                };
                shield.onmousedown = (e) => e.stopPropagation();

                shield.onclick = (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey) return; // Handled by drag

                    // Normal click: toggle mapping
                    const mod = this.getOrCreateRandomModifier(node);
                    const currentDests: RandomDestination[] = mod.properties.destinations || [];
                    const foundIndex = currentDests.findIndex(d => d.paramKey === key);

                    if (foundIndex >= 0) {
                        currentDests.splice(foundIndex, 1);
                    } else {
                        const labelText = row.getAttribute('data-param-label') || key;
                        const currentVal = this.getWorkingVal(node, key, 0);
                        currentDests.push({
                            id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                            paramKey: key,
                            paramLabel: labelText,
                            minPercent: -10,
                            maxPercent: 10,
                            baseValue: currentVal,
                            enabled: true
                        });
                    }

                    mod.updateProperty('destinations', [...currentDests]);
                    this.updateVisualFeedback(container, node, isOverlayActive);
                };

                shield.onwheel = (e: WheelEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const mod = this.getOrCreateRandomModifier(node);
                    let targetDest = (mod.properties.destinations || []).find((d: RandomDestination) => d.paramKey === key);
                    if (!targetDest) {
                        // Auto-map on first scroll
                        const labelText = row.getAttribute('data-param-label') || key;
                        const currentVal = this.getWorkingVal(node, key, 0);
                        targetDest = {
                            id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                            paramKey: key,
                            paramLabel: labelText,
                            minPercent: -1,
                            maxPercent: 1,
                            baseValue: currentVal,
                            enabled: true
                        };
                        mod.properties.destinations = [...(mod.properties.destinations || []), targetDest];
                    }
                    adjustSpreadByWheel(targetDest, e.deltaY);
                    mod.updateProperty('destinations', [...mod.properties.destinations]);
                    this.updateVisualFeedback(container, node, isOverlayActive);
                };
            } else {
                // When overlay mode is inactive, remove shield and re-enable inputs so parameters are editable normally
                if (shield) {
                    shield.remove();
                }
                row.querySelectorAll<HTMLElement>('input, select, textarea, button').forEach(ctrl => {
                    ctrl.style.pointerEvents = '';
                    ctrl.removeAttribute('tabindex');
                });
                row.onpointerdown = (e: PointerEvent) => {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        const mod = this.getOrCreateRandomModifier(node);
                        let targetDest = mod.properties.destinations?.find((d: RandomDestination) => d.paramKey === key);
                        if (!targetDest) {
                            const labelText = row.getAttribute('data-param-label') || key;
                            const currentVal = this.getWorkingVal(node, key, 0);
                            targetDest = {
                                id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                                paramKey: key,
                                paramLabel: labelText,
                                minPercent: -10,
                                maxPercent: 10,
                                baseValue: currentVal,
                                enabled: true
                            };
                            mod.properties.destinations = [...(mod.properties.destinations || []), targetDest];
                            mod.updateProperty('destinations', mod.properties.destinations);
                            this.updateVisualFeedback(container, node, isOverlayActive);
                        }
                        this.startDragOnRow(e, row, targetDest, mod, node, container, isOverlayActive);
                    }
                };
            }
        });

        // 2. Sequence Grid Step Value Controls (.td-step-value-control[data-field-key])
        const stepControls = container.querySelectorAll<HTMLElement>('.td-step-value-control[data-field-key]');
        stepControls.forEach(stepEl => {
            const key = stepEl.getAttribute('data-field-key');
            if (!key) return;

            if (!isFieldMappableToRandom(node, key)) {
                const sShield = stepEl.querySelector<HTMLElement>('.td-step-overlay-shield');
                if (sShield) sShield.remove();
                const stepInput = stepEl.querySelector<HTMLInputElement>('.td-step-value-input');
                if (stepInput) {
                    stepInput.style.pointerEvents = '';
                    stepInput.removeAttribute('tabindex');
                }
                stepEl.onpointerdown = null;
                return;
            }

            const dest = destMap.get(key);
            const isMapped = Boolean(dest && dest.enabled);
            const labelText = stepEl.getAttribute('data-param-label') || key;

            let shield = stepEl.querySelector<HTMLElement>('.td-step-overlay-shield');

            if (isOverlayActive) {
                stepEl.style.position = 'relative';

                // Lock the step's input from normal keyboard/wheel editing
                const stepInput = stepEl.querySelector<HTMLInputElement>('.td-step-value-input');
                if (stepInput) {
                    stepInput.style.pointerEvents = 'none';
                    stepInput.setAttribute('tabindex', '-1');
                }

                if (!shield) {
                    shield = document.createElement('div');
                    shield.className = 'td-step-overlay-shield';
                    stepEl.appendChild(shield);
                }

                const colors = dest ? getRangeColor(dest.minPercent, dest.maxPercent) : { bg: 'rgba(236, 72, 153, 0.15)', text: '#ec4899', border: '#ec4899' };
                const spread = dest ? Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent)) : 10;
                const spreadStr = spread > 0 ? `±${spread}%` : '0%';

                shield.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    z-index: 50;
                    cursor: pointer;
                    border-radius: 2px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    user-select: none;
                    box-sizing: border-box;
                    overflow: hidden;
                    transition: border-color 0.12s ease, background 0.12s ease;
                    background: ${isMapped ? colors.bg : 'rgba(15, 23, 42, 0.65)'};
                    border: ${isMapped ? `1.5px solid ${colors.border}` : '1px dashed rgba(236, 72, 153, 0.45)'};
                    box-shadow: ${isMapped ? `0 0 6px ${colors.border}` : 'none'};
                `;

                shield.title = isMapped && dest
                    ? `${labelText}: ${spreadStr} (Mapped)\nClick to unmap · Ctrl+Drag to adjust range`
                    : `Click to map ${labelText} to Randomizer · Ctrl+Drag for range`;

                if (isMapped && dest) {
                    shield.innerHTML = `
                        <div class="td-step-range-fill" style="position: absolute; bottom: 0; left: 0; right: 0; height: ${spread}%; background: ${colors.border}; opacity: 0.65; pointer-events: none;"></div>
                        <span class="td-step-range-badge" style="position: relative; z-index: 2; font-size: 8px; font-weight: 700; color: ${colors.text}; pointer-events: none; text-shadow: 0 1px 2px #000;">
                            ${spreadStr}
                        </span>
                    `;
                } else {
                    shield.innerHTML = `<span style="font-size: 9px; font-weight: 700; color: rgba(236, 72, 153, 0.9); line-height: 1; pointer-events: none;">+</span>`;
                }

                shield.onmouseenter = () => {
                    shield!.style.borderColor = isMapped ? colors.text : '#ec4899';
                    shield!.style.background = isMapped ? colors.bg : 'rgba(236, 72, 153, 0.25)';
                };
                shield.onmouseleave = () => {
                    shield!.style.borderColor = isMapped ? colors.border : 'rgba(236, 72, 153, 0.45)';
                    shield!.style.background = isMapped ? colors.bg : 'rgba(15, 23, 42, 0.65)';
                };

                shield.onpointerdown = (e: PointerEvent) => {
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        const mod = this.getOrCreateRandomModifier(node);
                        let targetDest = mod.properties.destinations?.find((d: RandomDestination) => d.paramKey === key);
                        if (!targetDest) {
                            const currentVal = this.getWorkingVal(node, key, 0);
                            targetDest = {
                                id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                                paramKey: key,
                                paramLabel: labelText,
                                minPercent: -10,
                                maxPercent: 10,
                                baseValue: currentVal,
                                enabled: true
                            };
                            mod.properties.destinations = [...(mod.properties.destinations || []), targetDest];
                            mod.updateProperty('destinations', mod.properties.destinations);
                            this.updateVisualFeedback(container, node, isOverlayActive);
                        }
                        this.startDragOnStep(e, stepEl, targetDest, mod, node, container, isOverlayActive);
                    }
                };
                shield.onmousedown = (e) => e.stopPropagation();

                shield.onclick = (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey) return; // Handled by drag

                    // Normal click: toggle mapping for this specific step
                    const mod = this.getOrCreateRandomModifier(node);
                    const currentDests: RandomDestination[] = mod.properties.destinations || [];
                    const foundIndex = currentDests.findIndex(d => d.paramKey === key);

                    if (foundIndex >= 0) {
                        currentDests.splice(foundIndex, 1);
                    } else {
                        const currentVal = this.getWorkingVal(node, key, 0);
                        currentDests.push({
                            id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                            paramKey: key,
                            paramLabel: labelText,
                            minPercent: -10,
                            maxPercent: 10,
                            baseValue: currentVal,
                            enabled: true
                        });
                    }

                    mod.updateProperty('destinations', [...currentDests]);
                    this.updateVisualFeedback(container, node, isOverlayActive);
                };

                shield.onwheel = (e: WheelEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const mod = this.getOrCreateRandomModifier(node);
                    let targetDest = (mod.properties.destinations || []).find((d: RandomDestination) => d.paramKey === key);
                    if (!targetDest) {
                        const currentVal = this.getWorkingVal(node, key, 0);
                        targetDest = {
                            id: `dst_${key}_${Math.random().toString(36).substring(2, 6)}`,
                            paramKey: key,
                            paramLabel: labelText,
                            minPercent: -1,
                            maxPercent: 1,
                            baseValue: currentVal,
                            enabled: true
                        };
                        mod.properties.destinations = [...(mod.properties.destinations || []), targetDest];
                    }
                    adjustSpreadByWheel(targetDest, e.deltaY);
                    mod.updateProperty('destinations', [...mod.properties.destinations]);
                    this.updateVisualFeedback(container, node, isOverlayActive);
                };
            } else {
                // When overlay is inactive, remove shield and restore input
                if (shield) shield.remove();
                const stepInput = stepEl.querySelector<HTMLInputElement>('.td-step-value-input');
                if (stepInput) {
                    stepInput.style.pointerEvents = '';
                    stepInput.removeAttribute('tabindex');
                }

                if (isMapped && dest) {
                    const colors = getRangeColor(dest.minPercent, dest.maxPercent);
                    const spread = Math.max(Math.abs(dest.minPercent), Math.abs(dest.maxPercent));
                    const spreadStr = spread > 0 ? `±${spread}%` : '0%';

                    stepEl.classList.add('td-step-is-mapped');
                    stepEl.style.boxShadow = `0 0 0 1.5px ${colors.border}`;
                    stepEl.title = `${labelText}: ${spreadStr}\nCtrl+Drag to adjust range`;
                    stepEl.onpointerdown = (e: PointerEvent) => {
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            e.stopPropagation();
                            const mod = this.getAttachedRandomModifier(node);
                            if (mod && dest) {
                                this.startDragOnStep(e, stepEl, dest, mod, node, container, isOverlayActive);
                            }
                        }
                    };
                } else {
                    stepEl.classList.remove('td-step-is-mapped');
                    stepEl.style.boxShadow = '';
                    stepEl.title = '';
                    stepEl.onpointerdown = null;
                }
            }
        });

        // 3. Batch mapping on Sequence row labels (.td-seq-row-label[data-row-field-key])
        const rowLabels = container.querySelectorAll<HTMLElement>('.td-seq-row-label[data-row-field-key]');
        rowLabels.forEach(rowLabel => {
            const fieldKey = rowLabel.dataset.rowFieldKey;
            const fieldLabel = rowLabel.dataset.rowFieldLabel || fieldKey;
            if (!fieldKey) return;
            let suppressNextClick = false;

            if (isOverlayActive) {
                rowLabel.style.cursor = 'pointer';
                rowLabel.style.transition = 'all 0.15s ease';
                rowLabel.title = `Click to toggle random mapping for all 16 ${fieldLabel} steps`;

                rowLabel.onmouseenter = () => {
                    rowLabel.style.color = '#ec4899';
                    rowLabel.style.textDecoration = 'underline';
                };
                rowLabel.onmouseleave = () => {
                    rowLabel.style.color = '';
                    rowLabel.style.textDecoration = '';
                };

                rowLabel.onpointerdown = (e: PointerEvent) => {
                    if (!(e.ctrlKey || e.metaKey)) return;

                    const mod = this.getAttachedRandomModifier(node);
                    const targets = this.getMappedSequenceRowDestinations(mod, fieldKey);
                    if (!mod || targets.length === 0) return;

                    e.preventDefault();
                    e.stopPropagation();
                    suppressNextClick = true;
                    this.startDragOnSequenceRowLabel(e, rowLabel, targets, mod, node, container, isOverlayActive);
                };

                rowLabel.onwheel = (e: WheelEvent) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const mod = this.getAttachedRandomModifier(node);
                    const targets = this.getMappedSequenceRowDestinations(mod, fieldKey);
                    if (!mod || targets.length === 0) return;

                    targets.forEach(dest => adjustSpreadByWheel(dest, e.deltaY));
                    mod.updateProperty('destinations', [...mod.properties.destinations]);
                    this.updateVisualFeedback(container, node, isOverlayActive);
                };

                rowLabel.onclick = (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (suppressNextClick) {
                        suppressNextClick = false;
                        return;
                    }
                    if (e.ctrlKey || e.metaKey) return;
                    const mod = this.getOrCreateRandomModifier(node);
                    const currentDests: RandomDestination[] = mod.properties.destinations || [];
                    const all16Keys = Array.from({ length: 16 }, (_, i) => `step_parameters.${i}.${fieldKey}`);
                    const allMapped = all16Keys.every(k => currentDests.some(d => d.paramKey === k && d.enabled));

                    let nextDests = [...currentDests];
                    if (allMapped) {
                        // Unmap all 16
                        nextDests = nextDests.filter(d => !all16Keys.includes(d.paramKey));
                    } else {
                        // Map all 16
                        all16Keys.forEach((k, i) => {
                            if (!nextDests.some(d => d.paramKey === k)) {
                                const stepVal = Number(node.properties?.step_parameters?.[i]?.[fieldKey] ?? 0);
                                nextDests.push({
                                    id: `dst_${k}_${Math.random().toString(36).substring(2, 6)}`,
                                    paramKey: k,
                                    paramLabel: `Step ${i + 1} ${fieldLabel}`,
                                    minPercent: -10,
                                    maxPercent: 10,
                                    baseValue: Number.isFinite(stepVal) ? stepVal : 0,
                                    enabled: true
                                });
                            }
                        });
                    }
                    mod.updateProperty('destinations', nextDests);
                    this.updateVisualFeedback(container, node, isOverlayActive);
                };
            } else {
                rowLabel.style.cursor = '';
                rowLabel.style.color = '';
                rowLabel.style.textDecoration = '';
                rowLabel.title = '';
                rowLabel.onclick = null;
                rowLabel.onmouseenter = null;
                rowLabel.onmouseleave = null;
            }
        });
    }

    static closePopover() {
        const indicator = document.getElementById('td-bipolar-drag-indicator');
        if (indicator) indicator.style.display = 'none';
    }
}
