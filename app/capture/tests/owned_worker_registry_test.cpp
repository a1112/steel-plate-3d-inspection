#include "owned_worker_registry.h"

#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;
using steel_capture::OwnedWorkerRegistry;

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void timeout_keeps_thread_owned_until_completion() {
  OwnedWorkerRegistry registry;
  std::promise<void> release;
  std::shared_future<void> gate = release.get_future().share();
  auto done = std::make_shared<std::atomic_bool>(false);
  std::thread worker([gate, done]() {
    gate.wait();
    done->store(true, std::memory_order_release);
  });

  require(registry.adopt(worker, done, true), "running SDK worker should be adopted");
  require(!worker.joinable(), "ownership must move out of the caller thread handle");
  const auto running = registry.stats();
  require(running.owned == 1 && running.running == 1 && running.sdk_running == 1,
          "running SDK worker metrics are incorrect");
  require(!registry.wait_until(std::chrono::steady_clock::now() + 20ms),
          "bounded wait must fail while the owned worker is blocked");
  require(registry.stats().owned == 1,
          "timed-out wait must retain ownership of the worker handle");

  release.set_value();
  require(registry.wait_until(std::chrono::steady_clock::now() + 1s),
          "completed owned worker should be joined before the deadline");
  const auto drained = registry.stats();
  require(drained.owned == 0 && drained.adopted == 1 && drained.reaped == 1,
          "completed owned worker was not reaped exactly once");
}

void completed_worker_can_be_adopted_and_reaped() {
  OwnedWorkerRegistry registry;
  auto done = std::make_shared<std::atomic_bool>(false);
  std::thread worker([done]() {
    done->store(true, std::memory_order_release);
  });
  while (!done->load(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  require(registry.adopt(worker, done, false), "completed worker should still transfer ownership");
  require(registry.reap_completed() == 1, "completed worker should be joined by reap_completed");
  require(registry.empty(), "registry should be empty after reaping");
}

}  // namespace

int main() {
  try {
    timeout_keeps_thread_owned_until_completion();
    completed_worker_can_be_adopted_and_reaped();
    std::cout << "owned_worker_registry_test passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "owned_worker_registry_test failed: " << error.what() << "\n";
    return 1;
  }
}
