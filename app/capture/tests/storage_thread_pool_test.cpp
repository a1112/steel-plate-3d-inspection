#include "storage_thread_pool.h"

#include <chrono>
#include <exception>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;
using steel_capture::StorageSubmitStatus;
using steel_capture::StorageThreadPool;

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

template <typename Predicate>
void wait_until(Predicate predicate, const std::string& message) {
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (!predicate()) {
    if (std::chrono::steady_clock::now() >= deadline) {
      throw std::runtime_error(message);
    }
    std::this_thread::sleep_for(2ms);
  }
}

void bounded_queue_applies_item_and_byte_backpressure() {
  StorageThreadPool pool(1, 2, 10);
  std::promise<void> release_first;
  std::shared_future<void> first_gate = release_first.get_future().share();

  auto first = pool.submit([first_gate]() {
    first_gate.wait();
    return 0;
  }, 6, 0ms);
  require(first.accepted(), "first task should be accepted");
  wait_until([&]() { return pool.stats().active == 1; }, "first task did not become active");

  auto second = pool.submit([]() { return 0; }, 4, 0ms);
  require(second.accepted(), "second task should consume the remaining capacity");
  auto rejected = pool.submit([]() { return 0; }, 1, 20ms);
  require(rejected.status == StorageSubmitStatus::TimedOut,
          "third task should time out while both item and byte capacity are full");

  const auto saturated = pool.stats();
  require(saturated.pending_items == 2, "pending item count should include queued and active tasks");
  require(saturated.pending_bytes == 10, "pending bytes should include queued and active tasks");
  require(saturated.active == 1 && saturated.queued == 1,
          "active and queued task metrics should be reported separately");
  require(saturated.active_bytes == 6 && saturated.queued_bytes == 4,
          "active and queued byte metrics should be reported separately");
  require(saturated.high_water_items == 2, "item high-water mark should be recorded");
  require(saturated.high_water_bytes == 10, "byte high-water mark should be recorded");
  require(saturated.rejected == 1, "timed-out submit should increment rejected count");

  release_first.set_value();
  require(first.future.get() == 0, "first task should complete successfully");
  require(second.future.get() == 0, "second task should complete successfully");
  require(pool.drain_for(1s), "pool should drain after the gate is released");

  const auto drained = pool.stats();
  require(drained.pending_items == 0 && drained.pending_bytes == 0,
          "drained pool should have no pending work");
  require(drained.completed == 2 && drained.failed == 0,
          "successful task counters are incorrect");
}

void failed_tasks_and_exceptions_are_observable() {
  StorageThreadPool pool(1, 4, 64);
  auto error_code = pool.submit([]() { return 500; }, 8, 0ms);
  auto exception = pool.submit([]() -> int { throw std::runtime_error("writer failed"); }, 8, 0ms);
  require(error_code.accepted() && exception.accepted(), "failure tasks should be enqueued");
  require(error_code.future.get() == 500, "non-zero writer result should be preserved");
  bool threw = false;
  try {
    static_cast<void>(exception.future.get());
  } catch (const std::runtime_error&) {
    threw = true;
  }
  require(threw, "writer exception should be propagated through the future");
  require(pool.drain_for(1s), "failure tasks should still drain");
  const auto stats = pool.stats();
  require(stats.completed == 0 && stats.failed == 2,
          "non-zero results and exceptions should increment failed count");
}

void blocked_submit_resumes_on_capacity_and_stop() {
  {
    StorageThreadPool pool(1, 1, 8);
    std::promise<void> release;
    std::shared_future<void> gate = release.get_future().share();
    auto first = pool.submit([gate]() {
      gate.wait();
      return 0;
    }, 8, 0ms);
    require(first.accepted(), "first capacity test task should be accepted");
    wait_until([&]() { return pool.stats().active == 1; }, "capacity test task did not start");
    auto waiting = std::async(std::launch::async, [&]() {
      return pool.submit([]() { return 0; }, 8, 1s);
    });
    require(waiting.wait_for(20ms) == std::future_status::timeout,
            "submit should wait while capacity is exhausted");
    release.set_value();
    require(first.future.get() == 0, "first capacity test task should finish");
    auto second = waiting.get();
    require(second.accepted(), "waiting submit should be accepted after capacity is released");
    require(second.future.get() == 0, "waiting task should complete");
    require(pool.drain_for(1s), "capacity test pool should drain");
  }

  {
    StorageThreadPool pool(1, 1, 8);
    std::promise<void> release;
    std::shared_future<void> gate = release.get_future().share();
    auto active = pool.submit([gate]() {
      gate.wait();
      return 0;
    }, 8, 0ms);
    require(active.accepted(), "stop wake test task should be accepted");
    wait_until([&]() { return pool.stats().active == 1; }, "stop wake test task did not start");
    auto waiting = std::async(std::launch::async, [&]() {
      return pool.submit([]() { return 0; }, 8, 1s);
    });
    require(waiting.wait_for(20ms) == std::future_status::timeout,
            "submit should be waiting before stop_accepting");
    pool.stop_accepting();
    auto stopped = waiting.get();
    require(stopped.status == StorageSubmitStatus::Stopped,
            "stop_accepting should wake and reject a waiting submit");
    release.set_value();
    require(active.future.get() == 0, "accepted task should finish after stop_accepting");
    require(pool.drain_for(1s), "stop wake test pool should drain accepted work");
  }
}

void drain_publishes_future_before_returning() {
  StorageThreadPool pool(1, 1, 8);
  auto submitted = pool.submit([]() {
    std::this_thread::sleep_for(10ms);
    return 0;
  }, 8, 0ms);
  require(submitted.accepted(), "drain publication task should be accepted");
  require(pool.drain_for(1s), "drain publication task should drain");
  require(submitted.future.wait_for(0ms) == std::future_status::ready,
          "drain must not return before the task future is published");
  require(submitted.future.get() == 0, "drain publication task should succeed");
}

void stop_and_drain_have_explicit_semantics() {
  StorageThreadPool pool(1, 1, 8);
  std::promise<void> release;
  std::shared_future<void> gate = release.get_future().share();
  auto active = pool.submit([gate]() {
    gate.wait();
    return 0;
  }, 8, 0ms);
  require(active.accepted(), "active task should be accepted");
  wait_until([&]() { return pool.stats().active == 1; }, "task did not become active");
  require(!pool.drain_for(20ms), "drain should time out while a task is blocked");

  pool.stop_accepting();
  auto stopped = pool.submit([]() { return 0; }, 1, 0ms);
  require(stopped.status == StorageSubmitStatus::Stopped,
          "submissions after stop_accepting should be rejected as stopped");
  auto too_large_pool = StorageThreadPool(1, 1, 4);
  auto too_large = too_large_pool.submit([]() { return 0; }, 5, 0ms);
  require(too_large.status == StorageSubmitStatus::TooLarge,
          "a task larger than the byte capacity should be rejected immediately");

  release.set_value();
  require(active.future.get() == 0, "active task should finish after stop_accepting");
  require(pool.drain_for(1s), "accepted work should drain after stop_accepting");
  const auto stats = pool.stats();
  require(!stats.accepting, "stats should report accepting=false after stop_accepting");
  require(stats.rejected == 1, "stopped submit should increment rejected count");
}

}  // namespace

int main() {
  try {
    bounded_queue_applies_item_and_byte_backpressure();
    failed_tasks_and_exceptions_are_observable();
    blocked_submit_resumes_on_capacity_and_stop();
    drain_publishes_future_before_returning();
    stop_and_drain_have_explicit_semantics();
    std::cout << "storage_thread_pool_test passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "storage_thread_pool_test failed: " << error.what() << "\n";
    return 1;
  }
}
