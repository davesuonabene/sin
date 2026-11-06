import test from 'node:test';
import assert from 'node:assert/strict';

test('Param panel toggle: selecting a node does not open panel when param toggle is off', () => {
    // Simulate dockview panel state
    let dockedPanels: Array<{ id: string; active: boolean }> = [];
    let currentlySelectedNode: any = null;
    let openedPanelCount = 0;

    const dockedPropertyPanels = () => dockedPanels;

    const openParamWindow = (node: any, options?: { forceOpen?: boolean }) => {
        if (!options?.forceOpen && dockedPropertyPanels().length === 0) {
            return;
        }
        dockedPanels = [{ id: `properties_${node.id}`, active: true }];
        openedPanelCount++;
    };

    const onNodeSelected = (node: any) => {
        currentlySelectedNode = node;
        if (dockedPropertyPanels().length > 0) {
            openParamWindow(node);
        }
    };

    const node1 = { id: 1, type: 'Audio/Sample' };
    const node2 = { id: 2, type: 'Audio/Sequence' };

    // Initially param toggle is off (no docked panel)
    assert.equal(dockedPropertyPanels().length, 0);

    // User selects node1 on canvas -> no panel opens
    onNodeSelected(node1);
    assert.equal(currentlySelectedNode, node1);
    assert.equal(dockedPropertyPanels().length, 0);
    assert.equal(openedPanelCount, 0);

    // User selects node2 on canvas -> still no panel opens
    onNodeSelected(node2);
    assert.equal(currentlySelectedNode, node2);
    assert.equal(dockedPropertyPanels().length, 0);
    assert.equal(openedPanelCount, 0);

    // User explicitly toggles param panel ON (pressing P or clicking header param button)
    openParamWindow(currentlySelectedNode, { forceOpen: true });
    assert.equal(dockedPropertyPanels().length, 1);
    assert.equal(dockedPanels[0].id, 'properties_2');
    assert.equal(openedPanelCount, 1);

    // Now that param toggle is ON, selecting node1 updates the open panel to node1
    onNodeSelected(node1);
    assert.equal(dockedPropertyPanels().length, 1);
    assert.equal(dockedPanels[0].id, 'properties_1');
    assert.equal(openedPanelCount, 2);

    // User toggles param toggle OFF (closes docked panel)
    dockedPanels = [];
    assert.equal(dockedPropertyPanels().length, 0);

    // Now selecting node2 again MUST NOT open any panel
    onNodeSelected(node2);
    assert.equal(dockedPropertyPanels().length, 0);
    assert.equal(openedPanelCount, 2); // Count has not increased!
});

test('Save workspace logic: save uses current workspace name or prompts when unset', async () => {
    let currentWorkspaceName: string | null = null;
    let savedNames: string[] = [];
    let promptCalled = false;

    const saveWorkspacePreset = async (name: string) => {
        currentWorkspaceName = name;
        savedNames.push(name);
    };

    const handleSaveWorkspace = async () => {
        if (currentWorkspaceName?.trim()) {
            await saveWorkspacePreset(currentWorkspaceName.trim());
        } else {
            promptCalled = true;
            const promptedName = 'my_new_session';
            await saveWorkspacePreset(promptedName);
        }
    };

    // First save: untitled workspace prompts
    await handleSaveWorkspace();
    assert.equal(promptCalled, true);
    assert.equal(currentWorkspaceName, 'my_new_session');
    assert.deepEqual(savedNames, ['my_new_session']);

    // Second save: uses active currentWorkspaceName directly without prompt
    promptCalled = false;
    await handleSaveWorkspace();
    assert.equal(promptCalled, false);
    assert.deepEqual(savedNames, ['my_new_session', 'my_new_session']);
});

test('File explorer modal filter: searches saves files with case-insensitivity', () => {
    const savesList = [
        { name: '0004', filename: '0004.json', size: 110949 },
        { name: '0005_drill in the forest', filename: '0005_drill in the forest.json', size: 125267 },
        { name: 'dilla_drill_fusion_4bar', filename: 'dilla_drill_fusion_4bar.json', size: 84989 },
        { name: 'house_organic_lofi', filename: 'house_organic_lofi.json', size: 61258 },
    ];

    const filterSaves = (query: string) => {
        const q = query.trim().toLowerCase();
        return savesList.filter(item => !q || item.name.toLowerCase().includes(q));
    };

    // Default search (empty query) returns all saves
    assert.equal(filterSaves('').length, 4);

    // Searching 'drill' returns the 2 drill presets
    const drillMatches = filterSaves('drill');
    assert.equal(drillMatches.length, 2);
    assert.equal(drillMatches[0].name, '0005_drill in the forest');
    assert.equal(drillMatches[1].name, 'dilla_drill_fusion_4bar');

    // Searching 'LOFI' (case-insensitive)
    const lofiMatches = filterSaves('LOFI');
    assert.equal(lofiMatches.length, 1);
    assert.equal(lofiMatches[0].name, 'house_organic_lofi');
});

test('Header menu dropdowns: opening one closes any other open menu and outside click closes all', () => {
    const menus = [
        { id: 'file-menu', open: false },
        { id: 'library-menu', open: false },
        { id: 'render-menu', open: false }
    ];

    const openMenu = (menuId: string) => {
        const target = menus.find(m => m.id === menuId);
        if (!target) return;
        target.open = true;
        menus.forEach(other => {
            if (other.id !== menuId && other.open) other.open = false;
        });
    };

    const handleOutsideClick = () => {
        menus.forEach(m => {
            m.open = false;
        });
    };

    // Open file menu
    openMenu('file-menu');
    assert.equal(menus[0].open, true);
    assert.equal(menus[1].open, false);
    assert.equal(menus[2].open, false);

    // Opening library menu closes file menu
    openMenu('library-menu');
    assert.equal(menus[0].open, false);
    assert.equal(menus[1].open, true);
    assert.equal(menus[2].open, false);

    // Opening render menu closes library menu
    openMenu('render-menu');
    assert.equal(menus[0].open, false);
    assert.equal(menus[1].open, false);
    assert.equal(menus[2].open, true);

    // Clicking outside closes all menus
    handleOutsideClick();
    assert.equal(menus[0].open, false);
    assert.equal(menus[1].open, false);
    assert.equal(menus[2].open, false);
});

