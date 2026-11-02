export interface ProgressiveStreamOptions {
    response: Response;
    signal: AbortSignal;
    isSessionCurrent: () => boolean;
    decodeWav: (rawBuffer: ArrayBuffer) => Promise<AudioBuffer | null>;
    decodeBase64Wav: (base64: string) => Promise<AudioBuffer | null>;
    onBarChunk: (chunkData: any, audioBuffer: AudioBuffer) => Promise<void>;
}

const textDecoder = new TextDecoder();

export async function readProgressivePreviewStream(options: ProgressiveStreamOptions): Promise<any> {
    const { response, signal, isSessionCurrent, decodeWav, decodeBase64Wav, onBarChunk } = options;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('ReadableStream not supported.');

    let finalData: any = null;
    const isBinary = response.headers.get('content-type')?.includes('octet-stream');

    if (isBinary) {
        let buffer = new Uint8Array(65536);
        let readOffset = 0;
        let writeOffset = 0;

        const appendBytes = (incoming: Uint8Array) => {
            const unread = writeOffset - readOffset;
            if (writeOffset + incoming.length > buffer.length) {
                if (unread + incoming.length <= buffer.length) {
                    buffer.copyWithin(0, readOffset, writeOffset);
                    readOffset = 0;
                    writeOffset = unread;
                } else {
                    const nextCap = Math.max(buffer.length * 2, unread + incoming.length + 16384);
                    const nextBuf = new Uint8Array(nextCap);
                    nextBuf.set(buffer.subarray(readOffset, writeOffset), 0);
                    buffer = nextBuf;
                    readOffset = 0;
                    writeOffset = unread;
                }
            }
            buffer.set(incoming, writeOffset);
            writeOffset += incoming.length;
        };

        while (true) {
            if (!isSessionCurrent() || signal.aborted) {
                reader.cancel();
                break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
                appendBytes(value);
            }

            while (writeOffset - readOffset >= 12) {
                if (
                    buffer[readOffset] !== 0x53 ||
                    buffer[readOffset + 1] !== 0x49 ||
                    buffer[readOffset + 2] !== 0x4E ||
                    buffer[readOffset + 3] !== 0x42
                ) {
                    let syncIdx = -1;
                    for (let i = readOffset + 1; i < writeOffset - 3; i++) {
                        if (buffer[i] === 0x53 && buffer[i + 1] === 0x49 && buffer[i + 2] === 0x4E && buffer[i + 3] === 0x42) {
                            syncIdx = i;
                            break;
                        }
                    }
                    if (syncIdx > 0) {
                        readOffset = syncIdx;
                    } else {
                        readOffset = Math.max(readOffset, writeOffset - 3);
                        break;
                    }
                }

                const unread = writeOffset - readOffset;
                if (unread < 12) break;
                const view = new DataView(buffer.buffer, buffer.byteOffset + readOffset, unread);
                const metaLen = view.getUint32(4, false);
                const audioLen = view.getUint32(8, false);
                const frameLen = 12 + metaLen + audioLen;
                if (unread < frameLen) break;

                const metaBytes = buffer.subarray(readOffset + 12, readOffset + 12 + metaLen);
                const audioBytes = buffer.subarray(readOffset + 12 + metaLen, readOffset + frameLen);
                readOffset += frameLen;

                let chunkData: any;
                try {
                    chunkData = JSON.parse(textDecoder.decode(metaBytes));
                } catch (e) {
                    console.error('[BinaryStream] JSON parse error:', e);
                    continue;
                }

                if (!isSessionCurrent()) break;

                const cType = chunkData.chunk_type || chunkData.type;
                if (cType === 'bar' || cType === 'bar_chunk') {
                    if (audioBytes.length > 0) {
                        const rawWavBuffer = audioBytes.buffer.slice(
                            audioBytes.byteOffset,
                            audioBytes.byteOffset + audioBytes.byteLength
                        );
                        const audioBuf = await decodeWav(rawWavBuffer);
                        if (audioBuf && isSessionCurrent()) {
                            await onBarChunk(chunkData, audioBuf);
                        }
                    }
                } else if (cType === 'complete') {
                    finalData = chunkData;
                } else if (cType === 'error') {
                    throw new Error(chunkData.error || 'Server streaming error');
                }
            }
        }
    } else {
        const streamDecoder = new TextDecoder();
        let streamBuffer = '';
        while (true) {
            if (!isSessionCurrent() || signal.aborted) {
                reader.cancel();
                break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            streamBuffer += streamDecoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                if (!isSessionCurrent()) break;
                let chunkData: any;
                try {
                    chunkData = JSON.parse(line);
                } catch {
                    continue;
                }

                const cType = chunkData.chunk_type || chunkData.type;
                if (cType === 'bar' || cType === 'bar_chunk') {
                    const audioBuf = await decodeBase64Wav(chunkData.audio_base64);
                    if (audioBuf && isSessionCurrent()) {
                        await onBarChunk(chunkData, audioBuf);
                    }
                } else if (cType === 'complete') {
                    finalData = chunkData;
                } else if (cType === 'error') {
                    throw new Error(chunkData.error || 'Server streaming error');
                }
            }
        }
    }

    return finalData;
}

