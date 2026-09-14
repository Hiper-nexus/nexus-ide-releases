#pragma once
#include "win32-support.hpp"
#include <array>
#include <thread>
#include <mutex>

namespace spike {
struct JobCounts { DWORD active; DWORD assigned; DWORD listed; };
inline JobCounts queryJob(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  require(!!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "job accounting query");
  constexpr size_t kMaxMembers = 1024;
  alignas(JOBOBJECT_BASIC_PROCESS_ID_LIST) std::array<unsigned char,
      sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * kMaxMembers> storage{};
  auto* members = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  require(!!QueryInformationJobObject(job, JobObjectBasicProcessIdList, members,
      static_cast<DWORD>(storage.size()), nullptr), "job member query (bounded buffer)");
  expect(members->NumberOfProcessIdsInList == members->NumberOfAssignedProcesses, "truncated job inventory cannot prove zero");
  return {accounting.ActiveProcesses, members->NumberOfAssignedProcesses, members->NumberOfProcessIdsInList};
}
inline void requireZeroJob(HANDLE job, DWORD timeout = kDeadlineMs) {
  const auto deadline = GetTickCount64() + timeout;
  unsigned zeroReads = 0;
  do {
    auto count = queryJob(job);
    zeroReads = count.active == 0 && count.assigned == 0 && count.listed == 0 ? zeroReads + 1 : 0;
    if (zeroReads == 2) return;
    Sleep(10);
  } while (GetTickCount64() < deadline);
  throw std::runtime_error("job did not reach observed zero-member state before deadline");
}
class Job {
  Handle handle_;
public:
  Job() : handle_(CreateJobObjectW(nullptr, nullptr)) {
    require(!!handle_, "CreateJobObject unnamed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(!!SetInformationJobObject(handle_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "set kill-on-close");
    require(!!SetHandleInformation(handle_.get(), HANDLE_FLAG_INHERIT, 0), "job noninheritance");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION observed{};
    require(!!QueryInformationJobObject(handle_.get(), JobObjectExtendedLimitInformation, &observed, sizeof(observed), nullptr), "query job policy");
    expect(observed.BasicLimitInformation.LimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, "job must not enable breakaway or other limits");
  }
  HANDLE get() const { return handle_.get(); }
  void stop() {
    require(!!TerminateJobObject(get(), 29), "TerminateJobObject exact capability");
    requireZeroJob(get());
  }
};
class Console {
  HPCON console_ = nullptr;
  Handle input_;
  Handle output_;
  std::thread reader_;
  std::mutex outputMutex_;
  std::string transcript_;
public:
  Console() {
    HANDLE inputRead = nullptr, inputWrite = nullptr, outputRead = nullptr, outputWrite = nullptr;
    require(!!CreatePipe(&inputRead, &inputWrite, nullptr, 0), "ConPTY input pipe");
    Handle readInput(inputRead); input_.reset(inputWrite);
    require(!!CreatePipe(&outputRead, &outputWrite, nullptr, 0), "ConPTY output pipe");
    output_.reset(outputRead); Handle writeOutput(outputWrite);
    HRESULT status = CreatePseudoConsole({80, 25}, readInput.get(), writeOutput.get(), 0, &console_);
    expect(SUCCEEDED(status), "CreatePseudoConsole failed");
    try {
      reader_ = std::thread([this] {
        std::array<char, 4096> buffer{}; DWORD count = 0;
        while (ReadFile(output_.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) && count != 0) {
          std::lock_guard<std::mutex> lock(outputMutex_);
          transcript_.append(buffer.data(), count);
          constexpr size_t kCaptureLimit = 64 * 1024;
          if (transcript_.size() > kCaptureLimit) transcript_.erase(0, transcript_.size() - kCaptureLimit);
        }
      });
    } catch (...) { ClosePseudoConsole(console_); console_ = nullptr; throw; }
  }
  ~Console() { close(); }
  HPCON get() const { return console_; }
  void expectOutput(const std::string& marker) {
    const auto deadline = GetTickCount64() + kDeadlineMs;
    do {
      { std::lock_guard<std::mutex> lock(outputMutex_); if (transcript_.find(marker) != std::string::npos) return; }
      Sleep(10);
    } while (GetTickCount64() < deadline);
    throw std::runtime_error("root output did not traverse the exact pseudoconsole pipe");
  }
  void close() noexcept {
    if (!console_) return;
    HPCON closing = std::exchange(console_, nullptr);
    try {
      auto done = event();
      std::thread closer([closing, signal = done.get()] { ClosePseudoConsole(closing); SetEvent(signal); });
      if (WaitForSingleObject(done.get(), kDeadlineMs) != WAIT_OBJECT_0) failFast("ConPTY close deadline");
      closer.join();
      input_.reset();
      if (reader_.joinable()) {
        CancelSynchronousIo(reader_.native_handle());
        if (WaitForSingleObject(reader_.native_handle(), kDeadlineMs) != WAIT_OBJECT_0) failFast("ConPTY drain deadline");
        reader_.join();
      }
      output_.reset();
    } catch (...) { failFast("ConPTY finalizer"); }
  }
};
struct Cohort {
  Handle child;
  Handle grandchild;
  Handle attemptedBreakaway;
};
inline Cohort receiveCohort(Pipe& pipe, HANDLE root) {
  Packet packet = pipe.receive(); expect(packet.kind == kCohort, "expected cohort readiness packet");
  expect((packet.c == 0 && packet.error == ERROR_ACCESS_DENIED) || (packet.c != 0 && packet.error == ERROR_SUCCESS), "unexpected breakaway outcome");
  Cohort result{duplicateFrom(root, packet.a), duplicateFrom(root, packet.b), {}};
  if (packet.c) result.attemptedBreakaway = duplicateFrom(root, packet.c);
  pipe.send({kAck}); return result;
}
inline void verifyCohort(const Cohort& cohort, HANDLE job) {
  expect(belongs(cohort.child.get(), job) && belongs(cohort.grandchild.get(), job), "detached child/grandchild escaped job");
  expect(!exited(cohort.child.get()) && !exited(cohort.grandchild.get()), "fixture descendants must be alive before termination");
  if (cohort.attemptedBreakaway) expect(belongs(cohort.attemptedBreakaway.get(), job), "successful breakaway escaped owned job");
}
inline void waitCohort(const Cohort& cohort) {
  expect(exited(cohort.child.get(), kDeadlineMs), "detached child still alive");
  expect(exited(cohort.grandchild.get(), kDeadlineMs), "grandchild still alive");
  if (cohort.attemptedBreakaway) expect(exited(cohort.attemptedBreakaway.get(), kDeadlineMs), "breakaway attempt still alive");
}
} // namespace spike
namespace spike {
// A single owner orders job cleanup before console drain on all exception paths.
class Launch {
public:
  Job job;
  Console console;
  Process root;
  Launch(const std::vector<std::wstring>& args, bool assign = true, HANDLE fixtureSafetyJob = nullptr)
      : root(spawn(args, assign ? job.get() : fixtureSafetyJob, console.get(), CREATE_SUSPENDED)) {}
  ~Launch() {
    try {
      job.stop();
      if (root.process && !exited(root.process.get())) terminateExact(root.process.get());
      console.close();
    } catch (...) { failFast("owned launch finalizer"); }
  }
  void stop() {
    job.stop();
    expect(exited(root.process.get(), kDeadlineMs), "root exit missing after zero-member job query");
    console.close();
  }
};
} // namespace spike
