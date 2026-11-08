#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check_version(const char *path, const char *prefix,
                          const char *expected) {
  void *library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!library) {
    fprintf(stderr, "Cannot load %s: %s\n", path, dlerror());
    exit(1);
  }

  unsigned int parts[3];
  const char *names[] = {"major", "minor", "micro"};
  for (size_t i = 0; i < 3; ++i) {
    char symbol[80];
    snprintf(symbol, sizeof(symbol), "%s_get_%s_version", prefix, names[i]);
    unsigned int (*get_version)(void) = dlsym(library, symbol);
    if (!get_version) {
      fprintf(stderr, "Missing %s in %s\n", symbol, path);
      exit(1);
    }
    parts[i] = get_version();
  }
  char actual[80];
  snprintf(actual, sizeof(actual), "%u.%u.%u", parts[0], parts[1], parts[2]);
  printf("%s: %s\n", path, actual);
  if (strcmp(actual, expected) != 0) {
    fprintf(stderr, "Expected %s, found %s\n", expected, actual);
    exit(1);
  }
  dlclose(library);
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "Usage: %s VERSION WEBKIT_LIBRARY JSC_LIBRARY\n", argv[0]);
    return 1;
  }
  check_version(argv[2], "webkit", argv[1]);
  check_version(argv[3], "jsc", argv[1]);
  return 0;
}
