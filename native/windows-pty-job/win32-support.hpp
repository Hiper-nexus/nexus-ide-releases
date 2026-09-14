#pragma once
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <sddl.h>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace spike {
constexpr DWORD kDeadlineMs = 8000;
struct PipeTimeout : std::runtime_error { PipeTimeout() : std::runtime_error("bounded pipe timeout/cancellation") {} };
struct WinError : std::runtime_error {
  DWORD code;
  explicit WinError(const char* stage, DWORD value = GetLastError())
      : std::runtime_error(std::string(stage) + " Win32=" + std::to_string(value)), code(value) {}
};
inline void require(bool value, const char* stage) { if (!value) throw WinError(stage); }
inline void expect(bool value, const char* stage) { if (!value) throw std::runtime_error(stage); }
[[noreturn]] inline void failFast(const char* stage) {
  std::cerr << "fatal bounded cleanup: " << stage << std::endl;
  ExitProcess(71); // This test process only; its fixture job closes at process exit.
}
class Handle {
  HANDLE value_ = nullptr;
public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept { if (this != &other) reset(other.release()); return *this; }
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
  HANDLE release() { return std::exchange(value_, nullptr); }
  void reset(HANDLE value = nullptr) { if (*this) CloseHandle(value_); value_ = value; }
};
inline Handle event() { Handle h(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(!!h, "CreateEvent"); return h; }
inline bool exited(HANDLE process, DWORD timeout = 0) {
  DWORD value = WaitForSingleObject(process, timeout);
  if (value == WAIT_OBJECT_0) return true;
  if (value == WAIT_TIMEOUT) return false;
  throw WinError("WaitForSingleObject");
}
inline void terminateExact(HANDLE process) {
  if (!exited(process)) require(!!TerminateProcess(process, 37), "TerminateProcess retained fixture handle");
  expect(exited(process, kDeadlineMs), "retained fixture process did not exit");
}
inline std::wstring uniqueName() {
  unsigned char bytes[16]{};
  expect(BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "BCryptGenRandom");
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result;
  for (auto byte : bytes) { result += digits[byte >> 4]; result += digits[byte & 15]; }
  return result;
}
inline std::wstring executable() {
  std::vector<wchar_t> result(32768);
  DWORD size = GetModuleFileNameW(nullptr, result.data(), static_cast<DWORD>(result.size()));
  require(size > 0 && size < result.size(), "GetModuleFileName");
  return {result.data(), size};
}
inline std::wstring quote(const std::wstring& value) {
  // All arguments are fixed role names or generated file/pipe paths, never shell text.
  expect(value.find(L'"') == std::wstring::npos && (value.empty() || value.back() != L'\\'), "invalid fixture argument");
  return L"\"" + value + L"\"";
}
class AttributeList {
  std::vector<unsigned char> memory_;
  bool initialized_ = false;
public:
  explicit AttributeList(DWORD count) {
    if (!count) return;
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    require(size != 0, "attribute-list size");
    memory_.resize(size);
    require(!!InitializeProcThreadAttributeList(get(), count, 0, &size), "attribute-list initialize");
    initialized_ = true;
  }
  ~AttributeList() { if (initialized_) DeleteProcThreadAttributeList(get()); }
  LPPROC_THREAD_ATTRIBUTE_LIST get() { return memory_.empty() ? nullptr : reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory_.data()); }
  void set(DWORD_PTR attribute, void* value, SIZE_T size) {
    require(!!UpdateProcThreadAttribute(get(), 0, attribute, value, size, nullptr, nullptr), "UpdateProcThreadAttribute");
  }
};
struct Process { Handle process; Handle thread; };
inline Process spawn(const std::vector<std::wstring>& args, HANDLE job = nullptr,
                     HPCON console = nullptr, DWORD flags = 0) {
  DWORD count = (job ? 1u : 0u) + (console ? 1u : 0u);
  AttributeList attributes(count);
  if (job) attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job));
  if (console) attributes.set(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, sizeof(console));
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(count ? sizeof(startup) : sizeof(STARTUPINFOW));
  startup.lpAttributeList = attributes.get();
  if (console) {
    // Suppress the driver's redirected standard handles so ConPTY supplies its
    // own console handles (Microsoft Terminal discussion #15814; node-pty does this).
    startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullptr;
    startup.StartupInfo.hStdOutput = nullptr;
    startup.StartupInfo.hStdError = nullptr;
  }
  std::wstring command = quote(executable());
  for (const auto& arg : args) command += L" " + quote(arg);
  PROCESS_INFORMATION created{};
  require(!!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
      flags | CREATE_UNICODE_ENVIRONMENT | (count ? EXTENDED_STARTUPINFO_PRESENT : 0),
      nullptr, nullptr, &startup.StartupInfo, &created), "CreateProcessW");
  return {Handle(created.hProcess), Handle(created.hThread)};
}
inline void resume(Process& process) {
  expect(ResumeThread(process.thread.get()) == 1, "root must resume exactly once from CREATE_SUSPENDED");
  process.thread.reset();
}
inline bool belongs(HANDLE process, HANDLE job) {
  BOOL value = FALSE;
  require(!!IsProcessInJob(process, job, &value), "IsProcessInJob exact handles");
  return value != FALSE;
}
inline std::uint64_t wireHandle(HANDLE value) { return reinterpret_cast<std::uintptr_t>(value); }
inline Handle duplicateFrom(HANDLE exactSourceProcess, std::uint64_t sourceValue) {
  expect(sourceValue != 0, "missing source process handle capability");
  HANDLE copy = nullptr;
  require(!!DuplicateHandle(exactSourceProcess, reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(sourceValue)),
      GetCurrentProcess(), &copy, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
      FALSE, 0), "DuplicateHandle from retained exact creator");
  return Handle(copy);
}

// Test-only handle transfer. The source process handle is already retained by its
// parent; wire values never authorize OpenProcess or PID-based termination.
struct Packet { std::uint32_t kind = 0; std::uint32_t error = 0; std::uint64_t a = 0, b = 0, c = 0; };
constexpr std::uint32_t kChild = 1, kCohort = 2, kSuspended = 3, kResume = 4, kAck = 5;
class Pipe {
  Handle pipe_;
  std::wstring name_;
  void complete(OVERLAPPED& operation, DWORD timeout, DWORD& count) {
    DWORD status = WaitForSingleObject(operation.hEvent, timeout);
    if (status != WAIT_OBJECT_0) {
      DWORD waitError = GetLastError();
      CancelIoEx(pipe_.get(), &operation);
      if (WaitForSingleObject(operation.hEvent, 1000) != WAIT_OBJECT_0) failFast("cancelled pipe operation did not settle");
      if (status == WAIT_TIMEOUT) throw PipeTimeout();
      throw WinError("pipe wait failed", waitError);
    }
    require(!!GetOverlappedResult(pipe_.get(), &operation, &count, FALSE), "pipe completion");
  }
  void transfer(Packet& packet, bool writing) {
    auto ready = event(); OVERLAPPED operation{}; operation.hEvent = ready.get(); DWORD count = 0;
    BOOL done = writing ? WriteFile(pipe_.get(), &packet, sizeof(packet), &count, &operation)
                        : ReadFile(pipe_.get(), &packet, sizeof(packet), &count, &operation);
    if (!done) { require(GetLastError() == ERROR_IO_PENDING, "pipe transfer"); complete(operation, kDeadlineMs, count); }
    expect(count == sizeof(packet), "partial/malformed handle transfer packet");
  }
public:
  explicit Pipe(bool server, const std::wstring& name = L"") {
    name_ = server ? L"\\\\.\\pipe\\nexus-job-spike-" + uniqueName() : name;
    if (!server) {
      pipe_.reset(CreateFileW(name_.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
      require(!!pipe_, "pipe client open"); return;
    }
    Handle token; HANDLE rawToken = nullptr;
    require(!!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken), "OpenProcessToken"); token.reset(rawToken);
    DWORD size = 0; GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
    std::vector<unsigned char> data(size);
    require(!!GetTokenInformation(token.get(), TokenUser, data.data(), size, &size), "GetTokenInformation");
    LPWSTR sid = nullptr;
    require(!!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid), "ConvertSidToStringSid");
    std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(sid) + L")"; LocalFree(sid);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(!!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr), "pipe DACL");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    pipe_.reset(CreateNamedPipeW(name_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 1024, 1024, 0, &security));
    LocalFree(descriptor); require(!!pipe_, "CreateNamedPipe");
  }
  const std::wstring& name() const { return name_; }
  void accept(DWORD timeout = kDeadlineMs) {
    auto ready = event(); OVERLAPPED operation{}; operation.hEvent = ready.get(); DWORD count = 0;
    if (ConnectNamedPipe(pipe_.get(), &operation)) return;
    DWORD error = GetLastError(); if (error == ERROR_PIPE_CONNECTED) return;
    require(error == ERROR_IO_PENDING, "ConnectNamedPipe"); complete(operation, timeout, count);
  }
  Packet receive() { Packet value; transfer(value, false); return value; }
  void send(Packet value) { transfer(value, true); }
};
} // namespace spike
