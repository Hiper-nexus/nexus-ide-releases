#include "owned-job.hpp"
#include <functional>

using namespace spike;
constexpr const char* kConsoleMarker = "NEXUS_JOB_SPIKE_CONPTY_MARKER";

[[noreturn]] void sleepForever() { for (;;) Sleep(INFINITE); }

int detachedChild(const std::wstring& pipeName) {
  (void)FreeConsole(); // Console detachment must not remove inherited job membership.
  Job nested;
  auto grandchild = spawn({L"--sleep"}, nested.get(), nullptr, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
  Pipe parent(false, pipeName);
  parent.send({kChild, 0, wireHandle(grandchild.process.get())});
  expect(parent.receive().kind == kAck, "grandchild handle transfer acknowledgement missing");
  sleepForever();
}

int cohortRoot(const std::wstring& parentPipe, bool exitAfterReady) {
  DWORD consoleMode = 0;
  require(!!GetConsoleMode(GetStdHandle(STD_OUTPUT_HANDLE), &consoleMode), "root console attachment");
  std::cout << kConsoleMarker << std::endl;
  Pipe childPipe(true);
  auto child = spawn({L"--child", childPipe.name()}, nullptr, nullptr, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
  childPipe.accept();
  Packet childPacket = childPipe.receive(); expect(childPacket.kind == kChild, "child readiness missing");
  auto grandchild = duplicateFrom(child.process.get(), childPacket.a);
  childPipe.send({kAck});
  Process breakaway;
  DWORD breakawayError = ERROR_SUCCESS;
  try { breakaway = spawn({L"--sleep"}, nullptr, nullptr, DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB); }
  catch (const WinError& error) { breakawayError = error.code; }
  Pipe parent(false, parentPipe);
  parent.send({kCohort, breakawayError, wireHandle(child.process.get()), wireHandle(grandchild.get()), wireHandle(breakaway.process.get())});
  expect(parent.receive().kind == kAck, "root handle transfer acknowledgement missing");
  if (exitAfterReady) return 0;
  sleepForever();
}

void writeMarker(const std::wstring& filename) {
  Handle file(CreateFileW(filename.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(!!file, "fixture marker open"); DWORD written = 0;
  require(!!WriteFile(file.get(), "ran", 3, &written, nullptr) && written == 3, "fixture marker write");
  sleepForever();
}

int creator(const std::wstring& parentPipe, bool suspendedOnly, const std::wstring& marker) {
  Pipe rootPipe(true);
  Launch launch(suspendedOnly ? std::vector<std::wstring>{L"--marker", marker}
                              : std::vector<std::wstring>{L"--root", rootPipe.name(), L"stay"});
  expect(belongs(launch.root.process.get(), launch.job.get()), "creator root not assigned before resume");
  Pipe parent(false, parentPipe);
  parent.send({kSuspended, 0, wireHandle(launch.root.process.get())});
  expect(parent.receive().kind == kResume, "creator command missing");
  if (suspendedOnly) sleepForever();
  resume(launch.root);
  rootPipe.accept();
  auto cohort = receiveCohort(rootPipe, launch.root.process.get());
  verifyCohort(cohort, launch.job.get());
  launch.console.expectOutput(kConsoleMarker);
  parent.send({kCohort, static_cast<std::uint32_t>(cohort.attemptedBreakaway ? ERROR_SUCCESS : ERROR_ACCESS_DENIED),
      wireHandle(cohort.child.get()), wireHandle(cohort.grandchild.get()), wireHandle(cohort.attemptedBreakaway.get())});
  expect(parent.receive().kind == kAck, "observer handle receipt missing");
  sleepForever(); // The driver deliberately terminates this exact creator handle.
}

void sentinelAlive(HANDLE sentinel) { expect(!exited(sentinel), "unrelated sentinel was terminated"); }
void detachedTest(HANDLE sentinel, bool rootExits) {
  Pipe channel(true);
  Launch launch({L"--root", channel.name(), rootExits ? L"exit" : L"stay"});
  expect(belongs(launch.root.process.get(), launch.job.get()), "root not a job member before ResumeThread");
  expect(!belongs(sentinel, launch.job.get()), "sentinel accidentally shares target job");
  expect(queryJob(launch.job.get()).active == 1, "suspended root inventory mismatch");
  resume(launch.root);
  channel.accept();
  auto cohort = receiveCohort(channel, launch.root.process.get());
  verifyCohort(cohort, launch.job.get());
  launch.console.expectOutput(kConsoleMarker);
  if (rootExits) {
    expect(exited(launch.root.process.get(), kDeadlineMs), "root did not exit naturally");
    expect(queryJob(launch.job.get()).active >= 2, "job lifetime ended before detached descendants");
  }
  launch.stop();
  waitCohort(cohort);
  sentinelAlive(sentinel);
}

std::wstring markerPath() {
  wchar_t directory[MAX_PATH]{};
  DWORD length = GetTempPathW(MAX_PATH, directory);
  require(length != 0 && length < MAX_PATH, "GetTempPath");
  return std::wstring(directory) + L"nexus-job-spike-" + uniqueName() + L".marker";
}
void expectNoMarker(const std::wstring& marker) {
  DWORD attributes = GetFileAttributesW(marker.c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES) { DeleteFileW(marker.c_str()); throw std::runtime_error("suspended root executed user marker"); }
  require(GetLastError() == ERROR_FILE_NOT_FOUND, "cannot verify absence of marker");
}
void beforeResumeTest(HANDLE sentinel) {
  auto marker = markerPath();
  Launch launch({L"--marker", marker});
  expect(belongs(launch.root.process.get(), launch.job.get()), "pre-resume root lacks job ownership");
  launch.stop();
  expectNoMarker(marker);
  sentinelAlive(sentinel);
}
void creatorCrashTest(HANDLE safetyJob, HANDLE sentinel, bool beforeResume) {
  Pipe channel(true); auto marker = markerPath();
  auto owner = spawn({L"--creator", channel.name(), beforeResume ? L"suspended" : L"running", marker}, safetyJob, nullptr, CREATE_NO_WINDOW);
  channel.accept(); Packet ready = channel.receive(); expect(ready.kind == kSuspended, "creator suspended readiness missing");
  auto root = duplicateFrom(owner.process.get(), ready.a);
  channel.send({kResume});
  Cohort cohort;
  if (!beforeResume) cohort = receiveCohort(channel, owner.process.get());
  // Never duplicate the job HANDLE: observer process handles do not defeat kill-on-last-close.
  terminateExact(owner.process.get());
  expect(exited(root.get(), kDeadlineMs), "creator crash left an owned root alive");
  if (beforeResume) expectNoMarker(marker); else waitCohort(cohort);
  sentinelAlive(sentinel);
}
void negativeControls(HANDLE safetyJob, HANDLE sentinel) {
  auto marker = markerPath();
  {
    Launch uncovered({L"--marker", marker}, false, safetyJob);
    expect(!belongs(uncovered.root.process.get(), uncovered.job.get()), "negative control failed to detect omitted target job assignment");
    terminateExact(uncovered.root.process.get());
    uncovered.stop();
  }
  expectNoMarker(marker);
  bool queryRejected = false;
  try { (void)queryJob(INVALID_HANDLE_VALUE); } catch (const WinError&) { queryRejected = true; }
  expect(queryRejected, "invalid query became successful zero proof");
  Pipe absentPeer(true); bool cancelled = false;
  try { absentPeer.accept(250); } catch (const PipeTimeout&) { cancelled = true; }
  expect(cancelled, "unconnected pipe did not cancel at deadline");
  sentinelAlive(sentinel);
}

int driver() {
  // Contains only this driver's own fixtures if the driver or its outer watchdog dies.
  // It is distinct from every target job and never contains the driver itself.
  Job safety;
  auto sentinel = spawn({L"--sleep"}, safety.get(), nullptr, CREATE_NO_WINDOW);
  unsigned passed = 0;
  auto test = [&](const char* name, const std::function<void()>& body) {
    std::cout << "{\"test\":\"" << name << "\",\"status\":\"running\"}" << std::endl;
    body(); ++passed;
    std::cout << "{\"test\":\"" << name << "\",\"status\":\"pass\"}" << std::endl;
  };
  test("detached-grandchild-and-breakaway", [&] { detachedTest(sentinel.process.get(), false); });
  test("natural-root-exit-retains-job", [&] { detachedTest(sentinel.process.get(), true); });
  test("kill-before-resume", [&] { beforeResumeTest(sentinel.process.get()); });
  test("creator-crash-before-resume", [&] { creatorCrashTest(safety.get(), sentinel.process.get(), true); });
  test("creator-crash-with-descendants", [&] { creatorCrashTest(safety.get(), sentinel.process.get(), false); });
  test("negative-controls-and-cancelled-connect", [&] { negativeControls(safety.get(), sentinel.process.get()); });
  terminateExact(sentinel.process.get());
  safety.stop();
  std::cout << "{\"summary\":\"pass\",\"tests\":" << passed << "}" << std::endl;
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 1) return driver();
    std::wstring role = argv[1];
    if (role == L"--sleep" && argc == 2) sleepForever();
    if (role == L"--child" && argc == 3) return detachedChild(argv[2]);
    if (role == L"--root" && argc == 4) return cohortRoot(argv[2], std::wstring(argv[3]) == L"exit");
    if (role == L"--marker" && argc == 3) writeMarker(argv[2]);
    if (role == L"--creator" && argc == 5) return creator(argv[2], std::wstring(argv[3]) == L"suspended", argv[4]);
    throw std::runtime_error("invalid fixture role");
  } catch (const std::exception& error) {
    std::cerr << "{\"status\":\"fail\",\"error\":\"" << error.what() << "\"}" << std::endl;
    return 1;
  }
}
