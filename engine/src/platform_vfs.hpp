#pragma once

#include "../third_party/miniaudio.h"
#include <cstring>
#include <new>

#if defined(_WIN32)
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
#else
  #include <fcntl.h>
  #include <sys/stat.h>
  #include <unistd.h>
#endif

namespace sin_dsp {

/*
 * Cross-platform read-only VFS for miniaudio.
 *
 * On Windows, files are explicitly opened with
 *   FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
 * so active disk-streaming multitrack sessions NEVER block GAIA or external tools
 * from renaming, moving, or deleting files (eliminating WinError 32 file-lock bugs).
 */
struct ShareSafeVfs {
    ma_vfs_callbacks cb;

    static ma_result on_open(ma_vfs* /*pVFS*/, const char* pFilePath, ma_uint32 /*openMode*/, ma_vfs_file* pFile) {
        if (!pFilePath || !pFile) return MA_INVALID_ARGS;
        *pFile = nullptr;
#if defined(_WIN32)
        int wlen = MultiByteToWideChar(CP_UTF8, 0, pFilePath, -1, nullptr, 0);
        if (wlen <= 0) return MA_INVALID_ARGS;
        wchar_t stack_buf[512];
        wchar_t* wpath = stack_buf;
        wchar_t* heap_buf = nullptr;
        if (wlen > 512) {
            heap_buf = new (std::nothrow) wchar_t[static_cast<size_t>(wlen)];
            if (!heap_buf) return MA_OUT_OF_MEMORY;
            wpath = heap_buf;
        }
        MultiByteToWideChar(CP_UTF8, 0, pFilePath, -1, wpath, wlen);
        HANDLE h = CreateFileW(
            wpath,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
            nullptr
        );
        delete[] heap_buf;
        if (h == INVALID_HANDLE_VALUE) {
            return MA_DOES_NOT_EXIST;
        }
        *pFile = static_cast<ma_vfs_file>(h);
        return MA_SUCCESS;
#else
        int fd = ::open(pFilePath, O_RDONLY);
        if (fd < 0) return MA_DOES_NOT_EXIST;
        *pFile = reinterpret_cast<ma_vfs_file>(static_cast<intptr_t>(fd + 1));
        return MA_SUCCESS;
#endif
    }

    static ma_result on_open_w(ma_vfs* /*pVFS*/, const wchar_t* pFilePath, ma_uint32 /*openMode*/, ma_vfs_file* pFile) {
        if (!pFilePath || !pFile) return MA_INVALID_ARGS;
        *pFile = nullptr;
#if defined(_WIN32)
        HANDLE h = CreateFileW(
            pFilePath,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
            nullptr
        );
        if (h == INVALID_HANDLE_VALUE) return MA_DOES_NOT_EXIST;
        *pFile = static_cast<ma_vfs_file>(h);
        return MA_SUCCESS;
#else
        (void)pFilePath;
        return MA_NOT_IMPLEMENTED;
#endif
    }

    static ma_result on_close(ma_vfs* /*pVFS*/, ma_vfs_file file) {
        if (!file) return MA_SUCCESS;
#if defined(_WIN32)
        CloseHandle(static_cast<HANDLE>(file));
#else
        int fd = static_cast<int>(reinterpret_cast<intptr_t>(file) - 1);
        if (fd >= 0) ::close(fd);
#endif
        return MA_SUCCESS;
    }

    static ma_result on_read(ma_vfs* /*pVFS*/, ma_vfs_file file, void* pDst, size_t sizeInBytes, size_t* pBytesRead) {
        if (pBytesRead) *pBytesRead = 0;
        if (!file || !pDst) return MA_INVALID_ARGS;
#if defined(_WIN32)
        size_t total_read = 0;
        uint8_t* dst = static_cast<uint8_t*>(pDst);
        while (total_read < sizeInBytes) {
            DWORD chunk = static_cast<DWORD>((sizeInBytes - total_read) > 0x40000000u ? 0x40000000u : (sizeInBytes - total_read));
            DWORD got = 0;
            if (!ReadFile(static_cast<HANDLE>(file), dst + total_read, chunk, &got, nullptr)) {
                if (pBytesRead) *pBytesRead = total_read;
                return total_read > 0 ? MA_SUCCESS : MA_IO_ERROR;
            }
            total_read += got;
            if (got == 0) break;
        }
        if (pBytesRead) *pBytesRead = total_read;
        return total_read == 0 && sizeInBytes > 0 ? MA_AT_END : MA_SUCCESS;
#else
        int fd = static_cast<int>(reinterpret_cast<intptr_t>(file) - 1);
        ssize_t got = ::read(fd, pDst, sizeInBytes);
        if (got < 0) return MA_IO_ERROR;
        if (pBytesRead) *pBytesRead = static_cast<size_t>(got);
        return got == 0 && sizeInBytes > 0 ? MA_AT_END : MA_SUCCESS;
#endif
    }

    static ma_result on_write(ma_vfs* /*pVFS*/, ma_vfs_file /*file*/, const void* /*pSrc*/, size_t /*sizeInBytes*/, size_t* pBytesWritten) {
        if (pBytesWritten) *pBytesWritten = 0;
        return MA_ACCESS_DENIED; /* Strictly read-only! */
    }

    static ma_result on_seek(ma_vfs* /*pVFS*/, ma_vfs_file file, ma_int64 offset, ma_seek_origin origin) {
        if (!file) return MA_INVALID_ARGS;
#if defined(_WIN32)
        DWORD method = FILE_BEGIN;
        if (origin == ma_seek_origin_current) method = FILE_CURRENT;
        else if (origin == ma_seek_origin_end) method = FILE_END;
        LARGE_INTEGER li;
        li.QuadPart = offset;
        if (!SetFilePointerEx(static_cast<HANDLE>(file), li, nullptr, method)) {
            return MA_IO_ERROR;
        }
        return MA_SUCCESS;
#else
        int fd = static_cast<int>(reinterpret_cast<intptr_t>(file) - 1);
        int whence = SEEK_SET;
        if (origin == ma_seek_origin_current) whence = SEEK_CUR;
        else if (origin == ma_seek_origin_end) whence = SEEK_END;
        if (::lseek(fd, static_cast<off_t>(offset), whence) < 0) return MA_IO_ERROR;
        return MA_SUCCESS;
#endif
    }

    static ma_result on_tell(ma_vfs* /*pVFS*/, ma_vfs_file file, ma_int64* pCursor) {
        if (!file || !pCursor) return MA_INVALID_ARGS;
#if defined(_WIN32)
        LARGE_INTEGER zero;
        zero.QuadPart = 0;
        LARGE_INTEGER pos;
        if (!SetFilePointerEx(static_cast<HANDLE>(file), zero, &pos, FILE_CURRENT)) {
            return MA_IO_ERROR;
        }
        *pCursor = static_cast<ma_int64>(pos.QuadPart);
        return MA_SUCCESS;
#else
        int fd = static_cast<int>(reinterpret_cast<intptr_t>(file) - 1);
        off_t pos = ::lseek(fd, 0, SEEK_CUR);
        if (pos < 0) return MA_IO_ERROR;
        *pCursor = static_cast<ma_int64>(pos);
        return MA_SUCCESS;
#endif
    }

    static ma_result on_info(ma_vfs* /*pVFS*/, ma_vfs_file file, ma_file_info* pInfo) {
        if (!file || !pInfo) return MA_INVALID_ARGS;
        std::memset(pInfo, 0, sizeof(*pInfo));
#if defined(_WIN32)
        LARGE_INTEGER sz;
        if (!GetFileSizeEx(static_cast<HANDLE>(file), &sz)) return MA_IO_ERROR;
        pInfo->sizeInBytes = static_cast<ma_uint64>(sz.QuadPart);
        return MA_SUCCESS;
#else
        int fd = static_cast<int>(reinterpret_cast<intptr_t>(file) - 1);
        struct stat st{};
        if (::fstat(fd, &st) != 0) return MA_IO_ERROR;
        pInfo->sizeInBytes = static_cast<ma_uint64>(st.st_size);
        return MA_SUCCESS;
#endif
    }

    ShareSafeVfs() {
        cb.onOpen  = on_open;
        cb.onOpenW = on_open_w;
        cb.onClose = on_close;
        cb.onRead  = on_read;
        cb.onWrite = on_write;
        cb.onSeek  = on_seek;
        cb.onTell  = on_tell;
        cb.onInfo  = on_info;
    }

    ma_vfs* handle() { return reinterpret_cast<ma_vfs*>(&cb); }
};

} // namespace sin_dsp
