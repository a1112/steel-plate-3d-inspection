#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>

namespace steel_capture {

struct OwnedWorkerStats {
  std::size_t capacity = 0;
  std::size_t owned = 0;
  std::size_t running = 0;
  std::size_t completed_not_joined = 0;
  std::size_t sdk_running = 0;
  std::uint64_t adopted = 0;
  std::uint64_t reaped = 0;
};

// Owns thread handles that outlive a bounded caller wait. No worker is ever
// detached: completed workers are joined by reap_completed(), while shutdown
// can wait_until() a fixed deadline before deciding that process-level exit is
// the only safe option.
class OwnedWorkerRegistry {
 public:
  static constexpr std::size_t kCapacity = 64;

  OwnedWorkerRegistry() = default;

  ~OwnedWorkerRegistry() {
    join_all();
  }

  bool adopt(std::thread& worker,
             std::shared_ptr<std::atomic_bool> done,
             bool sdk_worker) noexcept {
    if (!worker.joinable() || !done) {
      return false;
    }
    reap_completed();
    std::lock_guard<std::mutex> lock(mutex_);
    for (Entry& entry : entries_) {
      if (!entry.worker.joinable()) {
        entry.worker = std::move(worker);
        entry.done = std::move(done);
        entry.sdk_worker = sdk_worker;
        ++adopted_;
        return true;
      }
    }
    return false;
  }

  std::size_t reap_completed() noexcept {
    std::size_t joined = 0;
    for (;;) {
      std::thread completed;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        for (Entry& entry : entries_) {
          if (entry.worker.joinable() && entry.done &&
              entry.done->load(std::memory_order_acquire)) {
            completed = std::move(entry.worker);
            entry.done.reset();
            entry.sdk_worker = false;
            break;
          }
        }
      }
      if (!completed.joinable()) {
        break;
      }
      completed.join();
      ++joined;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        ++reaped_;
      }
    }
    return joined;
  }

  bool wait_until(std::chrono::steady_clock::time_point deadline) noexcept {
    for (;;) {
      reap_completed();
      if (empty()) {
        return true;
      }
      if (std::chrono::steady_clock::now() >= deadline) {
        return false;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }

  OwnedWorkerStats stats() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    OwnedWorkerStats result;
    result.capacity = entries_.size();
    result.adopted = adopted_;
    result.reaped = reaped_;
    for (const Entry& entry : entries_) {
      if (!entry.worker.joinable()) {
        continue;
      }
      ++result.owned;
      const bool done = entry.done && entry.done->load(std::memory_order_acquire);
      if (done) {
        ++result.completed_not_joined;
      } else {
        ++result.running;
        if (entry.sdk_worker) {
          ++result.sdk_running;
        }
      }
    }
    return result;
  }

  bool empty() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const Entry& entry : entries_) {
      if (entry.worker.joinable()) {
        return false;
      }
    }
    return true;
  }

  OwnedWorkerRegistry(const OwnedWorkerRegistry&) = delete;
  OwnedWorkerRegistry& operator=(const OwnedWorkerRegistry&) = delete;

 private:
  struct Entry {
    std::thread worker;
    std::shared_ptr<std::atomic_bool> done;
    bool sdk_worker = false;
  };

  void join_all() noexcept {
    for (;;) {
      std::thread worker;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        for (Entry& entry : entries_) {
          if (entry.worker.joinable()) {
            worker = std::move(entry.worker);
            entry.done.reset();
            entry.sdk_worker = false;
            break;
          }
        }
      }
      if (!worker.joinable()) {
        return;
      }
      worker.join();
      {
        std::lock_guard<std::mutex> lock(mutex_);
        ++reaped_;
      }
    }
  }

  mutable std::mutex mutex_;
  std::array<Entry, kCapacity> entries_{};
  std::uint64_t adopted_ = 0;
  std::uint64_t reaped_ = 0;
};

}  // namespace steel_capture
