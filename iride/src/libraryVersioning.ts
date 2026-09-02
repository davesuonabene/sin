/**
 * Keep SIN's read-only library view in step with GAIA's versioning rule.
 * A final dotted filename segment is a revision only when a sibling with the
 * same base name and extension exists. For example, `loop.wav`,
 * `loop.2.wav`, and `loop.3.wav` are one logical asset.
 */
export type FileVersionInfo = {
    baseName: string;
    label: string | null;
    filename: string;
    key: string;
};

export type FileVersion<T> = {
    id: string;
    label: string;
    record: T;
};

export type GroupedFileVersion<T> = {
    record: T;
    fileVersionGroup?: string;
    fileVersionDisplayName?: string;
    fileVersions?: FileVersion<T>[];
};

export type GroupFileVersionsOptions<T> = {
    pathFor: (record: T) => string;
    idFor: (record: T) => string | number | null | undefined;
    scope: string;
    selections?: ReadonlyMap<string, string>;
};

export function fileVersionInfo(path: string): FileVersionInfo | null {
    const normalizedPath = String(path || '').replace(/\\/g, '/');
    const slashIndex = normalizedPath.lastIndexOf('/');
    const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : '';
    const filename = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
    const extensionIndex = filename.lastIndexOf('.');
    if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return null;

    const extension = filename.slice(extensionIndex);
    const stem = filename.slice(0, extensionIndex);
    const revisionIndex = stem.lastIndexOf('.');
    const baseName = revisionIndex > 0 ? stem.slice(0, revisionIndex) : stem;
    const label = revisionIndex > 0 ? stem.slice(revisionIndex + 1) : null;
    if (!baseName) return null;

    return {
        baseName,
        label,
        filename,
        key: JSON.stringify([
            directory.toLocaleLowerCase(),
            baseName.toLocaleLowerCase(),
            extension.toLocaleLowerCase(),
        ]),
    };
}

export function compareFileVersionLabels(left: string | null, right: string | null): number {
    if (left === null) return right === null ? 0 : -1;
    if (right === null) return 1;
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        const leftValue = left.replace(/^0+(?=\d)/, '');
        const rightValue = right.replace(/^0+(?=\d)/, '');
        if (leftValue.length !== rightValue.length) return leftValue.length - rightValue.length;
        const numericOrder = leftValue.localeCompare(rightValue);
        if (numericOrder) return numericOrder;
    }
    return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

export function fileVersionLabel(label: string | null): string {
    return label === null ? 'Original' : `.${label}`;
}

/**
 * Collapse physical files into one display record per logical asset. The
 * selected revision is only a view preference: callers still receive the
 * actual GAIA record and do not alter library state.
 */
export function groupFileVersions<T>(
    records: T[],
    { pathFor, idFor, scope, selections }: GroupFileVersionsOptions<T>,
): GroupedFileVersion<T>[] {
    const candidates = records.map((record, index) => ({
        record,
        index,
        id: String(idFor(record) ?? pathFor(record)),
        info: fileVersionInfo(pathFor(record)),
    }));
    const candidatesByKey = new Map<string, typeof candidates>();
    candidates.forEach(candidate => {
        if (!candidate.info) return;
        const group = candidatesByKey.get(candidate.info.key) || [];
        group.push(candidate);
        candidatesByKey.set(candidate.info.key, group);
    });

    const groups = new Map<string, {
        firstIndex: number;
        key: string;
        displayName: string;
        versions: typeof candidates;
    }>();
    candidatesByKey.forEach((members, key) => {
        if (members.length < 2 || !members.some(member => member.info?.label !== null)) return;
        const versions = [...members].sort((left, right) => (
            compareFileVersionLabels(left.info!.label, right.info!.label)
            || left.info!.filename.localeCompare(right.info!.filename, undefined, { sensitivity: 'base' })
        ));
        groups.set(key, {
            firstIndex: Math.min(...members.map(member => member.index)),
            key: `${scope}:${key}`,
            displayName: members[0].info!.baseName,
            versions,
        });
    });

    return candidates.flatMap(candidate => {
        const group = candidate.info ? groups.get(candidate.info.key) : null;
        if (!group) return [{ record: candidate.record }];
        if (candidate.index !== group.firstIndex) return [];

        const selectedId = selections?.get(group.key);
        const selected = group.versions.find(version => version.id === selectedId)
            || group.versions[group.versions.length - 1];
        return [{
            record: selected.record,
            fileVersionGroup: group.key,
            fileVersionDisplayName: group.displayName,
            fileVersions: group.versions.map(version => ({
                id: version.id,
                label: fileVersionLabel(version.info!.label),
                record: version.record,
            })),
        }];
    });
}
