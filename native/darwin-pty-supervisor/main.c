/*
 * NexusIDE Darwin PTY responsibility supervisor.
 *
 * This helper intentionally uses macOS private process-responsibility symbols,
 * resolved at runtime with dlsym.  See docs/DARWIN-PTY-SUPERVISOR.md before
 * changing the fail-closed behavior.
 */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#define NEXUS_EXIT_USAGE 64
#define NEXUS_EXIT_PRIVATE_API 70
#define NEXUS_EXIT_INVENTORY 71
#define NEXUS_EXIT_DISCLAIM 72
#define NEXUS_EXIT_SPAWN 73
#define NEXUS_EXIT_RESPONSIBILITY 74
#define NEXUS_EXIT_INTERNAL 75
#define NEXUS_EXIT_CODE_IDENTITY 76
#define NEXUS_EXIT_PROVEN_AMBIGUOUS_PROVIDER_STATUS 125
#define NEXUS_SIGNAL_EXIT_MIN 129
#define NEXUS_SIGNAL_EXIT_MAX 159

#define PROC_PIDUNIQIDENTIFIERINFO_PRIVATE 17
#define INVENTORY_SCHEMA_VERSION 1
#define TERM_GRACE_MS 1500
#define ABSENCE_CONFIRM_DELAY_MS 60
#define LOOP_DELAY_MS 20
#define CODE_IDENTITY_RETRY_COUNT 100
#define CODE_IDENTITY_RETRY_DELAY_MS 5
#define CDHASH_HEX_LENGTH 40
#define CDHASH_BYTE_LENGTH 20
#define NEXUS_SUPERVISOR_IDENTIFIER "nexus-pty-supervisor"
#define NEXUS_APP_IDENTIFIER "com.nexuside.app"
#define NEXUS_UTILITY_HELPER_IDENTIFIER "com.nexuside.app.helper"
#define NEXUS_TEAM_IDENTIFIER "35P5XL3JN6"
#define NEXUS_PROVIDER_PROBE_RECEIPT                                      \
  "NEXUS_PTY_AUTHENTICATED_PROVIDER_PROBE_V1"
#define NEXUS_PACKAGED_HELPER_SUFFIX                                      \
  "/Contents/Resources/nexus-pty-supervisor"
#define NEXUS_MAIN_EXECUTABLE_SUFFIX "/Contents/MacOS/nexus-ide"
#define NEXUS_UTILITY_EXECUTABLE_SUFFIX                                   \
  "/Contents/Frameworks/NexusIDE Helper.app/Contents/MacOS/NexusIDE Helper"

#ifndef NEXUS_TEST_TRACED_AUTH_HOLD_MS
#define NEXUS_TEST_TRACED_AUTH_HOLD_MS 0
#endif
#ifndef NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS
#define NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS 0
#endif
#ifndef NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS
#define NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS 0
#endif

/*
 * Private XNU structure used by PROC_PIDUNIQIDENTIFIERINFO (flavor 17).
 * It is copied here instead of importing a private SDK header.  The size check
 * makes an ABI drift a build failure rather than corrupting inventory data.
 */
struct nexus_proc_uniqidentifierinfo {
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  int32_t p_orig_ppidversion;
  uint64_t p_reserve2;
  uint64_t p_reserve3;
};
_Static_assert(sizeof(struct nexus_proc_uniqidentifierinfo) == 56,
               "unexpected proc_uniqidentifierinfo ABI");

typedef pid_t (*responsible_pid_fn)(pid_t);
typedef uint64_t (*responsible_unique_id_fn)(pid_t);
typedef int (*spawn_disclaim_fn)(const posix_spawnattr_t *, int);

struct responsibility_api {
  responsible_pid_fn responsible_pid;
  responsible_unique_id_fn responsible_unique_id;
  spawn_disclaim_fn set_disclaim;
};

struct process_record {
  pid_t pid;
  pid_t ppid;
  pid_t pgid;
  uint32_t status;
  uint64_t start_seconds;
  uint64_t start_microseconds;
  uint64_t process_unique_id;
  int32_t process_id_version;
  pid_t responsible_pid;
  uint64_t responsible_unique_id;
  char name[(2 * MAXCOMLEN) + 1];
};

struct process_list {
  struct process_record *records;
  size_t count;
  bool complete;
  unsigned int inaccessible_count;
};

struct responsibility_anchor {
  pid_t pid;
  uint64_t start_seconds;
  uint64_t start_microseconds;
  uint64_t process_unique_id;
  int32_t process_id_version;
  pid_t responsible_pid;
  uint64_t responsible_unique_id;
};

struct sealed_code_identity {
  const char *identifier;
  const char *team_identifier;
  const char *cdhash_hex;
  uint8_t cdhash[CDHASH_BYTE_LENGTH];
};

static volatile sig_atomic_t shutdown_signal = 0;

static bool consume_main_owned_launch_authorization(
    const struct responsibility_api *api);

static bool debug_enabled(void) {
  const char *value = getenv("NEXUS_PTY_SUPERVISOR_DEBUG");
  return value != NULL && strcmp(value, "1") == 0;
}

static void capture_shutdown_signal(int signal_number) {
  if (shutdown_signal == 0) {
    shutdown_signal = signal_number;
  }
}

/*
 * Terminal-generated SIGINT/SIGQUIT belong to the foreground CLI operation,
 * not to the pane lifecycle.  A caught no-op (rather than SIG_IGN) keeps the
 * supervisor alive and is reset to SIG_DFL when the child execs, so the CLI
 * still receives normal Ctrl-C/Ctrl-\ semantics.
 */
static void preserve_terminal_signal_for_child(int signal_number) {
  (void)signal_number;
}

static bool supervisor_signal_set(sigset_t *signals) {
  if (sigemptyset(signals) != 0) {
    return false;
  }
  return sigaddset(signals, SIGTERM) == 0 && sigaddset(signals, SIGINT) == 0 &&
         sigaddset(signals, SIGHUP) == 0 && sigaddset(signals, SIGQUIT) == 0;
}

static bool block_supervisor_signals(void) {
  sigset_t signals;
  return supervisor_signal_set(&signals) &&
         sigprocmask(SIG_BLOCK, &signals, NULL) == 0;
}

static void sleep_milliseconds(unsigned int milliseconds) {
  struct timespec requested = {
      .tv_sec = (time_t)(milliseconds / 1000U),
      .tv_nsec = (long)((milliseconds % 1000U) * 1000000U),
  };
  while (nanosleep(&requested, &requested) != 0 && errno == EINTR) {
  }
}

#if NEXUS_TEST_TRACED_AUTH_HOLD_MS > 0 ||                                  \
    NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS > 0 ||                                 \
    NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS > 0
static void test_write_ready_pid(const char *environment_name, pid_t pid) {
  const char *ready_path = getenv(environment_name);
  if (ready_path == NULL || ready_path[0] == '\0') {
    return;
  }
  FILE *ready = fopen(ready_path, "w");
  if (ready == NULL) {
    return;
  }
  (void)fprintf(ready, "%d\n", pid);
  (void)fclose(ready);
}
#endif

static uint64_t monotonic_milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return 0;
  }
  return ((uint64_t)now.tv_sec * 1000ULL) +
         ((uint64_t)now.tv_nsec / 1000000ULL);
}

static void *lookup_private_symbol(const char *name) {
  dlerror();
  void *symbol = dlsym(RTLD_DEFAULT, name);
  if (symbol != NULL) {
    return symbol;
  }

  /*
   * libquarantine is normally present in the dyld shared cache and re-exported
   * by libSystem.  Explicit loading covers hosts where RTLD_DEFAULT has not yet
   * materialized that image.  Absence is fatal before a governed CLI is born.
   */
  void *quarantine =
      dlopen("/usr/lib/system/libquarantine.dylib", RTLD_LAZY | RTLD_LOCAL);
  if (quarantine == NULL) {
    return NULL;
  }
  dlerror();
  return dlsym(quarantine, name);
}

static bool load_responsibility_api(struct responsibility_api *api,
                                    bool require_disclaim) {
  void *responsible_pid_symbol =
      lookup_private_symbol("responsibility_get_pid_responsible_for_pid");
  void *responsible_unique_id_symbol =
      lookup_private_symbol("responsibility_get_uniqueid_responsible_for_pid");
  void *set_disclaim_symbol =
      lookup_private_symbol("responsibility_spawnattrs_setdisclaim");
  if (responsible_pid_symbol == NULL || responsible_unique_id_symbol == NULL ||
      (require_disclaim && set_disclaim_symbol == NULL)) {
    return false;
  }

  /*
   * POSIX permits dlsym's void pointer to identify a function.  memcpy avoids
   * implementation-defined object-pointer casts under -Wpedantic.
   */
  memcpy(&api->responsible_pid, &responsible_pid_symbol,
         sizeof(api->responsible_pid));
  memcpy(&api->responsible_unique_id, &responsible_unique_id_symbol,
         sizeof(api->responsible_unique_id));
  if (set_disclaim_symbol != NULL) {
    memcpy(&api->set_disclaim, &set_disclaim_symbol, sizeof(api->set_disclaim));
  } else {
    api->set_disclaim = NULL;
  }
  return true;
}

static bool query_responsibility(const struct responsibility_api *api,
                                 pid_t pid, pid_t *responsible_pid,
                                 uint64_t *responsible_unique_id) {
  errno = 0;
  pid_t observed_pid = api->responsible_pid(pid);
  int pid_errno = errno;
  errno = 0;
  uint64_t observed_unique_id = api->responsible_unique_id(pid);
  int unique_id_errno = errno;
  if (observed_pid <= 0 || observed_unique_id == 0) {
    errno = unique_id_errno != 0 ? unique_id_errno
                                 : (pid_errno != 0 ? pid_errno : ESRCH);
    return false;
  }
  *responsible_pid = observed_pid;
  *responsible_unique_id = observed_unique_id;
  return true;
}

static bool load_process_record(const struct responsibility_api *api, pid_t pid,
                                struct process_record *record,
                                bool *process_disappeared);

static bool responsibility_api_self_test(const struct responsibility_api *api) {
  struct process_record first;
  struct process_record second;
  bool disappeared = false;
  if (!load_process_record(api, getpid(), &first, &disappeared)) {
    return false;
  }
  sleep_milliseconds(1);
  if (!load_process_record(api, getpid(), &second, &disappeared)) {
    return false;
  }
  return first.pid == second.pid &&
         first.process_unique_id == second.process_unique_id &&
         first.process_id_version == second.process_id_version &&
         first.responsible_pid == second.responsible_pid &&
         first.responsible_unique_id == second.responsible_unique_id;
}

static bool process_still_exists(pid_t pid) {
  if (kill(pid, 0) == 0) {
    return true;
  }
  return errno == EPERM;
}

/*
 * Used only as a negative-membership proof after responsibility lookup was
 * unavailable.  Two matching kernel unique-id reads prove that the PID still
 * names one stable process; XNU allocates these ids monotonically, so an id
 * older than the live anchor cannot belong to its responsibility cohort.
 */
static bool
stable_identity_predates_anchor(pid_t pid,
                                const struct responsibility_anchor *anchor) {
  struct nexus_proc_uniqidentifierinfo first;
  struct nexus_proc_uniqidentifierinfo second;
  memset(&first, 0, sizeof(first));
  memset(&second, 0, sizeof(second));
  int first_bytes = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO_PRIVATE, 0,
                                 &first, (int)sizeof(first));
  int second_bytes = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO_PRIVATE, 0,
                                  &second, (int)sizeof(second));
  return first_bytes == (int)sizeof(first) &&
         second_bytes == (int)sizeof(second) && first.p_uniqueid != 0 &&
         first.p_uniqueid == second.p_uniqueid &&
         first.p_idversion == second.p_idversion &&
         first.p_uniqueid < anchor->process_unique_id;
}

static bool append_record(struct process_list *list,
                          const struct process_record *record) {
  size_t next_count = list->count + 1;
  struct process_record *next =
      realloc(list->records, next_count * sizeof(*next));
  if (next == NULL) {
    return false;
  }
  list->records = next;
  list->records[list->count] = *record;
  list->count = next_count;
  return true;
}

static bool load_process_record(const struct responsibility_api *api, pid_t pid,
                                struct process_record *record,
                                bool *process_disappeared) {
  *process_disappeared = false;
  struct nexus_proc_uniqidentifierinfo unique_before;
  memset(&unique_before, 0, sizeof(unique_before));
  errno = 0;
  int unique_before_bytes =
      proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO_PRIVATE, 0, &unique_before,
                   (int)sizeof(unique_before));
  if (unique_before_bytes != (int)sizeof(unique_before)) {
    if (!process_still_exists(pid)) {
      *process_disappeared = true;
    }
    return false;
  }

  struct proc_bsdinfo bsd_info;
  memset(&bsd_info, 0, sizeof(bsd_info));
  errno = 0;
  int bsd_bytes =
      proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd_info, (int)sizeof(bsd_info));
  if (bsd_bytes != (int)sizeof(bsd_info)) {
    if (!process_still_exists(pid)) {
      *process_disappeared = true;
    }
    return false;
  }

  pid_t responsible_pid = 0;
  uint64_t responsible_unique_id = 0;
  if (!query_responsibility(api, pid, &responsible_pid,
                            &responsible_unique_id)) {
    /*
     * libquarantine reports ESRCH once a process is committed to exit, while
     * kill(pid, 0) can still observe its unreaped zombie.  Such a process
     * cannot create a descendant and is absent from the live cohort.
     */
    if (errno == ESRCH || !process_still_exists(pid)) {
      *process_disappeared = true;
    }
    return false;
  }

  struct nexus_proc_uniqidentifierinfo unique_after;
  memset(&unique_after, 0, sizeof(unique_after));
  errno = 0;
  int unique_after_bytes =
      proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO_PRIVATE, 0, &unique_after,
                   (int)sizeof(unique_after));
  if (unique_after_bytes != (int)sizeof(unique_after)) {
    if (!process_still_exists(pid)) {
      *process_disappeared = true;
    }
    return false;
  }
  /*
   * A PID is usable only when two private unique-identifier reads around the
   * other metadata agree.  Any exec is fine; PID reuse/reparent races are not.
   */
  if (unique_before.p_uniqueid != unique_after.p_uniqueid ||
      unique_before.p_idversion != unique_after.p_idversion ||
      unique_before.p_uniqueid == 0) {
    errno = EAGAIN;
    return false;
  }

  memset(record, 0, sizeof(*record));
  record->pid = pid;
  record->ppid = (pid_t)bsd_info.pbi_ppid;
  record->pgid = (pid_t)bsd_info.pbi_pgid;
  record->status = bsd_info.pbi_status;
  record->start_seconds = bsd_info.pbi_start_tvsec;
  record->start_microseconds = bsd_info.pbi_start_tvusec;
  record->process_unique_id = unique_after.p_uniqueid;
  record->process_id_version = unique_after.p_idversion;
  record->responsible_pid = responsible_pid;
  record->responsible_unique_id = responsible_unique_id;
  const char *source =
      bsd_info.pbi_name[0] != '\0' ? bsd_info.pbi_name : bsd_info.pbi_comm;
  size_t name_length = strnlen(source, sizeof(record->name) - 1);
  memcpy(record->name, source, name_length);
  record->name[name_length] = '\0';
  return true;
}

static struct process_list
inventory_processes(const struct responsibility_api *api,
                    const struct responsibility_anchor *filter) {
  struct process_list list = {
      .records = NULL,
      .count = 0,
      .complete = true,
      .inaccessible_count = 0,
  };

  /*
   * A responsibility cohort spawned by this unprivileged helper retains the
   * caller's real UID even across ordinary set-euid transitions.  Restricting
   * teardown enumeration to that kernel-owned index avoids treating protected
   * system processes as unknowable candidates.  Full inventory mode still
   * reports every PID and honestly marks inaccessible records incomplete.
   */
  int estimated = filter == NULL ? proc_listallpids(NULL, 0)
                                 : proc_listpids(PROC_RUID_ONLY,
                                                 (uint32_t)getuid(), NULL, 0) /
                                       (int)sizeof(pid_t);
  if (estimated <= 0) {
    list.complete = false;
    list.inaccessible_count = 1;
    return list;
  }
  int capacity = estimated + 128;
  pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
  if (pids == NULL) {
    list.complete = false;
    list.inaccessible_count = 1;
    return list;
  }
  int returned = filter == NULL
                     ? proc_listallpids(pids, capacity * (int)sizeof(*pids))
                     : proc_listpids(PROC_RUID_ONLY, (uint32_t)getuid(), pids,
                                     capacity * (int)sizeof(*pids));
  int count = filter == NULL ? returned : returned / (int)sizeof(pid_t);
  if (returned <= 0 || count >= capacity) {
    free(pids);
    list.complete = false;
    list.inaccessible_count = 1;
    return list;
  }

  for (int index = 0; index < count; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 0) {
      continue;
    }
    if (filter != NULL) {
      pid_t observed_responsible_pid = 0;
      uint64_t observed_responsible_unique_id = 0;
      if (!query_responsibility(api, pid, &observed_responsible_pid,
                                &observed_responsible_unique_id)) {
        int responsibility_errno = errno;
        /*
         * libquarantine returns ESRCH for processes already committed to exit
         * even during the short interval where kill(pid, 0) can still see the
         * PID.  Such a process cannot create a new descendant.  EPERM and all
         * other failures remain an incomplete, fail-closed scan.
         */
        if (responsibility_errno == ESRCH || !process_still_exists(pid)) {
          continue;
        }
        if (stable_identity_predates_anchor(pid, filter)) {
          continue;
        }
        {
          if (debug_enabled()) {
            fprintf(stderr,
                    "nexus-pty-supervisor: inventory pid=%d "
                    "responsibility-unavailable errno=%d anchor-unique=%llu\n",
                    pid, responsibility_errno,
                    (unsigned long long)filter->process_unique_id);
          }
          list.complete = false;
          list.inaccessible_count += 1;
        }
        continue;
      }
      if (observed_responsible_pid != filter->responsible_pid ||
          observed_responsible_unique_id != filter->responsible_unique_id) {
        continue;
      }
    }
    struct process_record record;
    bool disappeared = false;
    if (!load_process_record(api, pid, &record, &disappeared)) {
      if (!disappeared) {
        list.complete = false;
        list.inaccessible_count += 1;
      }
      continue;
    }
    if (filter != NULL &&
        (record.responsible_pid != filter->responsible_pid ||
         record.responsible_unique_id != filter->responsible_unique_id)) {
      /*
       * The stable record is now demonstrably outside the cohort.  A matching
       * preflight followed by this mismatch means the original PID exited or
       * disclaimed while it was inspected; either way the current identity is
       * not an owned live target.
       */
      continue;
    }
    if (!append_record(&list, &record)) {
      free(list.records);
      list.records = NULL;
      list.count = 0;
      list.complete = false;
      list.inaccessible_count += 1;
      break;
    }
  }
  free(pids);
  return list;
}

static void free_process_list(struct process_list *list) {
  free(list->records);
  list->records = NULL;
  list->count = 0;
}

static const char *status_name(uint32_t status) {
  switch (status) {
  case SIDL:
    return "creating";
  case SRUN:
    return "runnable";
  case SSLEEP:
    return "sleeping";
  case SSTOP:
    return "stopped";
  case SZOMB:
    return "zombie";
  default:
    return "unknown";
  }
}

static void print_json_string(const char *value) {
  fputc('"', stdout);
  for (const unsigned char *cursor = (const unsigned char *)value;
       *cursor != '\0'; cursor += 1) {
    unsigned char character = *cursor;
    switch (character) {
    case '"':
      fputs("\\\"", stdout);
      break;
    case '\\':
      fputs("\\\\", stdout);
      break;
    case '\b':
      fputs("\\b", stdout);
      break;
    case '\f':
      fputs("\\f", stdout);
      break;
    case '\n':
      fputs("\\n", stdout);
      break;
    case '\r':
      fputs("\\r", stdout);
      break;
    case '\t':
      fputs("\\t", stdout);
      break;
    default:
      if (character < 0x20U) {
        fprintf(stdout, "\\u%04x", (unsigned int)character);
      } else {
        fputc((int)character, stdout);
      }
      break;
    }
  }
  fputc('"', stdout);
}

static int inventory_mode(int argc, char **argv) {
  bool has_filter = false;
  struct responsibility_anchor filter;
  memset(&filter, 0, sizeof(filter));
  if (argc == 6 && strcmp(argv[2], "--responsible-pid") == 0 &&
      strcmp(argv[4], "--responsible-unique-id") == 0) {
    char *pid_end = NULL;
    char *unique_end = NULL;
    errno = 0;
    long parsed_pid = strtol(argv[3], &pid_end, 10);
    unsigned long long parsed_unique_id = strtoull(argv[5], &unique_end, 10);
    if (errno != 0 || pid_end == argv[3] || *pid_end != '\0' ||
        unique_end == argv[5] || *unique_end != '\0' || parsed_pid <= 0 ||
        parsed_pid > INT_MAX || parsed_unique_id == 0) {
      fprintf(stderr, "invalid responsible identity\n");
      return NEXUS_EXIT_USAGE;
    }
    filter.responsible_pid = (pid_t)parsed_pid;
    filter.responsible_unique_id = (uint64_t)parsed_unique_id;
    has_filter = true;
  } else if (argc != 2) {
    fprintf(stderr,
            "usage: %s inventory [--responsible-pid <pid> "
            "--responsible-unique-id <uint64>]\n",
            argv[0]);
    return NEXUS_EXIT_USAGE;
  }

  struct responsibility_api api;
  memset(&api, 0, sizeof(api));
  if (!load_responsibility_api(&api, false)) {
    fputs("{\"schemaVersion\":1,\"complete\":false,"
          "\"error\":\"private-responsibility-api-unavailable\","
          "\"processes\":[]}\n",
          stdout);
    return NEXUS_EXIT_PRIVATE_API;
  }
  if (!responsibility_api_self_test(&api)) {
    fputs("{\"schemaVersion\":1,\"complete\":false,"
          "\"error\":\"private-responsibility-api-self-test-failed\","
          "\"processes\":[]}\n",
          stdout);
    return NEXUS_EXIT_PRIVATE_API;
  }
  if (has_filter) {
    struct process_record responsible;
    bool disappeared = false;
    if (!load_process_record(&api, filter.responsible_pid, &responsible,
                             &disappeared) ||
        responsible.responsible_pid != filter.responsible_pid ||
        responsible.responsible_unique_id != filter.responsible_unique_id) {
      fputs("{\"schemaVersion\":1,\"complete\":false,"
            "\"error\":\"responsibility-anchor-unavailable\","
            "\"processes\":[]}\n",
            stdout);
      return NEXUS_EXIT_INVENTORY;
    }
    filter.pid = responsible.pid;
    filter.start_seconds = responsible.start_seconds;
    filter.start_microseconds = responsible.start_microseconds;
    filter.process_unique_id = responsible.process_unique_id;
    filter.process_id_version = responsible.process_id_version;
  }

  struct process_list list =
      inventory_processes(&api, has_filter ? &filter : NULL);
  fprintf(stdout,
          "{\"schemaVersion\":%d,\"complete\":%s,"
          "\"inaccessibleCount\":%u,\"processes\":[",
          INVENTORY_SCHEMA_VERSION, list.complete ? "true" : "false",
          list.inaccessible_count);
  for (size_t index = 0; index < list.count; index += 1) {
    const struct process_record *record = &list.records[index];
    if (index > 0) {
      fputc(',', stdout);
    }
    fprintf(stdout,
            "{\"pid\":%d,\"ppid\":%d,\"pgid\":%d,"
            "\"startTime\":{\"seconds\":\"%llu\",\"microseconds\":%llu},"
            "\"status\":{\"code\":%u,\"name\":",
            record->pid, record->ppid, record->pgid,
            (unsigned long long)record->start_seconds,
            (unsigned long long)record->start_microseconds, record->status);
    print_json_string(status_name(record->status));
    fputs("},\"name\":", stdout);
    print_json_string(record->name);
    fprintf(stdout,
            ",\"processUniqueId\":\"%llu\",\"responsiblePid\":%d,"
            "\"processIdVersion\":%d,\"responsibleUniqueId\":\"%llu\"}",
            (unsigned long long)record->process_unique_id,
            record->responsible_pid, record->process_id_version,
            (unsigned long long)record->responsible_unique_id);
  }
  fputs("]}\n", stdout);
  bool complete = list.complete;
  free_process_list(&list);
  return complete ? 0 : NEXUS_EXIT_INVENTORY;
}

/*
 * Zero-effect provider used only by the packaged PTY smoke. The outer helper
 * still trace-execs and authenticates this exact Team-signed Mach-O before the
 * mode can emit its receipt, so a successful probe proves the production
 * supervise-authenticated path without assigning synthetic trust to a system
 * utility.
 */
static int provider_probe_mode(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s provider-probe\n", argv[0]);
    return NEXUS_EXIT_USAGE;
  }
  fputs(NEXUS_PROVIDER_PROBE_RECEIPT "\n", stdout);
  return 0;
}

static bool is_ascii_alphanumeric(char value) {
  return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
         (value >= '0' && value <= '9');
}

static bool valid_signing_identifier(const char *value) {
  size_t length = strnlen(value, 256);
  if (length == 0 || length >= 256 || !is_ascii_alphanumeric(value[0])) {
    return false;
  }
  for (size_t index = 1; index < length; index += 1) {
    char character = value[index];
    if (!is_ascii_alphanumeric(character) && character != '.' &&
        character != '-' && character != '_') {
      return false;
    }
  }
  return true;
}

static bool valid_team_identifier(const char *value) {
  size_t length = strnlen(value, 11);
  if (length != 10) {
    return false;
  }
  for (size_t index = 0; index < length; index += 1) {
    char character = value[index];
    if (!((character >= 'A' && character <= 'Z') ||
          (character >= '0' && character <= '9'))) {
      return false;
    }
  }
  return true;
}

static int hex_nibble(char value) {
  if (value >= '0' && value <= '9') {
    return value - '0';
  }
  if (value >= 'a' && value <= 'f') {
    return value - 'a' + 10;
  }
  if (value >= 'A' && value <= 'F') {
    return value - 'A' + 10;
  }
  return -1;
}

static bool parse_cdhash(const char *value,
                         uint8_t output[CDHASH_BYTE_LENGTH]) {
  if (strnlen(value, CDHASH_HEX_LENGTH + 1) != CDHASH_HEX_LENGTH) {
    return false;
  }
  for (size_t index = 0; index < CDHASH_BYTE_LENGTH; index += 1) {
    int high = hex_nibble(value[index * 2]);
    int low = hex_nibble(value[(index * 2) + 1]);
    if (high < 0 || low < 0) {
      return false;
    }
    output[index] = (uint8_t)((high << 4) | low);
  }
  return true;
}

static bool parse_sealed_invocation(int argc, char **argv,
                                    struct sealed_code_identity *identity,
                                    int *command_index) {
  if (argc < 10 || strcmp(argv[2], "--identifier") != 0 ||
      strcmp(argv[4], "--team-id") != 0 || strcmp(argv[6], "--cdhash") != 0 ||
      strcmp(argv[8], "--") != 0 || argv[9][0] != '/' ||
      !valid_signing_identifier(argv[3]) || !valid_team_identifier(argv[5])) {
    return false;
  }
  memset(identity, 0, sizeof(*identity));
  identity->identifier = argv[3];
  identity->team_identifier = argv[5];
  identity->cdhash_hex = argv[7];
  if (!parse_cdhash(argv[7], identity->cdhash)) {
    return false;
  }
  *command_index = 9;
  return true;
}

static int executable_path(char output[PATH_MAX]) {
  uint32_t buffer_size = PATH_MAX;
  if (_NSGetExecutablePath(output, &buffer_size) != 0) {
    return ENAMETOOLONG;
  }
  char resolved[PATH_MAX];
  if (realpath(output, resolved) == NULL) {
    return errno;
  }
  size_t length = strnlen(resolved, sizeof(resolved));
  if (length == 0 || length >= PATH_MAX) {
    return ENAMETOOLONG;
  }
  memcpy(output, resolved, length + 1);
  return 0;
}

static int bootstrap_disclaimed_supervisor_mode(int argc, char **argv,
                                                const char *internal_mode,
                                                int command_index) {
  if (argc <= command_index || argv[command_index][0] == '\0') {
    fputs("nexus-pty-supervisor: invalid bootstrap invocation\n", stderr);
    return NEXUS_EXIT_USAGE;
  }
  if (argv[command_index][0] != '/') {
    fputs("nexus-pty-supervisor: command must be an absolute path\n", stderr);
    return NEXUS_EXIT_USAGE;
  }

  struct responsibility_api api;
  memset(&api, 0, sizeof(api));
  if (!load_responsibility_api(&api, true)) {
    fputs("nexus-pty-supervisor: required private responsibility API is "
          "unavailable; refusing PTY spawn\n",
          stderr);
    return NEXUS_EXIT_PRIVATE_API;
  }
  if (!responsibility_api_self_test(&api)) {
    fputs("nexus-pty-supervisor: private responsibility API self-test "
          "failed; refusing PTY spawn\n",
          stderr);
    return NEXUS_EXIT_PRIVATE_API;
  }
  if (!consume_main_owned_launch_authorization(&api)) {
    fputs("nexus-pty-supervisor: launch authorization rejected before "
          "responsibility disclaim\n",
          stderr);
    return NEXUS_EXIT_CODE_IDENTITY;
  }
  /*
   * node-pty may request termination immediately after spawn returns. Keep
   * lifecycle signals pending across POSIX_SPAWN_SETEXEC; the disclaimed image
   * installs handlers before unblocking them. Authorization must be consumed
   * first so an untrusted caller never reaches the disclaim transition.
   */
  if (!block_supervisor_signals()) {
    perror("nexus-pty-supervisor: cannot block bootstrap signals");
    return NEXUS_EXIT_INTERNAL;
  }

  char self[PATH_MAX];
  int path_error = executable_path(self);
  if (path_error != 0) {
    fprintf(stderr, "nexus-pty-supervisor: cannot resolve executable: %s\n",
            strerror(path_error));
    return NEXUS_EXIT_INTERNAL;
  }

  size_t run_argc = (size_t)argc;
  char **run_argv = calloc(run_argc + 1, sizeof(*run_argv));
  if (run_argv == NULL) {
    fputs("nexus-pty-supervisor: cannot allocate bootstrap argv\n", stderr);
    return NEXUS_EXIT_INTERNAL;
  }
  run_argv[0] = self;
  run_argv[1] = (char *)internal_mode;
  for (int source = 2; source < argc; source += 1) {
    run_argv[source] = argv[source];
  }
  run_argv[run_argc] = NULL;

#if NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS > 0
  test_write_ready_pid("NEXUS_TEST_PRE_SELF_EXEC_READY", getpid());
  sleep_milliseconds(NEXUS_TEST_PRE_SELF_EXEC_HOLD_MS);
#endif

  posix_spawnattr_t attributes = NULL;
  int error = posix_spawnattr_init(&attributes);
  if (error == 0) {
    error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
  }
  if (error == 0) {
    error = api.set_disclaim(&attributes, 1);
  }
  if (error == 0) {
    pid_t replaced_pid = 0;
    error =
        posix_spawn(&replaced_pid, self, NULL, &attributes, run_argv, environ);
  }
  if (attributes != NULL) {
    posix_spawnattr_destroy(&attributes);
  }
  free(run_argv);
  fprintf(stderr,
          "nexus-pty-supervisor: signed responsibility bootstrap failed: %s\n",
          strerror(error));
  return NEXUS_EXIT_DISCLAIM;
}

static int bootstrap_disclaimed_supervisor(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") != 0 || argv[3][0] != '/') {
    fprintf(stderr, "usage: %s supervise -- <absolute-command> [args...]\n",
            argv[0]);
    return NEXUS_EXIT_USAGE;
  }
  return bootstrap_disclaimed_supervisor_mode(argc, argv, "__run-disclaimed",
                                              3);
}

static int bootstrap_authenticated_supervisor(int argc, char **argv) {
  struct sealed_code_identity identity;
  int command_index = 0;
  if (!parse_sealed_invocation(argc, argv, &identity, &command_index)) {
    fprintf(stderr,
            "usage: %s supervise-authenticated --identifier <id> "
            "--team-id <team> --cdhash <40hex> -- "
            "<absolute-command> [args...]\n",
            argv[0]);
    return NEXUS_EXIT_USAGE;
  }
  return bootstrap_disclaimed_supervisor_mode(
      argc, argv, "__run-disclaimed-authenticated", command_index);
}

static bool install_signal_handlers(void) {
  struct sigaction shutdown_action;
  memset(&shutdown_action, 0, sizeof(shutdown_action));
  shutdown_action.sa_handler = capture_shutdown_signal;
  sigemptyset(&shutdown_action.sa_mask);
  if (sigaction(SIGTERM, &shutdown_action, NULL) != 0 ||
      sigaction(SIGHUP, &shutdown_action, NULL) != 0) {
    return false;
  }
  struct sigaction terminal_action;
  memset(&terminal_action, 0, sizeof(terminal_action));
  terminal_action.sa_handler = preserve_terminal_signal_for_child;
  sigemptyset(&terminal_action.sa_mask);
  if (sigaction(SIGINT, &terminal_action, NULL) != 0 ||
      sigaction(SIGQUIT, &terminal_action, NULL) != 0) {
    return false;
  }
  struct sigaction ignore_pipe;
  memset(&ignore_pipe, 0, sizeof(ignore_pipe));
  ignore_pipe.sa_handler = SIG_IGN;
  sigemptyset(&ignore_pipe.sa_mask);
  if (sigaction(SIGPIPE, &ignore_pipe, NULL) != 0) {
    return false;
  }
  sigset_t supervisor_signals;
  return supervisor_signal_set(&supervisor_signals) &&
         sigprocmask(SIG_UNBLOCK, &supervisor_signals, NULL) == 0;
}

static bool record_is_live_target(const struct process_record *record,
                                  pid_t supervisor_pid) {
  return record->pid != supervisor_pid && record->status != SZOMB;
}

static bool
capture_responsibility_anchor(const struct responsibility_api *api,
                              struct responsibility_anchor *anchor) {
  struct process_record self;
  bool disappeared = false;
  if (!load_process_record(api, getpid(), &self, &disappeared)) {
    return false;
  }
  if (self.pid != getpid() || self.process_unique_id == 0 ||
      self.responsible_pid != self.pid || self.responsible_unique_id == 0) {
    return false;
  }
  anchor->pid = self.pid;
  anchor->start_seconds = self.start_seconds;
  anchor->start_microseconds = self.start_microseconds;
  anchor->process_unique_id = self.process_unique_id;
  anchor->process_id_version = self.process_id_version;
  anchor->responsible_pid = self.responsible_pid;
  anchor->responsible_unique_id = self.responsible_unique_id;
  return true;
}

static bool
responsibility_anchor_alive(const struct responsibility_api *api,
                            const struct responsibility_anchor *anchor) {
  struct process_record current;
  bool disappeared = false;
  if (!load_process_record(api, anchor->pid, &current, &disappeared)) {
    return false;
  }
  return current.pid == anchor->pid &&
         current.process_unique_id == anchor->process_unique_id &&
         current.process_id_version == anchor->process_id_version &&
         current.responsible_pid == anchor->responsible_pid &&
         current.responsible_unique_id == anchor->responsible_unique_id &&
         current.status != SZOMB;
}

static struct process_list
inventory_owned_processes(const struct responsibility_api *api,
                          const struct responsibility_anchor *anchor) {
  bool anchor_before = responsibility_anchor_alive(api, anchor);
  struct process_list list = inventory_processes(api, anchor);
  bool anchor_after = responsibility_anchor_alive(api, anchor);
  if (!anchor_before || !anchor_after) {
    list.complete = false;
    list.inaccessible_count += 1;
  }
  return list;
}

/*
 * Signal only after re-reading the responsibility identity.  This closes the
 * PID-reuse window between inventory and signalling.  proc_signal_with_
 * audittoken makes the kernel compare the PID version atomically with signal
 * delivery; kill(2) is deliberately not used for destructive signals.
 */
static bool signal_if_still_owned(const struct responsibility_api *api,
                                  const struct process_record *record,
                                  const struct responsibility_anchor *anchor,
                                  int signal_number) {
  struct process_record current;
  bool disappeared = false;
  if (!load_process_record(api, record->pid, &current, &disappeared)) {
    return !process_still_exists(record->pid);
  }
  if (current.process_unique_id != record->process_unique_id ||
      current.process_id_version != record->process_id_version ||
      current.responsible_pid != anchor->responsible_pid ||
      current.responsible_unique_id != anchor->responsible_unique_id) {
    return true;
  }
  audit_token_t token;
  memset(&token, 0, sizeof(token));
  token.val[5] = (uint32_t)current.pid;
  token.val[7] = (uint32_t)current.process_id_version;
  int signal_error = proc_signal_with_audittoken(&token, signal_number);
  if (signal_error != 0 && signal_error != ESRCH) {
    return false;
  }
  return true;
}

static size_t live_target_count(const struct process_list *list,
                                pid_t supervisor_pid) {
  size_t count = 0;
  for (size_t index = 0; index < list->count; index += 1) {
    if (record_is_live_target(&list->records[index], supervisor_pid)) {
      count += 1;
    }
  }
  return count;
}

static bool all_live_targets_stopped(const struct process_list *list,
                                     pid_t supervisor_pid) {
  for (size_t index = 0; index < list->count; index += 1) {
    const struct process_record *record = &list->records[index];
    if (record_is_live_target(record, supervisor_pid) &&
        record->status != SSTOP) {
      return false;
    }
  }
  return true;
}

static bool same_live_identity_set(const struct process_list *left,
                                   const struct process_list *right,
                                   pid_t supervisor_pid) {
  if (live_target_count(left, supervisor_pid) !=
      live_target_count(right, supervisor_pid)) {
    return false;
  }
  for (size_t left_index = 0; left_index < left->count; left_index += 1) {
    const struct process_record *candidate = &left->records[left_index];
    if (!record_is_live_target(candidate, supervisor_pid)) {
      continue;
    }
    bool found = false;
    for (size_t right_index = 0; right_index < right->count; right_index += 1) {
      const struct process_record *observed = &right->records[right_index];
      if (record_is_live_target(observed, supervisor_pid) &&
          candidate->process_unique_id == observed->process_unique_id &&
          candidate->process_id_version == observed->process_id_version) {
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

static bool signal_live_targets(const struct responsibility_api *api,
                                struct process_list *list,
                                const struct responsibility_anchor *anchor,
                                int signal_number) {
  bool complete = list->complete;
  for (size_t index = 0; index < list->count; index += 1) {
    const struct process_record *record = &list->records[index];
    if (!record_is_live_target(record, anchor->pid)) {
      continue;
    }
    if (!signal_if_still_owned(api, record, anchor, signal_number)) {
      complete = false;
    }
  }
  return complete;
}

/*
 * The supervised CLI is our direct child.  During signal-driven teardown it
 * can exit between two responsibility scans and remain visible as a zombie
 * until waitpid runs.  Reap it inside the proof loop: descendants retain the
 * supervisor's responsibility identity, while the dead child can no longer
 * create work and must not make every inventory permanently incomplete.
 */
static void reap_child_if_exited(pid_t child, int *child_status,
                                 bool *child_reaped) {
  if (*child_reaped) {
    return;
  }
  for (;;) {
    pid_t waited = waitpid(child, child_status, WNOHANG);
    if (waited == child) {
      *child_reaped = true;
      return;
    }
    if (waited == 0) {
      return;
    }
    if (waited < 0 && errno == EINTR) {
      continue;
    }
    if (waited < 0 && errno == ECHILD) {
      *child_status = NEXUS_EXIT_INTERNAL << 8;
      *child_reaped = true;
    }
    return;
  }
}

static bool
prove_group_empty_twice(const struct responsibility_api *api,
                        const struct responsibility_anchor *anchor) {
  struct process_list first = inventory_owned_processes(api, anchor);
  bool first_empty =
      first.complete && live_target_count(&first, anchor->pid) == 0;
  free_process_list(&first);
  if (!first_empty) {
    return false;
  }
  sleep_milliseconds(ABSENCE_CONFIRM_DELAY_MS);
  struct process_list second = inventory_owned_processes(api, anchor);
  bool second_empty =
      second.complete && live_target_count(&second, anchor->pid) == 0;
  free_process_list(&second);
  return second_empty;
}

static struct process_list
stop_group_to_fixed_point(const struct responsibility_api *api,
                          const struct responsibility_anchor *anchor,
                          pid_t child, int *child_status, bool *child_reaped) {
  struct process_list previous = {
      .records = NULL,
      .count = 0,
      .complete = false,
      .inaccessible_count = 0,
  };
  for (;;) {
    reap_child_if_exited(child, child_status, child_reaped);
    struct process_list current = inventory_owned_processes(api, anchor);
    bool stopped = all_live_targets_stopped(&current, anchor->pid);
    bool fixed = current.complete && previous.complete && stopped &&
                 all_live_targets_stopped(&previous, anchor->pid) &&
                 same_live_identity_set(&previous, &current, anchor->pid);
    if (fixed) {
      free_process_list(&previous);
      return current;
    }
    (void)signal_live_targets(api, &current, anchor, SIGSTOP);
    free_process_list(&previous);
    previous = current;
    sleep_milliseconds(LOOP_DELAY_MS);
  }
}

/*
 * No timeout permits the supervisor to exit without proof.  Cooperative CLIs
 * first receive a bounded SIGTERM grace period.  Escalation freezes the exact
 * (responsible PID, responsible unique ID) cohort to a two-scan fixed point,
 * then sends SIGKILL through audit tokens.  The live anchor plus two complete,
 * separated empty scans are the release proof.
 */
static void terminate_and_prove_responsibility_group(
    const struct responsibility_api *api,
    const struct responsibility_anchor *anchor, pid_t child, int *child_status,
    bool *child_reaped) {
  uint64_t term_deadline = monotonic_milliseconds() + TERM_GRACE_MS;
  unsigned int incomplete_reports = 0;

  while (monotonic_milliseconds() < term_deadline) {
    reap_child_if_exited(child, child_status, child_reaped);
    if (prove_group_empty_twice(api, anchor)) {
      return;
    }
    struct process_list list = inventory_owned_processes(api, anchor);
    bool complete = signal_live_targets(api, &list, anchor, SIGTERM);
    if (!complete) {
      incomplete_reports += 1;
      if (incomplete_reports == 1 || incomplete_reports % 250U == 0) {
        fputs("nexus-pty-supervisor: responsibility inventory incomplete; "
              "remaining alive fail-closed\n",
              stderr);
      }
    }
    free_process_list(&list);
    sleep_milliseconds(LOOP_DELAY_MS);
  }

  for (;;) {
    reap_child_if_exited(child, child_status, child_reaped);
    if (prove_group_empty_twice(api, anchor)) {
      return;
    }
    struct process_list frozen = stop_group_to_fixed_point(
        api, anchor, child, child_status, child_reaped);
    (void)signal_live_targets(api, &frozen, anchor, SIGKILL);
    free_process_list(&frozen);
    sleep_milliseconds(LOOP_DELAY_MS);
  }
}

static bool
validate_child_responsibility(const struct responsibility_api *api, pid_t child,
                              pid_t expected_responsible_pid,
                              uint64_t expected_responsible_unique_id) {
  for (unsigned int attempt = 0; attempt < 100U; attempt += 1) {
    pid_t responsible_pid = 0;
    uint64_t responsible_unique_id = 0;
    if (query_responsibility(api, child, &responsible_pid,
                             &responsible_unique_id)) {
      return responsible_pid == expected_responsible_pid &&
             responsible_unique_id == expected_responsible_unique_id;
    }
    if (!process_still_exists(child)) {
      return true;
    }
    sleep_milliseconds(5);
  }
  return false;
}

static bool
child_is_stopped_and_owned(const struct responsibility_api *api, pid_t child,
                           const struct responsibility_anchor *anchor) {
  struct process_record record;
  bool disappeared = false;
  if (!load_process_record(api, child, &record, &disappeared)) {
    return false;
  }
  return record.pid == child && record.status == SSTOP &&
         record.responsible_pid == anchor->responsible_pid &&
         record.responsible_unique_id == anchor->responsible_unique_id;
}

static bool cf_string_matches(CFTypeRef value, const char *expected) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) {
    return false;
  }
  CFStringRef expected_string = CFStringCreateWithCString(
      kCFAllocatorDefault, expected, kCFStringEncodingUTF8);
  if (expected_string == NULL) {
    return false;
  }
  bool matches = CFStringCompare((CFStringRef)value, expected_string, 0) ==
                 kCFCompareEqualTo;
  CFRelease(expected_string);
  return matches;
}

static CFDictionaryRef copy_live_signing_information(pid_t pid) {
  int32_t pid_value = (int32_t)pid;
  CFNumberRef pid_number =
      CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pid_value);
  if (pid_number == NULL) {
    return NULL;
  }
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {pid_number};
  CFDictionaryRef attributes = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFRelease(pid_number);
  if (attributes == NULL) {
    return NULL;
  }

  SecCodeRef guest = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(
      NULL, attributes, kSecCSDefaultFlags, &guest);
  CFRelease(attributes);
  if (status != errSecSuccess || guest == NULL) {
    if (guest != NULL) {
      CFRelease(guest);
    }
    return NULL;
  }
  status = SecCodeCheckValidity(guest, kSecCSNoNetworkAccess, NULL);
  CFDictionaryRef information = NULL;
  if (status == errSecSuccess) {
    status = SecCodeCopySigningInformation(
        (SecStaticCodeRef)guest,
        kSecCSSigningInformation | kSecCSDynamicInformation, &information);
  }
  CFRelease(guest);
  if (status != errSecSuccess) {
    if (information != NULL) {
      CFRelease(information);
    }
    return NULL;
  }
  return information;
}

static CFDictionaryRef copy_static_signing_information(const char *path) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, (const UInt8 *)path, (CFIndex)strlen(path), false);
  if (url == NULL) {
    return NULL;
  }
  SecStaticCodeRef code = NULL;
  OSStatus status =
      SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  CFRelease(url);
  if (status != errSecSuccess || code == NULL) {
    if (code != NULL) {
      CFRelease(code);
    }
    return NULL;
  }
  status = SecStaticCodeCheckValidity(
      code, kSecCSCheckAllArchitectures | kSecCSNoNetworkAccess, NULL);
  CFDictionaryRef information = NULL;
  if (status == errSecSuccess) {
    status = SecCodeCopySigningInformation(
        code, kSecCSSigningInformation, &information);
  }
  CFRelease(code);
  if (status != errSecSuccess) {
    if (information != NULL) {
      CFRelease(information);
    }
    return NULL;
  }
  return information;
}

static bool signing_information_has_identity(CFDictionaryRef information,
                                             const char *identifier,
                                             const char *team_identifier) {
  if (information == NULL) {
    return false;
  }
  CFTypeRef observed_identifier =
      CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
  CFTypeRef observed_team =
      CFDictionaryGetValue(information, kSecCodeInfoTeamIdentifier);
  return cf_string_matches(observed_identifier, identifier) &&
         (team_identifier == NULL
              ? observed_team == NULL
              : cf_string_matches(observed_team, team_identifier));
}

static bool signing_information_has_same_cdhash(CFDictionaryRef left,
                                                CFDictionaryRef right) {
  if (left == NULL || right == NULL) {
    return false;
  }
  CFTypeRef left_unique = CFDictionaryGetValue(left, kSecCodeInfoUnique);
  CFTypeRef right_unique = CFDictionaryGetValue(right, kSecCodeInfoUnique);
  return left_unique != NULL && right_unique != NULL &&
         CFGetTypeID(left_unique) == CFDataGetTypeID() &&
         CFGetTypeID(right_unique) == CFDataGetTypeID() &&
         CFDataGetLength((CFDataRef)left_unique) == CDHASH_BYTE_LENGTH &&
         CFDataGetLength((CFDataRef)right_unique) == CDHASH_BYTE_LENGTH &&
         CFEqual(left_unique, right_unique);
}

static bool live_code_matches_static(pid_t pid, const char *static_path,
                                     const char *identifier,
                                     const char *team_identifier) {
  char resolved[PATH_MAX];
  if (realpath(static_path, resolved) == NULL ||
      strcmp(resolved, static_path) != 0) {
    return false;
  }
  CFDictionaryRef live = copy_live_signing_information(pid);
  CFDictionaryRef sealed = copy_static_signing_information(static_path);
  bool matches =
      signing_information_has_identity(live, identifier, team_identifier) &&
      signing_information_has_identity(sealed, identifier, team_identifier) &&
      signing_information_has_same_cdhash(live, sealed);
  if (live != NULL) {
    CFRelease(live);
  }
  if (sealed != NULL) {
    CFRelease(sealed);
  }
  return matches;
}

enum nexus_helper_signing_mode {
  NEXUS_HELPER_SIGNING_INVALID = 0,
  NEXUS_HELPER_SIGNING_ADHOC = 1,
  NEXUS_HELPER_SIGNING_PACKAGED = 2,
};

static enum nexus_helper_signing_mode current_helper_signing_mode(void) {
  CFDictionaryRef information = copy_live_signing_information(getpid());
  enum nexus_helper_signing_mode mode = NEXUS_HELPER_SIGNING_INVALID;
  if (signing_information_has_identity(information,
                                       NEXUS_SUPERVISOR_IDENTIFIER, NULL)) {
    mode = NEXUS_HELPER_SIGNING_ADHOC;
  } else if (signing_information_has_identity(
                 information, NEXUS_SUPERVISOR_IDENTIFIER,
                 NEXUS_TEAM_IDENTIFIER)) {
    mode = NEXUS_HELPER_SIGNING_PACKAGED;
  }
  if (information != NULL) {
    CFRelease(information);
  }
  return mode;
}

static bool derive_packaged_code_paths(char main_path[PATH_MAX],
                                       char utility_path[PATH_MAX]) {
  char self[PATH_MAX];
  if (executable_path(self) != 0) {
    return false;
  }
  size_t self_length = strlen(self);
  size_t suffix_length = strlen(NEXUS_PACKAGED_HELPER_SUFFIX);
  if (self_length <= suffix_length ||
      strcmp(self + self_length - suffix_length,
             NEXUS_PACKAGED_HELPER_SUFFIX) != 0) {
    return false;
  }
  size_t app_root_length = self_length - suffix_length;
  if (app_root_length + strlen(NEXUS_MAIN_EXECUTABLE_SUFFIX) >= PATH_MAX ||
      app_root_length + strlen(NEXUS_UTILITY_EXECUTABLE_SUFFIX) >= PATH_MAX) {
    return false;
  }
  memcpy(main_path, self, app_root_length);
  strcpy(main_path + app_root_length, NEXUS_MAIN_EXECUTABLE_SUFFIX);
  memcpy(utility_path, self, app_root_length);
  strcpy(utility_path + app_root_length, NEXUS_UTILITY_EXECUTABLE_SUFFIX);
  return true;
}

static bool load_stable_process_record(const struct responsibility_api *api,
                                       pid_t pid,
                                       struct process_record *record) {
  bool disappeared = false;
  return pid > 0 && load_process_record(api, pid, record, &disappeared) &&
         record->pid == pid && record->status != SZOMB;
}

static bool packaged_nexus_process_matches(
    const struct responsibility_api *api, pid_t pid, const char *main_path,
    const char *utility_path) {
  struct process_record process;
  if (!load_stable_process_record(api, pid, &process)) {
    return false;
  }
  if (live_code_matches_static(pid, main_path, NEXUS_APP_IDENTIFIER,
                               NEXUS_TEAM_IDENTIFIER)) {
    return true;
  }
  if (!live_code_matches_static(pid, utility_path,
                                NEXUS_UTILITY_HELPER_IDENTIFIER,
                                NEXUS_TEAM_IDENTIFIER)) {
    return false;
  }
  struct process_record parent;
  return load_stable_process_record(api, process.ppid, &parent) &&
         live_code_matches_static(parent.pid, main_path, NEXUS_APP_IDENTIFIER,
                                  NEXUS_TEAM_IDENTIFIER);
}

static bool direct_parent_is_apple_perl(
    const struct responsibility_api *api, struct process_record *parent) {
  if (!load_stable_process_record(api, getppid(), parent)) {
    return false;
  }
  return live_code_matches_static(parent->pid, "/usr/bin/perl",
                                  "com.apple.perl", NULL);
}

/*
 * The pre-disclaim responsibility is the one-shot launch capability. It is
 * inherited through node-pty and Apple's traced Perl stage, then consumed when
 * this helper becomes a new responsibility root. The provider is born only
 * afterwards and can inherit only the new helper-owned responsibility.
 */
static bool consume_main_owned_launch_authorization(
    const struct responsibility_api *api) {
  struct process_record self;
  if (!load_stable_process_record(api, getpid(), &self) ||
      self.responsible_pid <= 0 || self.responsible_pid == self.pid) {
    return false;
  }

  struct process_record responsible_record;
  if (!load_stable_process_record(api, self.responsible_pid,
                                  &responsible_record) ||
      responsible_record.process_unique_id != self.responsible_unique_id ||
      responsible_record.responsible_pid != responsible_record.pid ||
      responsible_record.responsible_unique_id !=
          self.responsible_unique_id) {
    return false;
  }
  CFDictionaryRef responsible =
      copy_live_signing_information(responsible_record.pid);
  bool responsible_is_supervisor = signing_information_has_identity(
      responsible, NEXUS_SUPERVISOR_IDENTIFIER, NULL) ||
                                   signing_information_has_identity(
                                       responsible,
                                       NEXUS_SUPERVISOR_IDENTIFIER,
                                       NEXUS_TEAM_IDENTIFIER);
  if (responsible != NULL) {
    CFRelease(responsible);
  }
  if (responsible_is_supervisor) {
    return false;
  }

  enum nexus_helper_signing_mode mode = current_helper_signing_mode();
  if (mode == NEXUS_HELPER_SIGNING_INVALID) {
    return false;
  }

  struct process_record stage_zero;
  bool has_apple_stage_zero = direct_parent_is_apple_perl(api, &stage_zero);
  if (mode == NEXUS_HELPER_SIGNING_ADHOC) {
    /*
     * Local builds are ad-hoc signed and cannot carry the release Team chain.
     * Their sole exception is bounded by that absent Team ID; the supervisor
     * responsibility rejection above still makes the capability one-shot.
     */
    return true;
  }

  char main_path[PATH_MAX];
  char utility_path[PATH_MAX];
  if (!has_apple_stage_zero ||
      !derive_packaged_code_paths(main_path, utility_path) ||
      !packaged_nexus_process_matches(api, stage_zero.ppid, main_path,
                                      utility_path) ||
      !packaged_nexus_process_matches(api, self.responsible_pid, main_path,
                                      utility_path)) {
    return false;
  }
  return true;
}

static bool
signing_information_matches(CFDictionaryRef information,
                            const struct sealed_code_identity *expected) {
  if (information == NULL) {
    return false;
  }
  CFTypeRef identifier =
      CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
  CFTypeRef team =
      CFDictionaryGetValue(information, kSecCodeInfoTeamIdentifier);
  CFTypeRef unique = CFDictionaryGetValue(information, kSecCodeInfoUnique);
  return cf_string_matches(identifier, expected->identifier) &&
         cf_string_matches(team, expected->team_identifier) && unique != NULL &&
         CFGetTypeID(unique) == CFDataGetTypeID() &&
         CFDataGetLength((CFDataRef)unique) == CDHASH_BYTE_LENGTH &&
         memcmp(CFDataGetBytePtr((CFDataRef)unique), expected->cdhash,
                CDHASH_BYTE_LENGTH) == 0;
}

static SecRequirementRef
create_exact_code_requirement(const struct sealed_code_identity *expected) {
  CFStringRef identifier = CFStringCreateWithCString(
      kCFAllocatorDefault, expected->identifier, kCFStringEncodingUTF8);
  CFStringRef team = CFStringCreateWithCString(
      kCFAllocatorDefault, expected->team_identifier, kCFStringEncodingUTF8);
  CFStringRef cdhash = CFStringCreateWithCString(
      kCFAllocatorDefault, expected->cdhash_hex, kCFStringEncodingASCII);
  if (identifier == NULL || team == NULL || cdhash == NULL) {
    if (identifier != NULL) {
      CFRelease(identifier);
    }
    if (team != NULL) {
      CFRelease(team);
    }
    if (cdhash != NULL) {
      CFRelease(cdhash);
    }
    return NULL;
  }
  CFStringRef requirement_text = CFStringCreateWithFormat(
      kCFAllocatorDefault, NULL,
      CFSTR("identifier \"%@\" and anchor apple generic and "
            "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
            "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
            "certificate leaf[subject.OU] = \"%@\" and cdhash H\"%@\""),
      identifier, team, cdhash);
  CFRelease(identifier);
  CFRelease(team);
  CFRelease(cdhash);
  if (requirement_text == NULL) {
    return NULL;
  }
  SecRequirementRef requirement = NULL;
  OSStatus status = SecRequirementCreateWithString(
      requirement_text, kSecCSDefaultFlags, &requirement);
  CFRelease(requirement_text);
  if (status != errSecSuccess) {
    return NULL;
  }
  return requirement;
}

/*
 * The PID belongs to our unreaped, ptrace-stopped direct child, so it cannot
 * be reused while this lookup occurs. SecCodeCheckValidity on a dynamic
 * SecCodeRef validates the loaded guest and is explicitly secure against a
 * replacement of its filesystem source. We then independently compare the
 * live signing dictionary's identifier, Team ID, and per-architecture CDHash.
 */
static bool
validate_live_code_identity(pid_t child,
                            const struct sealed_code_identity *expected) {
  SecRequirementRef requirement = create_exact_code_requirement(expected);
  if (requirement == NULL) {
    fputs("nexus-pty-supervisor: cannot compile sealed code requirement\n",
          stderr);
    return false;
  }

  bool valid = false;
  OSStatus last_status = errSecCSNoSuchCode;
  for (unsigned int attempt = 0; attempt < CODE_IDENTITY_RETRY_COUNT;
       attempt += 1) {
    int32_t pid_value = (int32_t)child;
    CFNumberRef pid_number =
        CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pid_value);
    if (pid_number == NULL) {
      last_status = errSecAllocate;
      break;
    }
    const void *keys[] = {kSecGuestAttributePid};
    const void *values[] = {pid_number};
    CFDictionaryRef attributes = CFDictionaryCreate(
        kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    CFRelease(pid_number);
    if (attributes == NULL) {
      last_status = errSecAllocate;
      break;
    }

    SecCodeRef guest = NULL;
    last_status = SecCodeCopyGuestWithAttributes(NULL, attributes,
                                                 kSecCSDefaultFlags, &guest);
    CFRelease(attributes);
    if (last_status == errSecSuccess && guest != NULL) {
      last_status =
          SecCodeCheckValidity(guest, kSecCSNoNetworkAccess, requirement);
      if (last_status == errSecSuccess) {
        CFDictionaryRef information = NULL;
        last_status = SecCodeCopySigningInformation(
            (SecStaticCodeRef)guest,
            kSecCSSigningInformation | kSecCSDynamicInformation, &information);
        if (last_status == errSecSuccess &&
            signing_information_matches(information, expected)) {
          valid = true;
        } else if (last_status == errSecSuccess) {
          last_status = errSecCSReqFailed;
        }
        if (information != NULL) {
          CFRelease(information);
        }
      }
      CFRelease(guest);
      break;
    }
    if (guest != NULL) {
      CFRelease(guest);
    }
    if (!process_still_exists(child)) {
      break;
    }
    sleep_milliseconds(CODE_IDENTITY_RETRY_DELAY_MS);
  }
  CFRelease(requirement);
  if (!valid) {
    fprintf(stderr,
            "nexus-pty-supervisor: live code identity rejected "
            "(Security.framework status=%d)\n",
            (int)last_status);
  }
  return valid;
}

static void
reject_child_and_prove_absence(const struct responsibility_api *api,
                               const struct responsibility_anchor *anchor,
                               pid_t child) {
  if (ptrace(PT_KILL, child, NULL, 0) != 0 && errno != ESRCH) {
    if (kill(child, SIGKILL) != 0 && errno != ESRCH) {
      perror("nexus-pty-supervisor: cannot reject traced child");
    }
  }
  int rejected_status = 0;
  bool rejected_reaped = false;
  for (;;) {
    pid_t waited = waitpid(child, &rejected_status, 0);
    if (waited == child || (waited < 0 && errno == ECHILD)) {
      rejected_reaped = true;
      break;
    }
    if (waited < 0 && errno == EINTR) {
      continue;
    }
    break;
  }
  terminate_and_prove_responsibility_group(api, anchor, child, &rejected_status,
                                           &rejected_reaped);
  if (!rejected_reaped) {
    while (waitpid(child, &rejected_status, 0) < 0 && errno == EINTR) {
    }
  }
}

/*
 * POSIX_SPAWN_START_SUSPENDED is implemented as an ordinary task suspension
 * and a same-UID SIGCONT can undo it. A traced exec stop is owned by this
 * parent instead: SIGCONT may be queued, but cannot release the new image
 * before the tracer validates and detaches it.
 *
 * The child executes only this fixed, inherited code before execve. After
 * PT_TRACE_ME, the kernel stops the replacement image at SIGTRAP before its
 * first userspace instruction. The parent therefore validates the exact live
 * vnode selected by execve rather than trusting a previously checked path.
 */
static int spawn_traced_child(pid_t *child, const char *executable,
                              char *const child_argv[]) {
  pid_t spawned = fork();
  if (spawned < 0) {
    return errno;
  }
  if (spawned == 0) {
    struct sigaction defaults;
    memset(&defaults, 0, sizeof(defaults));
    defaults.sa_handler = SIG_DFL;
    sigemptyset(&defaults.sa_mask);
    for (int signal_number = 1; signal_number < NSIG; signal_number += 1) {
      if (signal_number != SIGKILL && signal_number != SIGSTOP) {
        (void)sigaction(signal_number, &defaults, NULL);
      }
    }
    sigset_t empty;
    if (sigemptyset(&empty) != 0 ||
        sigprocmask(SIG_SETMASK, &empty, NULL) != 0) {
      _exit(120);
    }
    if (ptrace(PT_TRACE_ME, 0, NULL, 0) != 0) {
      _exit(121);
    }
    execve(executable, child_argv, environ);
    _exit(122);
  }

  *child = spawned;
  int status = 0;
  for (;;) {
    pid_t waited = waitpid(spawned, &status, WUNTRACED);
    if (waited == spawned) {
      break;
    }
    if (waited < 0 && errno == EINTR) {
      if (shutdown_signal != 0) {
        (void)kill(spawned, SIGKILL);
      }
      continue;
    }
    return errno != 0 ? errno : ECHILD;
  }
  if (!WIFSTOPPED(status) || WSTOPSIG(status) != SIGTRAP) {
    if (!WIFEXITED(status) && !WIFSIGNALED(status)) {
      (void)kill(spawned, SIGKILL);
      while (waitpid(spawned, &status, 0) < 0 && errno == EINTR) {
      }
    }
    return ENOEXEC;
  }
  return 0;
}

static int detach_authenticated_child(pid_t child) {
  if (ptrace(PT_DETACH, child, (caddr_t)1, 0) == 0) {
    return 0;
  }
  return errno != 0 ? errno : EIO;
}

static bool restore_stage_zero_provider_path(void) {
  const char *provider_path = getenv("NEXUS_STAGE0_PROVIDER_PATH");
  if (provider_path == NULL) {
    return true;
  }
  if (setenv("PATH", provider_path, 1) != 0) {
    return false;
  }
  return unsetenv("NEXUS_STAGE0_PROVIDER_PATH") == 0;
}

static int spawn_unsealed_child(pid_t *child, const char *executable,
                                char *const child_argv[]) {
  posix_spawnattr_t attributes = NULL;
  int error = posix_spawnattr_init(&attributes);
  sigset_t defaults;
  sigset_t empty;
  if (error == 0 && (sigfillset(&defaults) != 0 || sigemptyset(&empty) != 0)) {
    error = errno != 0 ? errno : EINVAL;
  }
  short flags = POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK;
  if (error == 0) {
    error = posix_spawnattr_setflags(&attributes, flags);
  }
  if (error == 0) {
    error = posix_spawnattr_setsigdefault(&attributes, &defaults);
  }
  if (error == 0) {
    error = posix_spawnattr_setsigmask(&attributes, &empty);
  }
  if (error == 0) {
    error =
        posix_spawn(child, executable, NULL, &attributes, child_argv, environ);
  }
  if (attributes != NULL) {
    posix_spawnattr_destroy(&attributes);
  }
  return error;
}

static int status_to_exit_code(int status) {
  int exit_code = NEXUS_EXIT_INTERNAL;
  if (WIFEXITED(status)) {
    exit_code = WEXITSTATUS(status);
  } else if (WIFSIGNALED(status)) {
    exit_code = 128 + WTERMSIG(status);
  }
  /*
   * Stage zero uses 128+signal exclusively to identify a helper that died
   * before completing responsibility inventory. A provider may legitimately
   * return the same numeric status after the helper has proved absence, so
   * collapse only that ambiguous provider range to a dedicated proven status.
   */
  if (exit_code >= NEXUS_SIGNAL_EXIT_MIN &&
      exit_code <= NEXUS_SIGNAL_EXIT_MAX) {
    return NEXUS_EXIT_PROVEN_AMBIGUOUS_PROVIDER_STATUS;
  }
  return exit_code;
}

static int run_disclaimed_supervisor_mode(
    int argc, char **argv, int command_index,
    const struct sealed_code_identity *sealed_identity) {
  if (argc <= command_index || argv[command_index][0] != '/') {
    fputs("nexus-pty-supervisor: invalid internal supervisor invocation\n",
          stderr);
    return NEXUS_EXIT_USAGE;
  }

  struct responsibility_api api;
  memset(&api, 0, sizeof(api));
  if (!load_responsibility_api(&api, false)) {
    fputs("nexus-pty-supervisor: private responsibility inventory unavailable; "
          "refusing CLI spawn\n",
          stderr);
    return NEXUS_EXIT_PRIVATE_API;
  }
  if (!responsibility_api_self_test(&api)) {
    fputs("nexus-pty-supervisor: private responsibility API self-test failed; "
          "refusing CLI spawn\n",
          stderr);
    return NEXUS_EXIT_PRIVATE_API;
  }
  struct responsibility_anchor anchor;
  memset(&anchor, 0, sizeof(anchor));
  if (!capture_responsibility_anchor(&api, &anchor)) {
    fputs("nexus-pty-supervisor: helper is not its own signed responsible "
          "process; refusing CLI spawn\n",
          stderr);
    return NEXUS_EXIT_RESPONSIBILITY;
  }
  if (!install_signal_handlers()) {
    perror("nexus-pty-supervisor: sigaction");
    return NEXUS_EXIT_INTERNAL;
  }
  if (!restore_stage_zero_provider_path()) {
    perror("nexus-pty-supervisor: cannot restore provider PATH");
    return NEXUS_EXIT_INTERNAL;
  }

  pid_t child = 0;
  int spawn_error = sealed_identity == NULL
                        ? spawn_unsealed_child(&child, argv[command_index],
                                               &argv[command_index])
                        : spawn_traced_child(&child, argv[command_index],
                                             &argv[command_index]);
  if (spawn_error != 0) {
    fprintf(stderr, "nexus-pty-supervisor: cannot spawn %s: %s\n",
            argv[command_index], strerror(spawn_error));
    return NEXUS_EXIT_SPAWN;
  }
#if NEXUS_TEST_TRACED_AUTH_HOLD_MS > 0
  if (sealed_identity != NULL) {
    test_write_ready_pid("NEXUS_TEST_TRACED_AUTH_READY", child);
    sleep_milliseconds(NEXUS_TEST_TRACED_AUTH_HOLD_MS);
  }
#endif
  if (!validate_child_responsibility(&api, child, anchor.responsible_pid,
                                     anchor.responsible_unique_id)) {
    fputs("nexus-pty-supervisor: child did not inherit the sealed "
          "responsibility identity; terminating cohort\n",
          stderr);
    reject_child_and_prove_absence(&api, &anchor, child);
    return NEXUS_EXIT_RESPONSIBILITY;
  }
  if (sealed_identity != NULL) {
    if (!child_is_stopped_and_owned(&api, child, &anchor) ||
        !validate_live_code_identity(child, sealed_identity) ||
        !child_is_stopped_and_owned(&api, child, &anchor) ||
        shutdown_signal != 0) {
      fputs("nexus-pty-supervisor: traced child failed sealed launch; "
            "terminating cohort\n",
            stderr);
      reject_child_and_prove_absence(&api, &anchor, child);
      if (shutdown_signal != 0) {
        return 0;
      }
      return NEXUS_EXIT_CODE_IDENTITY;
    }
    int detach_error = detach_authenticated_child(child);
    if (detach_error != 0) {
      fprintf(stderr,
              "nexus-pty-supervisor: cannot detach authenticated child: %s\n",
              strerror(detach_error));
      reject_child_and_prove_absence(&api, &anchor, child);
      return NEXUS_EXIT_SPAWN;
    }
  }

  int child_status = 0;
  bool child_reaped = false;
  while (!child_reaped && shutdown_signal == 0) {
    pid_t waited = waitpid(child, &child_status, WNOHANG);
    if (waited == child) {
      child_reaped = true;
      break;
    }
    if (waited < 0 && errno != EINTR) {
      if (errno == ECHILD) {
        child_reaped = true;
        child_status = NEXUS_EXIT_INTERNAL << 8;
        break;
      }
      perror("nexus-pty-supervisor: waitpid");
      shutdown_signal = SIGTERM;
      break;
    }
    sleep_milliseconds(LOOP_DELAY_MS);
  }

  int requested_signal = (int)shutdown_signal;
#if NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS > 0
  if (requested_signal != 0) {
    test_write_ready_pid("NEXUS_TEST_PRE_TERMINATION_PROOF_READY", getpid());
    sleep_milliseconds(NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS);
  }
#endif
  terminate_and_prove_responsibility_group(&api, &anchor, child, &child_status,
                                           &child_reaped);
  if (!child_reaped) {
    while (waitpid(child, &child_status, 0) < 0 && errno == EINTR) {
    }
  }
  if (requested_signal != 0) {
    /*
     * The responsibility cohort was already terminated and proven absent.
     * Return the normal proof sentinel; stage zero keeps timeout semantics
     * separately and rejects a helper that actually died by signal.
     */
    return 0;
  }
  return status_to_exit_code(child_status);
}

static int run_disclaimed_supervisor(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") != 0 || argv[3][0] != '/') {
    fputs("nexus-pty-supervisor: invalid internal supervisor invocation\n",
          stderr);
    return NEXUS_EXIT_USAGE;
  }
  return run_disclaimed_supervisor_mode(argc, argv, 3, NULL);
}

static int run_disclaimed_authenticated_supervisor(int argc, char **argv) {
  struct sealed_code_identity identity;
  int command_index = 0;
  if (!parse_sealed_invocation(argc, argv, &identity, &command_index)) {
    fputs("nexus-pty-supervisor: invalid internal authenticated invocation\n",
          stderr);
    return NEXUS_EXIT_USAGE;
  }
  return run_disclaimed_supervisor_mode(argc, argv, command_index, &identity);
}

static void print_usage(const char *program) {
  fprintf(stderr,
          "usage:\n"
          "  %s supervise -- <absolute-command> [args...]\n"
          "  %s supervise-authenticated --identifier <id> "
          "--team-id <team> --cdhash <40hex> -- "
          "<absolute-command> [args...]\n"
          "  %s inventory [--responsible-unique-id <uint64>]\n"
          "  %s provider-probe\n",
          program, program, program, program);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "supervise") == 0) {
    return bootstrap_disclaimed_supervisor(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "supervise-authenticated") == 0) {
    return bootstrap_authenticated_supervisor(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "__run-disclaimed") == 0) {
    return run_disclaimed_supervisor(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "__run-disclaimed-authenticated") == 0) {
    return run_disclaimed_authenticated_supervisor(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "inventory") == 0) {
    return inventory_mode(argc, argv);
  }
  if (argc >= 2 && strcmp(argv[1], "provider-probe") == 0) {
    return provider_probe_mode(argc, argv);
  }
  print_usage(argv[0]);
  return NEXUS_EXIT_USAGE;
}
