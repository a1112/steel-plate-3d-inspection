#pragma once

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>
#include <utility>
#include <vector>

namespace steel_capture {

enum class StorageSubmitStatus {
  Accepted,
  TimedOut,
  Stopped,
  TooLarge,
  InvalidTask,
};

struct StorageSubmitResult {
  StorageSubmitStatus status = StorageSubmitStatus::InvalidTask;
  std::future<int> future;

  bool accepted() const noexcept {
    return status == StorageSubmitStatus::Accepted && future.valid();
  }
};

struct StorageQueueStats {
  std::size_t worker_count = 0;
  std::size_t capacity_items = 0;
  std::size_t capacity_bytes = 0;
  std::size_t pending_items = 0;
  std::size_t pending_bytes = 0;
  std::size_t queued = 0;
  std::size_t queued_bytes = 0;
  std::size_t active = 0;
  std::size_t active_bytes = 0;
  std::size_t high_water_items = 0;
  std::size_t high_water_bytes = 0;
  std::uint64_t completed = 0;
  std::uint64_t failed = 0;
  std::uint64_t rejected = 0;
  bool accepting = false;
};

class StorageThreadPool {
 public:
  static constexpr std::size_t kDefaultMaxPendingItems = 24;
  static constexpr std::size_t kDefaultMaxPendingBytes = 512ULL * 1024ULL * 1024ULL;

  explicit StorageThreadPool(
      std::size_t thread_count = 0,
      std::size_t max_pending_items = kDefaultMaxPendingItems,
      std::size_t max_pending_bytes = kDefaultMaxPendingBytes)
      : max_pending_items_(std::max<std::size_t>(1, max_pending_items)),
        max_pending_bytes_(std::max<std::size_t>(1, max_pending_bytes)) {
    if (thread_count == 0) {
      const unsigned int hardware = std::thread::hardware_concurrency();
      thread_count = std::max<std::size_t>(
          2, std::min<std::size_t>(8, hardware == 0 ? 4 : hardware / 2));
    }
    workers_.reserve(thread_count);
    try {
      for (std::size_t index = 0; index < thread_count; ++index) {
        workers_.emplace_back([this]() { worker_loop(); });
      }
    } catch (...) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        accepting_ = false;
        stopping_ = true;
      }
      work_cv_.notify_all();
      for (auto& worker : workers_) {
        if (worker.joinable()) {
          worker.join();
        }
      }
      throw;
    }
  }

  ~StorageThreadPool() {
    stop_accepting();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    work_cv_.notify_all();
    for (auto& worker : workers_) {
      if (worker.joinable()) {
        worker.join();
      }
    }
  }

  StorageSubmitResult submit(
      std::function<int()> task,
      std::size_t pending_bytes = 0,
      std::chrono::milliseconds timeout = std::chrono::milliseconds(2000)) {
    if (!task) {
      std::lock_guard<std::mutex> lock(mutex_);
      ++rejected_;
      return {StorageSubmitStatus::InvalidTask, {}};
    }

    auto promise = std::make_shared<std::promise<int>>();
    auto future = promise->get_future();
    std::unique_lock<std::mutex> lock(mutex_);
    if (!accepting_) {
      ++rejected_;
      return {StorageSubmitStatus::Stopped, {}};
    }
    if (pending_bytes > max_pending_bytes_) {
      ++rejected_;
      return {StorageSubmitStatus::TooLarge, {}};
    }

    const auto has_capacity = [&]() {
      return !accepting_ ||
             (pending_items_ < max_pending_items_ &&
              pending_bytes_ <= max_pending_bytes_ - pending_bytes);
    };
    if (!has_capacity()) {
      if (timeout <= std::chrono::milliseconds::zero() ||
          !space_cv_.wait_for(lock, timeout, has_capacity)) {
        ++rejected_;
        return {StorageSubmitStatus::TimedOut, {}};
      }
    }
    if (!accepting_) {
      ++rejected_;
      return {StorageSubmitStatus::Stopped, {}};
    }

    tasks_.push(Task{std::move(task), promise, pending_bytes});
    ++pending_items_;
    pending_bytes_ += pending_bytes;
    high_water_items_ = std::max(high_water_items_, pending_items_);
    high_water_bytes_ = std::max(high_water_bytes_, pending_bytes_);
    lock.unlock();
    work_cv_.notify_one();
    return {StorageSubmitStatus::Accepted, std::move(future)};
  }

  void stop_accepting() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      accepting_ = false;
    }
    space_cv_.notify_all();
  }

  bool drain_for(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex_);
    return drained_cv_.wait_for(lock, timeout, [&]() { return pending_items_ == 0; });
  }

  bool drain_until(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock<std::mutex> lock(mutex_);
    return drained_cv_.wait_until(lock, deadline, [&]() { return pending_items_ == 0; });
  }

  StorageQueueStats stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    StorageQueueStats result;
    result.worker_count = workers_.size();
    result.capacity_items = max_pending_items_;
    result.capacity_bytes = max_pending_bytes_;
    result.pending_items = pending_items_;
    result.pending_bytes = pending_bytes_;
    result.queued = tasks_.size();
    result.queued_bytes = pending_bytes_ - active_bytes_;
    result.active = active_tasks_;
    result.active_bytes = active_bytes_;
    result.high_water_items = high_water_items_;
    result.high_water_bytes = high_water_bytes_;
    result.completed = completed_;
    result.failed = failed_;
    result.rejected = rejected_;
    result.accepting = accepting_;
    return result;
  }

  StorageThreadPool(const StorageThreadPool&) = delete;
  StorageThreadPool& operator=(const StorageThreadPool&) = delete;

 private:
  struct Task {
    std::function<int()> run;
    std::shared_ptr<std::promise<int>> promise;
    std::size_t pending_bytes = 0;
  };

  void worker_loop() {
    for (;;) {
      Task task;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        work_cv_.wait(lock, [&]() { return stopping_ || !tasks_.empty(); });
        if (stopping_ && tasks_.empty()) {
          return;
        }
        task = std::move(tasks_.front());
        tasks_.pop();
        ++active_tasks_;
        active_bytes_ += task.pending_bytes;
      }

      int result = 0;
      std::exception_ptr error;
      try {
        result = task.run();
      } catch (...) {
        error = std::current_exception();
      }

      {
        std::lock_guard<std::mutex> lock(mutex_);
        --active_tasks_;
        active_bytes_ -= task.pending_bytes;
        --pending_items_;
        pending_bytes_ -= task.pending_bytes;
        if (error || result != 0) {
          ++failed_;
        } else {
          ++completed_;
        }
        if (error) {
          task.promise->set_exception(error);
        } else {
          task.promise->set_value(result);
        }
      }
      space_cv_.notify_all();
      drained_cv_.notify_all();
    }
  }

  const std::size_t max_pending_items_;
  const std::size_t max_pending_bytes_;
  mutable std::mutex mutex_;
  std::condition_variable work_cv_;
  std::condition_variable space_cv_;
  std::condition_variable drained_cv_;
  std::queue<Task> tasks_;
  std::vector<std::thread> workers_;
  std::size_t pending_items_ = 0;
  std::size_t pending_bytes_ = 0;
  std::size_t active_tasks_ = 0;
  std::size_t active_bytes_ = 0;
  std::size_t high_water_items_ = 0;
  std::size_t high_water_bytes_ = 0;
  std::uint64_t completed_ = 0;
  std::uint64_t failed_ = 0;
  std::uint64_t rejected_ = 0;
  bool accepting_ = true;
  bool stopping_ = false;
};

}  // namespace steel_capture
