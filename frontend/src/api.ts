export interface LibraryFile {
    id?: number;
    absolute_path: string;
    name: string;
    type?: string;
    key?: string;
    bpm?: number;
    tags?: any[];
}

let cachedLibrary: LibraryFile[] | null = null;

export async function fetchLibrary(): Promise<LibraryFile[]> {
    if (cachedLibrary !== null) {
        return cachedLibrary;
    }

    try {
        const response = await fetch('/api/library');
        if (!response.ok) {
            throw new Error(`Failed to fetch library: ${response.statusText}`);
        }
        
        const data = await response.json();
        cachedLibrary = data.files || [];
        return cachedLibrary as LibraryFile[];
    } catch (err) {
        console.error("Error fetching library:", err);
        return [];
    }
}
