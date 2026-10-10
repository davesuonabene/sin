import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeRandomRefreshMode,
    shouldRefreshRandom,
    evaluateRelativeRandomValue,
    applyRandomModulation,
    restoreBaseValues,
    isFieldMappableToRandom,
    getRangeColor,
    type RandomDestination
} from '../../ermes/ts/randomResolver.ts';

const hierarchy = new Map([
    [1, { parentId: 2 }],
    [2, { parentId: 3 }],
    [3, { parentId: null }]
]);

test('normalizes random refresh-mode aliases', () => {
    assert.equal(normalizeRandomRefreshMode('local_refresh'), 'local');
    assert.equal(normalizeRandomRefreshMode('parent_refresh'), 'parent');
    assert.equal(normalizeRandomRefreshMode('global_refresh'), 'global');
    assert.equal(normalizeRandomRefreshMode('fixed'), 'off');
    assert.equal(normalizeRandomRefreshMode('manual'), 'local');
});

test('random refresh scopes match previewed graph hierarchy', () => {
    const preview = { kind: 'preview' as const, globalPreview: false };
    assert.equal(shouldRefreshRandom('local', 1, 1, hierarchy, preview), true);
    assert.equal(shouldRefreshRandom('local', 1, 3, hierarchy, preview), true);
    assert.equal(shouldRefreshRandom('local', 1, 3, hierarchy, { kind: 'render' }), true);
    assert.equal(shouldRefreshRandom('parent', 1, 1, hierarchy, preview), false);
    assert.equal(shouldRefreshRandom('parent', 1, 2, hierarchy, preview), true);
    assert.equal(shouldRefreshRandom('ancestor', 1, 3, hierarchy, preview), true);
    assert.equal(shouldRefreshRandom('parent', 1, 1, hierarchy, { kind: 'render' }), true);
    assert.equal(shouldRefreshRandom('ancestor', 1, 1, hierarchy, { kind: 'render' }), true);
    assert.equal(shouldRefreshRandom('off', 1, 1, hierarchy, preview), false);
});

test('global preview triggers global-mode random refresh', () => {
    const globalPreview = { kind: 'preview' as const, globalPreview: true };
    assert.equal(shouldRefreshRandom('global', 1, 3, hierarchy, globalPreview), true);
    assert.equal(shouldRefreshRandom('local', 1, 3, hierarchy, globalPreview), true);
    assert.equal(shouldRefreshRandom('ancestor', 1, 3, hierarchy, globalPreview), false);
    assert.equal(shouldRefreshRandom('global', 1, 3, hierarchy, { kind: 'render' }), true);
});

test('relative percentage evaluation applies correct offsets and limits', () => {
    // Parameter span: 0 to 100, span = 100. Base value = 50.
    // minPercent = -10%, maxPercent = +10%. Expected offset: -10 to +10.
    const valMin = evaluateRelativeRandomValue(50, -10, 10, {
        schemaMin: 0,
        schemaMax: 100,
        randomFactor: 0.0
    });
    assert.equal(valMin, 40);

    const valMax = evaluateRelativeRandomValue(50, -10, 10, {
        schemaMin: 0,
        schemaMax: 100,
        randomFactor: 1.0
    });
    assert.equal(valMax, 60);

    const valMid = evaluateRelativeRandomValue(50, -10, 10, {
        schemaMin: 0,
        schemaMax: 100,
        randomFactor: 0.5
    });
    assert.equal(valMid, 50);
});

test('relative percentage truncates/clamps to avoid overflow', () => {
    // Base = 95, schemaMax = 100. minPercent = 0%, maxPercent = +20% (offset up to +20 -> 115).
    const clamped = evaluateRelativeRandomValue(95, 0, 20, {
        schemaMin: 0,
        schemaMax: 100,
        randomFactor: 1.0
    });
    assert.equal(clamped, 100); // Clamped to schemaMax

    // Base = 5, schemaMin = 0. minPercent = -20%, maxPercent = 0% (offset -20 -> -15).
    const clampedBottom = evaluateRelativeRandomValue(5, -20, 0, {
        schemaMin: 0,
        schemaMax: 100,
        randomFactor: 0.0
    });
    assert.equal(clampedBottom, 0); // Clamped to schemaMin
});

test('relative percentage quantizes to step', () => {
    // Step = 1 (e.g. semitones)
    const stepped = evaluateRelativeRandomValue(0, -10, 10, {
        schemaMin: -24,
        schemaMax: 24,
        step: 1,
        randomFactor: 0.33
    });
    assert.equal(Number.isInteger(stepped), true);

    // Float step = 0.1
    const floatStepped = evaluateRelativeRandomValue(1.0, -10, 10, {
        schemaMin: 0,
        schemaMax: 2,
        step: 0.1,
        randomFactor: 0.55
    });
    const remainder = Math.abs((floatStepped * 10) - Math.round(floatStepped * 10));
    assert.equal(remainder < 0.0001, true);
});

test('applyRandomModulation updates owner node and restoreBaseValues resets it', () => {
    const ownerNode = {
        id: 10,
        properties: { cents: 12 },
        getFields: () => [
            { key: 'cents', label: 'Cents', type: 'slider', min: -100, max: 100, step: 1, default: 0 }
        ],
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        }
    };

    const dest: RandomDestination = {
        id: 'dst_cents',
        paramKey: 'cents',
        paramLabel: 'Cents',
        minPercent: -20,
        maxPercent: 20,
        baseValue: 12,
        enabled: true
    };

    const modifierNode = {
        id: 20,
        properties: {
            parentId: 10,
            refresh_mode: 'local',
            destinations: [dest]
        }
    };

    // Apply with randomFactor = 1.0 (span = 200, +20% = +40 cents -> 12 + 40 = 52)
    applyRandomModulation(modifierNode, ownerNode, {
        randomFactorGenerator: () => 1.0
    });

    assert.equal(ownerNode.properties.cents, 52);
    assert.equal(dest.currentValue, 52);

    // Now restore base values
    restoreBaseValues(modifierNode, ownerNode);
    assert.equal(ownerNode.properties.cents, 12);
});

test('applyRandomModulation handles array properties like arrangement sections', () => {
    const arrangementNode = {
        id: 30,
        properties: {
            section_probability: [1.0, 0.8]
        },
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        },
        getFields() {
            return [
                { key: 'section_probability', label: 'Probability', type: 'float', min: 0, max: 1, step: 0.05, default: 1.0 }
            ];
        }
    };

    const dest: RandomDestination = {
        id: 'dst_sec_prob',
        paramKey: 'section_probability',
        paramLabel: 'Probability',
        minPercent: -10,
        maxPercent: 10,
        baseValue: 1.0,
        enabled: true
    };

    const modifierNode = {
        id: 40,
        properties: {
            parentId: 30,
            refresh_mode: 'local',
            destinations: [dest]
        }
    };

    // Apply with randomFactor = 0.0 (lower bound: -10% of span 1.0 = -0.1)
    // For 1.0: 1.0 - 0.1 = 0.90
    // For 0.8: 0.8 - 0.1 = 0.70
    applyRandomModulation(modifierNode, arrangementNode, {
        randomFactorGenerator: () => 0.0
    });

    const result = arrangementNode.properties.section_probability;
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0], 0.9);
    assert.equal(result[1], 0.7);

    // Restore base values
    restoreBaseValues(modifierNode, arrangementNode);
    assert.deepEqual(arrangementNode.properties.section_probability, [1.0, 0.8]);
});

test('applyRandomModulation modifies specific sequence step parameters independently', () => {
    const sequenceNode = {
        id: 50,
        properties: {
            step_parameters: Array.from({ length: 16 }, () => ({
                probability: 100,
                velocity: 1.0,
                offset: 0.0,
                subdivisions: 1,
                subdivision_enabled: false
            }))
        },
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        },
        getFields() {
            return [
                { key: 'probability', label: 'Probability', type: 'int', min: 0, max: 100, step: 1, default: 100 },
                { key: 'velocity', label: 'Velocity', type: 'float', min: 0, max: 1, step: 0.01, default: 1.0 },
                { key: 'offset', label: 'Offset', type: 'float', min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
                { key: 'subdivisions', label: 'Subdivisions', type: 'int', min: 1, max: 16, step: 1, default: 1 }
            ];
        }
    };

    // Map Step 3 (index 2) velocity with -20%..+20%
    // Map Step 7 (index 6) probability with -30%..-10%
    const dest1: RandomDestination = {
        id: 'dst_step_2_vel',
        paramKey: 'step_parameters.2.velocity',
        paramLabel: 'Step 3 Velocity',
        minPercent: -20,
        maxPercent: 20,
        baseValue: 1.0,
        enabled: true
    };

    const dest2: RandomDestination = {
        id: 'dst_step_6_prob',
        paramKey: 'step_parameters.6.probability',
        paramLabel: 'Step 7 Probability',
        minPercent: -30,
        maxPercent: -10,
        baseValue: 100,
        enabled: true
    };

    const modifierNode = {
        id: 60,
        properties: {
            parentId: 50,
            refresh_mode: 'local',
            destinations: [dest1, dest2]
        }
    };

    // Apply with randomFactor = 0.0:
    // dest1 (velocity, span = 1.0, -20% of 1.0 = -0.2 -> 1.0 - 0.2 = 0.8)
    // dest2 (probability, span = 100, -30% of 100 = -30 -> 100 - 30 = 70)
    applyRandomModulation(modifierNode, sequenceNode, {
        randomFactorGenerator: () => 0.0
    });

    // Verify Step 3 velocity was modulated to 0.8
    assert.equal(sequenceNode.properties.step_parameters[2].velocity, 0.8);
    // Verify Step 1 & Step 2 velocities were UNTOUCHED (still 1.0)
    assert.equal(sequenceNode.properties.step_parameters[0].velocity, 1.0);
    assert.equal(sequenceNode.properties.step_parameters[1].velocity, 1.0);

    // Verify Step 7 probability was modulated to 70
    assert.equal(sequenceNode.properties.step_parameters[6].probability, 70);
    // Verify Step 6 & Step 8 probabilities were UNTOUCHED (still 100)
    assert.equal(sequenceNode.properties.step_parameters[5].probability, 100);
    assert.equal(sequenceNode.properties.step_parameters[7].probability, 100);

    // Restore base values
    restoreBaseValues(modifierNode, sequenceNode);
    assert.equal(sequenceNode.properties.step_parameters[2].velocity, 1.0);
    assert.equal(sequenceNode.properties.step_parameters[6].probability, 100);
});

test('isFieldMappableToRandom only allows numeric fields and step parameters', () => {
    const mockNode = {
        getFields() {
            return [
                { key: 'node_name', label: 'Name', type: 'string' },
                { key: 'probability', label: 'Probability', type: 'int', min: 0, max: 100 },
                { key: 'offset', label: 'Offset', type: 'float', min: -0.5, max: 0.5 },
                { key: 'play_mode', label: 'Play Mode', type: 'select' },
                { key: 'seed_mode', label: 'Seed Mode', type: 'select' },
                { key: 'fade_ms', label: 'Fade', type: 'float', min: 0, max: 5 },
                { key: 'gain_db', label: 'Gain', type: 'db', min: -36, max: 12 }
            ];
        }
    };

    assert.equal(isFieldMappableToRandom(mockNode, 'probability'), true);
    assert.equal(isFieldMappableToRandom(mockNode, 'offset'), true);
    assert.equal(isFieldMappableToRandom(mockNode, 'fade_ms'), true);
    assert.equal(isFieldMappableToRandom(mockNode, 'gain_db'), true);

    // Non-numeric fields must return false
    assert.equal(isFieldMappableToRandom(mockNode, 'node_name'), false);
    assert.equal(isFieldMappableToRandom(mockNode, 'play_mode'), false);
    assert.equal(isFieldMappableToRandom(mockNode, 'seed_mode'), false);

    // Sequence step parameters
    assert.equal(isFieldMappableToRandom(mockNode, 'step_parameters.0.probability'), true);
    assert.equal(isFieldMappableToRandom(mockNode, 'step_parameters.5.velocity'), true);
    assert.equal(isFieldMappableToRandom(mockNode, 'step_parameters.15.offset'), true);
    assert.equal(isFieldMappableToRandom(mockNode, 'step_parameters.2.unknown_key'), false);
});

test('getRangeColor returns magnitude-based colors', () => {
    // Subtle (<=15%): Emerald
    assert.equal(getRangeColor(-10, 10).border, '#10b981');
    assert.equal(getRangeColor(-15, 15).border, '#10b981');

    // Moderate (<=35%): Cyan
    assert.equal(getRangeColor(-20, 20).border, '#0284c7');
    assert.equal(getRangeColor(-35, 35).border, '#0284c7');

    // Active (<=60%): Amber
    assert.equal(getRangeColor(-45, 45).border, '#f59e0b');
    assert.equal(getRangeColor(-60, 60).border, '#f59e0b');

    // Heavy (>60%): Magenta
    assert.equal(getRangeColor(-75, 75).border, '#ec4899');
    assert.equal(getRangeColor(-100, 100).border, '#ec4899');
});


