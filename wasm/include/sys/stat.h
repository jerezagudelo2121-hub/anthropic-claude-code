#pragma once
#include <sys/types.h>
/* Mínimo para compilar: en el navegador no hay sistema de archivos real. */
struct stat { long long st_size; unsigned st_mode; long long st_mtime; };
#define S_IFMT  0170000
#define S_IFDIR 0040000
#define S_IFREG 0100000
#define S_ISDIR(m) (((m) & S_IFMT) == S_IFDIR)
#define S_ISREG(m) (((m) & S_IFMT) == S_IFREG)
int stat(const char *path, struct stat *st);
int mkdir(const char *path, unsigned mode);
