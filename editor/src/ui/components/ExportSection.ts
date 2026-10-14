import { BaseNode } from '../../nodes/BaseNode.ts';
import { WidgetFactory } from '../WidgetFactory.ts';
import { type FieldSchema } from '../../fields/FieldSchema.ts';

interface DirectoryListing {
    current_path: string;
    absolute_path: string;
    parent_path: string | null;
    directories: string[];
    roots: Array<{ name: string; path: string }>;
}

async function fetchDirectories(path?: string): Promise<DirectoryListing | null> {
    try {
        const query = path != null ? `?path=${encodeURIComponent(path)}` : '';
        const res = await fetch(`/api/directories${query}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error('Failed to fetch directories', e);
        return null;
    }
}

if (typeof window !== 'undefined' && !(window as any).__sinFolderPickerModalListener) {
    (window as any).__sinFolderPickerModalListener = true;
    window.addEventListener('open-folder-picker', (e: any) => {
        ExportSection.openFolderPickerModal(e.detail?.initialPath || 'exports', e.detail?.onSelect);
    });
}

export class ExportSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        _windowContext: any
    ): Promise<void> {
        const group = document.createElement('div');
        group.className = 'td-param-group';

        // Parse existing export directory into root & subfolder
        const fullDir = (node.properties?.export_directory || 'exports').trim() || 'exports';
        let currentRoot = node.properties?.export_root;
        let currentSubfolder = node.properties?.export_subfolder;

        if (currentRoot === undefined) {
            const parts = fullDir.split(/[\\/]/).filter(Boolean);
            if (parts.length > 1) {
                currentRoot = parts[0];
                currentSubfolder = parts.slice(1).join('/');
            } else {
                currentRoot = fullDir;
                currentSubfolder = '';
            }
            node.updateProperty('export_root', currentRoot);
            node.updateProperty('export_subfolder', currentSubfolder);
        }

        const syncFullDirectory = () => {
            const root = (node.properties?.export_root || 'exports').trim() || 'exports';
            const sub = (node.properties?.export_subfolder || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
            const combined = sub ? `${root}/${sub}` : root;
            node.updateProperty('export_directory', combined);
            updatePreview();
        };

        const exportFieldsMap = new Map<string, FieldSchema>();
        for (const f of BaseNode.exportFields) {
            exportFieldsMap.set(f.key, f);
        }

        // --- Step 1: Root Folder (via WidgetFactory) ---
        const rootField = exportFieldsMap.get('export_root') || {
            key: 'export_root',
            label: 'Root Folder',
            type: 'directory',
            default: 'exports',
            tab: 'EXPORT',
            description: 'Root folder for rendered audio'
        };
        const rootRow = WidgetFactory.createRow(rootField, node, (_key, _val, _prev) => {
            syncFullDirectory();
            void refreshSubfolderDatalist();
        });
        group.appendChild(rootRow);

        // --- Step 2: Subfolder (via WidgetFactory) ---
        const subField = exportFieldsMap.get('export_subfolder') || {
            key: 'export_subfolder',
            label: 'Subfolder',
            type: 'string',
            default: '',
            tab: 'EXPORT',
            placeholder: 'e.g. stems (creates if new)',
            description: 'Subfolder search or naming (auto-created if new)'
        };
        const subRow = WidgetFactory.createRow(subField, node, (_key, _val, _prev) => {
            syncFullDirectory();
        });
        const subInput = subRow.querySelector('input') as HTMLInputElement | null;
        const datalistId = `subfolders-list-${node.id}`;
        const datalist = document.createElement('datalist');
        datalist.id = datalistId;
        if (subInput) {
            subInput.setAttribute('list', datalistId);
            subInput.addEventListener('focus', () => void refreshSubfolderDatalist());
            subInput.addEventListener('input', () => {
                node.updateProperty('export_subfolder', subInput.value);
                syncFullDirectory();
            });
            subRow.querySelector('.td-param-control')?.appendChild(datalist);
        }
        group.appendChild(subRow);

        const refreshSubfolderDatalist = async () => {
            const currentRootVal = (node.properties?.export_root || 'exports').trim() || 'exports';
            const listing = await fetchDirectories(currentRootVal);
            datalist.innerHTML = '';
            if (listing && Array.isArray(listing.directories)) {
                for (const d of listing.directories) {
                    const opt = document.createElement('option');
                    opt.value = d;
                    datalist.appendChild(opt);
                }
            }
        };
        void refreshSubfolderDatalist();

        // --- Step 3: Pattern (via WidgetFactory) ---
        const patternField = exportFieldsMap.get('export_pattern') || {
            key: 'export_pattern',
            label: 'Pattern',
            type: 'string',
            default: '{project}_{name}_{idx}',
            tab: 'EXPORT',
            description: 'Filename pattern with variables: {project}, {name}, {idx}, {bpm}, {bars}, {key}, {date}, {time}, {type}'
        };
        const patternRow = WidgetFactory.createRow(patternField, node, (_key, _val, _prev) => {
            updatePreview();
        });
        group.appendChild(patternRow);

        const patternInput = patternRow.querySelector('input') as HTMLInputElement | null;
        if (patternInput) {
            patternInput.addEventListener('input', () => {
                node.updateProperty('export_pattern', patternInput.value);
                updatePreview();
            });
        }

        // --- Step 3b: Variables Field (Togglable from the name, wrapping cloud) ---
        const variablesRow = document.createElement('div');
        variablesRow.className = 'td-param-row td-variables-row';
        variablesRow.setAttribute('data-param-label', 'Variables');

        let isCloudOpen = typeof sessionStorage !== 'undefined'
            ? sessionStorage.getItem('sin.exportVariablesOpen') === 'true'
            : false;

        const variablesLabel = document.createElement('div');
        variablesLabel.className = 'td-param-label td-variables-toggle-label';
        variablesLabel.title = 'Click to toggle variables cloud';
        variablesLabel.setAttribute('role', 'button');
        variablesLabel.setAttribute('tabindex', '0');

        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'td-variables-arrow';
        const labelTextSpan = document.createElement('span');
        labelTextSpan.className = 'td-variables-label-text';
        labelTextSpan.textContent = 'Variables';

        variablesLabel.append(arrowSpan, labelTextSpan);

        const variablesControl = document.createElement('div');
        variablesControl.className = 'td-param-control';

        const cloudContainer = document.createElement('div');
        cloudContainer.className = 'td-variables-cloud';

        const collapsedHint = document.createElement('span');
        collapsedHint.className = 'td-variables-collapsed-hint';
        collapsedHint.textContent = 'Click to show tokens…';
        collapsedHint.title = 'Click to show variable chips';

        const updateToggleState = () => {
            arrowSpan.textContent = isCloudOpen ? '▾' : '▸';
            variablesLabel.setAttribute('aria-expanded', String(isCloudOpen));
            cloudContainer.style.display = isCloudOpen ? 'flex' : 'none';
            collapsedHint.style.display = isCloudOpen ? 'none' : 'inline';
            variablesRow.classList.toggle('is-open', isCloudOpen);
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('sin.exportVariablesOpen', String(isCloudOpen));
            }
        };

        const toggleCloud = () => {
            isCloudOpen = !isCloudOpen;
            updateToggleState();
        };

        variablesLabel.addEventListener('click', toggleCloud);
        variablesLabel.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleCloud();
            }
        });
        collapsedHint.addEventListener('click', toggleCloud);

        const availableTokens = [
            '{project}', '{name}', '{idx}', '{bpm}', '{bars}', '{key}', '{date}', '{time}', '{type}'
        ];

        for (const token of availableTokens) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'td-token-chip';
            chip.textContent = token;
            chip.title = `Insert ${token} into Pattern`;
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                if (!patternInput) return;
                let val = patternInput.value;
                const start = patternInput.selectionStart ?? val.length;
                const end = patternInput.selectionEnd ?? val.length;
                val = val.substring(0, start) + token + val.substring(end);
                patternInput.value = val;
                patternInput.focus();
                const pos = start + token.length;
                patternInput.setSelectionRange(pos, pos);
                node.updateProperty('export_pattern', val);
                updatePreview();
            });
            cloudContainer.appendChild(chip);
        }

        variablesControl.appendChild(collapsedHint);
        variablesControl.appendChild(cloudContainer);
        variablesRow.appendChild(variablesLabel);
        variablesRow.appendChild(variablesControl);
        group.appendChild(variablesRow);

        updateToggleState();

        // --- Step 4: Conflict Mode (via WidgetFactory -> RadioGroup) ---
        const conflictField = exportFieldsMap.get('export_overwrite_mode') || {
            key: 'export_overwrite_mode',
            label: 'Conflict',
            type: 'radio',
            default: 'incremental',
            options: [
                { value: 'incremental', label: 'Incremental' },
                { value: 'overwrite', label: 'Overwrite' }
            ],
            tab: 'EXPORT',
            description: 'How to handle existing files with the same name'
        };
        const conflictRow = WidgetFactory.createRow(conflictField, node, (_key, _val, _prev) => {
            updatePreview();
        });
        group.appendChild(conflictRow);

        // --- Step 5: Non-interactive Italic Demo Line with Minimal Render Button ---
        const previewRow = document.createElement('div');
        previewRow.className = 'td-param-row td-export-preview-row';
        previewRow.setAttribute('data-param-label', 'Preview');

        const previewLabel = document.createElement('div');
        previewLabel.className = 'td-param-label';
        previewLabel.textContent = 'Preview';

        const previewControl = document.createElement('div');
        previewControl.className = 'td-param-control';
        previewControl.style.display = 'flex';
        previewControl.style.alignItems = 'center';
        previewControl.style.justifyContent = 'space-between';
        previewControl.style.gap = '8px';

        const previewPathEl = document.createElement('span');
        previewPathEl.className = 'td-export-preview-path';
        previewPathEl.title = 'Target preview path';

        const minimalRenderBtn = document.createElement('button');
        minimalRenderBtn.type = 'button';
        minimalRenderBtn.className = 'td-param-action-btn td-render-btn';
        minimalRenderBtn.textContent = 'Render';
        minimalRenderBtn.title = 'Render audio to destination path';

        minimalRenderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            minimalRenderBtn.disabled = true;
            minimalRenderBtn.classList.remove('is-success');
            minimalRenderBtn.textContent = 'Rendering…';

            const onComplete = (event: any) => {
                if (event.detail?.nodeId === node.id) {
                    window.removeEventListener('render-completed', onComplete);
                    window.removeEventListener('render-failed', onFailed);
                    minimalRenderBtn.disabled = false;
                    minimalRenderBtn.classList.add('is-success');
                    minimalRenderBtn.textContent = '✓ Saved';
                    setTimeout(() => {
                        minimalRenderBtn.classList.remove('is-success');
                        minimalRenderBtn.textContent = 'Render';
                    }, 2500);
                }
            };

            const onFailed = (event: any) => {
                if (event.detail?.nodeId === node.id) {
                    window.removeEventListener('render-completed', onComplete);
                    window.removeEventListener('render-failed', onFailed);
                    minimalRenderBtn.disabled = false;
                    minimalRenderBtn.classList.remove('is-success');
                    minimalRenderBtn.textContent = '✕ Error';
                    setTimeout(() => {
                        minimalRenderBtn.textContent = 'Render';
                    }, 3000);
                }
            };

            window.addEventListener('render-completed', onComplete);
            window.addEventListener('render-failed', onFailed);
            window.dispatchEvent(new CustomEvent('render-node', { detail: { nodeId: node.id } }));
        });

        previewControl.appendChild(previewPathEl);
        previewControl.appendChild(minimalRenderBtn);
        previewRow.appendChild(previewLabel);
        previewRow.appendChild(previewControl);
        group.appendChild(previewRow);

        function updatePreview() {
            const root = (node.properties?.export_root || 'exports').trim() || 'exports';
            const sub = (node.properties?.export_subfolder || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
            const rawDir = sub ? `${root}/${sub}` : root;

            let pattern = (node.properties?.export_pattern || '{project}_{name}_{idx}').trim() || '{project}_{name}_{idx}';
            if (pattern.endsWith('.wav')) pattern = pattern.slice(0, -4);

            const projectName = (
                node.properties?.project_name
                || (typeof window !== 'undefined' && typeof (window as any).getProjectName === 'function' ? (window as any).getProjectName() : null)
                || (typeof document !== 'undefined' ? (document.querySelector('#workspace-preset-select') as HTMLSelectElement)?.value : null)
                || 'project'
            ).replace(/[^\w\-.]/g, '_');
            const nodeName = (node.properties?.node_name || node.title || 'audio').replace(/[^\w\-.]/g, '_');
            const bpm = node.properties?.bpm || node.properties?.target_bpm || 120;
            const bars = node.properties?.total_bars || 4;
            const key = node.properties?.key || 'nokey';
            const type = node.nodeType || 'track';
            const id = String(node.id);

            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const dateStr = `${yyyy}${mm}${dd}`;

            const hh = String(now.getHours()).padStart(2, '0');
            const min = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            const timeStr = `${hh}${min}${ss}`;

            let evaluated = pattern
                .replace(/\{project\}/g, projectName)
                .replace(/\{project_name\}/g, projectName)
                .replace(/\{name\}/g, nodeName)
                .replace(/\{node_name\}/g, nodeName)
                .replace(/\{bpm\}/g, String(bpm))
                .replace(/\{bars\}/g, String(bars))
                .replace(/\{key\}/g, String(key))
                .replace(/\{type\}/g, type)
                .replace(/\{id\}/g, id)
                .replace(/\{date\}/g, dateStr)
                .replace(/\{time\}/g, timeStr)
                .replace(/\{datetime\}/g, `${dateStr}_${timeStr}`);

            const isOverwrite = node.properties?.export_overwrite_mode === 'overwrite';

            if (evaluated.includes('{idx}') || evaluated.includes('{incremental}')) {
                evaluated = evaluated.replace(/\{idx\}/g, isOverwrite ? '001' : '001').replace(/\{incremental\}/g, isOverwrite ? '001' : '001');
            }

            const cleanDir = rawDir.replace(/\\/g, '/').replace(/\/+$/, '');
            previewPathEl.textContent = `${cleanDir}/${evaluated}.wav`;
        }

        const onProjectChanged = () => updatePreview();
        window.addEventListener('project-name-changed', onProjectChanged);

        updatePreview();
        container.appendChild(group);
    }

    /**
     * Unified lightweight dynamic folder picker modal dialog.
     */
    static openFolderPickerModal(initialPath: string, onSelect: (folderPath: string) => void): void {
        const overlay = document.createElement('div');
        overlay.className = 'sin-modal folder-picker-overlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(15, 23, 42, 0.45)';
        overlay.style.backdropFilter = 'blur(2px)';
        overlay.style.zIndex = '10000';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const modal = document.createElement('div');
        modal.className = 'folder-picker-modal';

        // Modal Header
        const header = document.createElement('div');
        header.className = 'folder-picker-header';
        header.innerHTML = `
            <h4>Select Root Folder</h4>
            <button type="button" class="close-picker-btn td-param-action-btn" style="border: none; background: transparent; font-size: 13px; padding: 0 4px;">✕</button>
        `;
        modal.appendChild(header);

        // Path / Breadcrumb Bar
        const pathBar = document.createElement('div');
        pathBar.className = 'folder-picker-pathbar';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'td-param-action-btn';
        upBtn.innerHTML = '⬆ Up';

        const currentPathDisplay = document.createElement('span');
        currentPathDisplay.style.fontFamily = 'monospace';
        currentPathDisplay.style.fontSize = '11px';
        currentPathDisplay.style.color = '#0284c7';
        currentPathDisplay.style.overflow = 'hidden';
        currentPathDisplay.style.textOverflow = 'ellipsis';
        currentPathDisplay.style.whiteSpace = 'nowrap';
        currentPathDisplay.style.flex = '1';

        pathBar.appendChild(upBtn);
        pathBar.appendChild(currentPathDisplay);
        modal.appendChild(pathBar);

        // Quick Roots Bar
        const rootsBar = document.createElement('div');
        rootsBar.className = 'folder-picker-roots';
        modal.appendChild(rootsBar);

        // Folder List Container
        const listContainer = document.createElement('div');
        listContainer.className = 'folder-picker-list';
        modal.appendChild(listContainer);

        // Footer Actions
        const footer = document.createElement('div');
        footer.className = 'folder-picker-footer';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'td-param-action-btn';
        cancelBtn.textContent = 'Cancel';

        const selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.className = 'td-param-action-btn td-param-action-primary';
        selectBtn.textContent = 'Select This Folder';

        footer.appendChild(cancelBtn);
        footer.appendChild(selectBtn);
        modal.appendChild(footer);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        let activePath = initialPath.trim() || 'exports';

        const loadDirectory = async (target: string) => {
            listContainer.innerHTML = '<span style="color: #64748b; font-size: 11px; padding: 8px;">Loading folders…</span>';
            const listing = await fetchDirectories(target);
            if (!listing) {
                listContainer.innerHTML = '<span style="color: #ef4444; font-size: 11px; padding: 8px;">Could not list directories.</span>';
                return;
            }

            activePath = listing.current_path || '';
            currentPathDisplay.textContent = activePath ? `/${activePath}` : '/ (workspace root)';

            upBtn.disabled = listing.parent_path == null;
            upBtn.style.opacity = listing.parent_path == null ? '0.4' : '1';
            upBtn.onclick = () => {
                if (listing.parent_path != null) void loadDirectory(listing.parent_path);
            };

            // Render roots
            rootsBar.innerHTML = '<span style="font-weight: 500;">Roots:</span>';
            for (const r of listing.roots) {
                const rBtn = document.createElement('button');
                rBtn.type = 'button';
                rBtn.className = 'td-param-action-btn';
                rBtn.style.height = '18px';
                rBtn.style.fontSize = '9px';
                rBtn.style.padding = '0 5px';
                rBtn.textContent = r.name;
                rBtn.onclick = () => void loadDirectory(r.path);
                rootsBar.appendChild(rBtn);
            }

            // Render subdirectories
            listContainer.innerHTML = '';
            if (!listing.directories || listing.directories.length === 0) {
                listContainer.innerHTML = '<span style="color: #94a3b8; font-size: 11px; padding: 8px; font-style: italic;">No subdirectories found.</span>';
            } else {
                for (const d of listing.directories) {
                    const row = document.createElement('div');
                    row.className = 'folder-picker-item';
                    row.innerHTML = `<span style="font-size: 13px;">📁</span> <span>${d}</span>`;
                    row.addEventListener('click', () => {
                        const nextTarget = activePath ? `${activePath}/${d}` : d;
                        void loadDirectory(nextTarget);
                    });
                    listContainer.appendChild(row);
                }
            }
        };

        const close = () => overlay.remove();
        header.querySelector('.close-picker-btn')?.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });

        selectBtn.addEventListener('click', () => {
            onSelect(activePath || 'exports');
            close();
        });

        void loadDirectory(activePath);
    }
}
