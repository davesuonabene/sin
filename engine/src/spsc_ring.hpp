#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace sin_dsp {

/*
 * Lock-free Single-Producer Single-Consumer ring buffer with power-of-two capacity.
 * Zero heap allocations after construction; strictly acquire/release memory ordering.
 */
template <typename T, size_t CapacityPow2>
class SpscRing {
    static_assert((CapacityPow2 & (CapacityPow2 - 1)) == 0 && CapacityPow2 >= 2,
                  "CapacityPow2 must be a power of 2 >= 2");

public:
    bool push(const T& item) noexcept {
        const size_t w = write_idx_.load(std::memory_order_relaxed);
        const size_t next_w = (w + 1) & kMask;
        if (next_w == read_idx_.load(std::memory_order_acquire)) {
            return false; // full
        }
        buf_[w] = item;
        write_idx_.store(next_w, std::memory_order_release);
        return true;
    }

    bool pop(T& out) noexcept {
        const size_t r = read_idx_.load(std::memory_order_relaxed);
        if (r == write_idx_.load(std::memory_order_acquire)) {
            return false; // empty
        }
        out = buf_[r];
        read_idx_.store((r + 1) & kMask, std::memory_order_release);
        return true;
    }

    void clear() noexcept {
        read_idx_.store(write_idx_.load(std::memory_order_acquire), std::memory_order_release);
    }

    size_t available_read() const noexcept {
        const size_t w = write_idx_.load(std::memory_order_acquire);
        const size_t r = read_idx_.load(std::memory_order_relaxed);
        return (w - r) & kMask;
    }

private:
    static constexpr size_t kMask = CapacityPow2 - 1;
    alignas(64) std::atomic<size_t> write_idx_{0};
    alignas(64) std::atomic<size_t> read_idx_{0};
    std::array<T, CapacityPow2> buf_{};
};

} // namespace sin_dsp
