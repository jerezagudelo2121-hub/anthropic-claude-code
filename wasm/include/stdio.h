#pragma once
#include <sys/types.h>
#include <stddef.h>
#include <stdarg.h>
typedef struct _FILE FILE;
#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
extern FILE *stdout, *stderr;
int printf(const char *fmt, ...);
int fprintf(FILE *f, const char *fmt, ...);
int vfprintf(FILE *f, const char *fmt, va_list ap);
int sprintf(char *buf, const char *fmt, ...);
int snprintf(char *buf, size_t n, const char *fmt, ...);
int vsnprintf(char *buf, size_t n, const char *fmt, va_list ap);
int vsprintf(char *buf, const char *fmt, va_list ap);
int puts(const char *s);
int sscanf(const char *s, const char *fmt, ...);
int fflush(FILE *f);
FILE *fopen(const char *path, const char *mode);
size_t fread(void *buf, size_t size, size_t n, FILE *f);
size_t fwrite(const void *buf, size_t size, size_t n, FILE *f);
int fseek(FILE *f, long off, int whence);
long ftell(FILE *f);
int fclose(FILE *f);
int feof(FILE *f);
int fgetc(FILE *f);
int vasprintf(char **out, const char *fmt, va_list ap);
int asprintf(char **out, const char *fmt, ...);
