let cachedLibrary: string[] | null = null;

export async function fetchLibrary(): Promise<string[]> {
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
        return cachedLibrary as string[];
    } catch (err) {
        console.error("Error fetching library:", err);
        return [];
    }
}
