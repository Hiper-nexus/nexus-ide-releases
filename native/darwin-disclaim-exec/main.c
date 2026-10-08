/*
 * F-1011: lançador do smoke empacotado no macOS. Executa (POSIX_SPAWN_SETEXEC:
 * mesmo pid, mesmo stdio) o app com a responsabilidade renunciada, como o
 * LaunchServices faz quando o operador abre o app pelo Finder. Sem isso o app
 * herdava como "processo responsável" o node do gate, e o supervisor de PTY
 * recusava (corretamente) a autorização de lançamento do Main
 * (`responsible_not_packaged`, exit 76). Não muda nada no app nem no supervisor.
 */
#include <dlfcn.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') {
    fprintf(stderr, "usage: %s <absolute-command> [args...]\n", argv[0]);
    return 64;
  }
  int (*set_disclaim)(posix_spawnattr_t *, int) = NULL;
  void *symbol = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (symbol == NULL) {
    fputs("disclaim-exec: responsibility_spawnattrs_setdisclaim unavailable\n", stderr);
    return 69;
  }
  memcpy(&set_disclaim, &symbol, sizeof(set_disclaim));
  posix_spawnattr_t attributes;
  int error = posix_spawnattr_init(&attributes);
  if (error == 0) error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
  if (error == 0) error = set_disclaim(&attributes, 1);
  if (error == 0) error = posix_spawn(NULL, argv[1], NULL, &attributes, &argv[1], environ);
  fprintf(stderr, "disclaim-exec: exec of %s failed: %s\n", argv[1], strerror(error));
  return 71;
}
