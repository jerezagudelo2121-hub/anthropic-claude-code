/* Mínima biblioteca C para ejecutar gpSP como WebAssembly sin Emscripten.
 * Solo implementa lo que el núcleo necesita: memoria, cadenas, hora y lectura
 * de archivos que el JavaScript registra en memoria (ROM y BIOS). */

#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <streams/file_stream.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

IMPORT(js_log) void js_log(const char *msg, size_t len);
IMPORT(js_now_ms) double js_now_ms(void);
IMPORT(js_tz_offset_min) int js_tz_offset_min(void);

int errno;
FILE *stdout, *stderr;

/* ---------- Memoria: asignador con listas libres por tamaño ---------- */

extern unsigned char __heap_base;
static uintptr_t heap_top = 0, heap_end = 0;

typedef struct block { size_t size; struct block *next; } block;
#define HDR 16
#define NBINS 40
static block *bins[NBINS];

static int bin_of(size_t size) {
  int b = 0;
  size_t s = 16;
  while (s < size && b < NBINS - 1) { s <<= 1; b++; }
  return b;
}

static size_t bin_size(int b) { return (size_t)16 << b; }

void *malloc(size_t n) {
  if (n == 0) n = 1;
  int b = bin_of(n);
  size_t size = bin_size(b);
  if (bins[b]) {
    block *blk = bins[b];
    bins[b] = blk->next;
    return (char *)blk + HDR;
  }
  if (!heap_top) {
    heap_top = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
    heap_end = __builtin_wasm_memory_size(0) * 65536;
  }
  uintptr_t need = heap_top + HDR + size;
  if (need > heap_end) {
    size_t pages = (need - heap_end + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return NULL;
    heap_end += pages * 65536;
  }
  block *blk = (block *)heap_top;
  blk->size = size;
  heap_top = need;
  return (char *)blk + HDR;
}

void free(void *p) {
  if (!p) return;
  block *blk = (block *)((char *)p - HDR);
  int b = bin_of(blk->size);
  blk->next = bins[b];
  bins[b] = blk;
}

void *calloc(size_t a, size_t b) {
  size_t n = a * b;
  void *p = malloc(n);
  if (p) memset(p, 0, n);
  return p;
}

void *realloc(void *p, size_t n) {
  if (!p) return malloc(n);
  block *blk = (block *)((char *)p - HDR);
  if (n <= blk->size) return p;
  void *q = malloc(n);
  if (!q) return NULL;
  memcpy(q, p, blk->size);
  free(p);
  return q;
}

EXPORT(fe_malloc) void *fe_malloc(size_t n) { return malloc(n); }
EXPORT(fe_free) void fe_free(void *p) { free(p); }

/* ---------- Cadenas ---------- */

void *memcpy(void *d, const void *s, size_t n) { __builtin_memcpy(d, s, n); return d; }
void *memmove(void *d, const void *s, size_t n) { __builtin_memmove(d, s, n); return d; }
void *memset(void *d, int c, size_t n) { __builtin_memset(d, c, n); return d; }

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (size_t i = 0; i < n; i++)
    if (x[i] != y[i]) return x[i] - y[i];
  return 0;
}

void *memchr(const void *s, int c, size_t n) {
  const unsigned char *p = s;
  for (size_t i = 0; i < n; i++)
    if (p[i] == (unsigned char)c) return (void *)(p + i);
  return NULL;
}

size_t strlen(const char *s) { const char *p = s; while (*p) p++; return p - s; }

int strcmp(const char *a, const char *b) {
  while (*a && *a == *b) { a++; b++; }
  return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n) {
  for (; n; n--, a++, b++) {
    if (*a != *b) return (unsigned char)*a - (unsigned char)*b;
    if (!*a) return 0;
  }
  return 0;
}

int strcasecmp(const char *a, const char *b) {
  for (;; a++, b++) {
    int x = (*a >= 'A' && *a <= 'Z') ? *a + 32 : *a;
    int y = (*b >= 'A' && *b <= 'Z') ? *b + 32 : *b;
    if (x != y || !x) return x - y;
  }
}

int strncasecmp(const char *a, const char *b, size_t n) {
  for (; n; n--, a++, b++) {
    int x = (*a >= 'A' && *a <= 'Z') ? *a + 32 : *a;
    int y = (*b >= 'A' && *b <= 'Z') ? *b + 32 : *b;
    if (x != y || !x) return x - y;
  }
  return 0;
}

char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)); return r; }

char *strncpy(char *d, const char *s, size_t n) {
  size_t i = 0;
  for (; i < n && s[i]; i++) d[i] = s[i];
  for (; i < n; i++) d[i] = 0;
  return d;
}

char *strcat(char *d, const char *s) { strcpy(d + strlen(d), s); return d; }

char *strncat(char *d, const char *s, size_t n) {
  char *p = d + strlen(d);
  while (n-- && *s) *p++ = *s++;
  *p = 0;
  return d;
}

char *strchr(const char *s, int c) {
  for (;; s++) {
    if (*s == (char)c) return (char *)s;
    if (!*s) return NULL;
  }
}

char *strrchr(const char *s, int c) {
  const char *r = NULL;
  for (;; s++) {
    if (*s == (char)c) r = s;
    if (!*s) return (char *)r;
  }
}

char *strstr(const char *h, const char *n) {
  size_t l = strlen(n);
  if (!l) return (char *)h;
  for (; *h; h++)
    if (!strncmp(h, n, l)) return (char *)h;
  return NULL;
}

char *strdup(const char *s) {
  size_t n = strlen(s) + 1;
  char *p = malloc(n);
  if (p) memcpy(p, s, n);
  return p;
}

size_t strspn(const char *s, const char *a) {
  size_t n = 0;
  while (s[n] && strchr(a, s[n])) n++;
  return n;
}

size_t strcspn(const char *s, const char *r) {
  size_t n = 0;
  while (s[n] && !strchr(r, s[n])) n++;
  return n;
}

char *strtok_r(char *s, const char *d, char **save) {
  if (!s) s = *save;
  s += strspn(s, d);
  if (!*s) { *save = s; return NULL; }
  char *e = s + strcspn(s, d);
  if (*e) *e++ = 0;
  *save = e;
  return s;
}

static char *strtok_save;
char *strtok(char *s, const char *d) { return strtok_r(s, d, &strtok_save); }
char *strerror(int e) { (void)e; return "error"; }

unsigned long strtoul(const char *s, char **end, int base) {
  unsigned long v = 0;
  while (*s == ' ' || *s == '\t') s++;
  if ((base == 0 || base == 16) && s[0] == '0' && (s[1] | 32) == 'x') { s += 2; base = 16; }
  else if (base == 0 && s[0] == '0') base = 8;
  else if (base == 0) base = 10;
  for (;; s++) {
    int c = *s, d;
    if (c >= '0' && c <= '9') d = c - '0';
    else if ((c | 32) >= 'a' && (c | 32) <= 'z') d = (c | 32) - 'a' + 10;
    else break;
    if (d >= base) break;
    v = v * base + d;
  }
  if (end) *end = (char *)s;
  return v;
}

long strtol(const char *s, char **end, int base) {
  while (*s == ' ' || *s == '\t') s++;
  int neg = 0;
  if (*s == '-' || *s == '+') neg = (*s++ == '-');
  long v = (long)strtoul(s, end, base);
  return neg ? -v : v;
}

int atoi(const char *s) { return (int)strtol(s, NULL, 10); }
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }

static unsigned rand_state = 1;
void srand(unsigned s) { rand_state = s; }
int rand(void) { rand_state = rand_state * 1103515245 + 12345; return (rand_state >> 1) & RAND_MAX; }

char *getenv(const char *name) { (void)name; return NULL; }
void abort(void) { __builtin_trap(); }
void exit(int code) { (void)code; __builtin_trap(); }

void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *)) {
  /* Inserción: solo se usa con listas pequeñas. */
  unsigned char *b = base, tmp[256];
  if (sz > sizeof(tmp)) return;
  for (size_t i = 1; i < n; i++)
    for (size_t j = i; j > 0 && cmp(b + (j - 1) * sz, b + j * sz) > 0; j--) {
      memcpy(tmp, b + j * sz, sz);
      memcpy(b + j * sz, b + (j - 1) * sz, sz);
      memcpy(b + (j - 1) * sz, tmp, sz);
    }
}

int sscanf(const char *s, const char *fmt, ...) { (void)s; (void)fmt; return 0; }

/* ---------- printf: suficiente para los mensajes de registro ---------- */

static void out_char(char **p, size_t *left, size_t *total, char c) {
  if (*left > 1) { **p = c; (*p)++; (*left)--; }
  (*total)++;
}

int vsnprintf(char *buf, size_t n, const char *fmt, va_list ap) {
  char *p = buf;
  size_t left = n, total = 0;
  for (; *fmt; fmt++) {
    if (*fmt != '%') { out_char(&p, &left, &total, *fmt); continue; }
    fmt++;
    int zero = 0, width = 0, longs = 0;
    while (*fmt == '-' || *fmt == '+' || *fmt == ' ' || *fmt == '#') fmt++;
    if (*fmt == '0') { zero = 1; fmt++; }
    while (*fmt >= '0' && *fmt <= '9') width = width * 10 + (*fmt++ - '0');
    if (*fmt == '.') { fmt++; while (*fmt >= '0' && *fmt <= '9') fmt++; }
    while (*fmt == 'l' || *fmt == 'h' || *fmt == 'z') { if (*fmt == 'l' || *fmt == 'z') longs++; fmt++; }
    char tmp[32];
    const char *str = tmp;
    int len = 0;
    switch (*fmt) {
    case 's': str = va_arg(ap, const char *); if (!str) str = "(null)"; len = (int)strlen(str); break;
    case 'c': tmp[0] = (char)va_arg(ap, int); len = 1; break;
    case 'd': case 'i': case 'u': case 'x': case 'X': case 'p': {
      unsigned long long v;
      int neg = 0, base = (*fmt == 'x' || *fmt == 'X' || *fmt == 'p') ? 16 : 10;
      if (*fmt == 'p') v = (uintptr_t)va_arg(ap, void *);
      else if (*fmt == 'd' || *fmt == 'i') {
        long long sv = longs >= 2 ? va_arg(ap, long long) : longs ? va_arg(ap, long) : va_arg(ap, int);
        if (sv < 0) { neg = 1; v = (unsigned long long)-sv; } else v = sv;
      } else v = longs >= 2 ? va_arg(ap, unsigned long long) : longs ? va_arg(ap, unsigned long) : va_arg(ap, unsigned);
      char rev[24];
      int r = 0;
      do { int d = (int)(v % base); rev[r++] = d < 10 ? '0' + d : (*fmt == 'X' ? 'A' : 'a') + d - 10; v /= base; } while (v);
      if (neg) tmp[len++] = '-';
      while (r) tmp[len++] = rev[--r];
      break;
    }
    case 'f': case 'g': case 'e': (void)va_arg(ap, double); tmp[0] = '?'; len = 1; break;
    case '%': tmp[0] = '%'; len = 1; break;
    default: tmp[0] = '?'; len = 1; break;
    }
    for (int i = len; i < width; i++) out_char(&p, &left, &total, zero ? '0' : ' ');
    for (int i = 0; i < len; i++) out_char(&p, &left, &total, str[i]);
  }
  if (n) *p = 0;
  return (int)total;
}

int snprintf(char *buf, size_t n, const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  int r = vsnprintf(buf, n, fmt, ap);
  va_end(ap);
  return r;
}

int vsprintf(char *buf, const char *fmt, va_list ap) { return vsnprintf(buf, 1 << 20, fmt, ap); }

int sprintf(char *buf, const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  int r = vsprintf(buf, fmt, ap);
  va_end(ap);
  return r;
}

int vfprintf(FILE *f, const char *fmt, va_list ap) {
  (void)f;
  char buf[512];
  int r = vsnprintf(buf, sizeof(buf), fmt, ap);
  js_log(buf, strlen(buf));
  return r;
}

int printf(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  int r = vfprintf(stdout, fmt, ap);
  va_end(ap);
  return r;
}

int fprintf(FILE *f, const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  int r = vfprintf(f, fmt, ap);
  va_end(ap);
  return r;
}

int puts(const char *s) { js_log(s, strlen(s)); return 0; }
int fflush(FILE *f) { (void)f; return 0; }

/* ---------- Hora (para el reloj de los juegos Pokémon) ---------- */

time_t time(time_t *t) {
  time_t now = (time_t)(js_now_ms() / 1000.0);
  if (t) *t = now;
  return now;
}

clock_t clock(void) { return (clock_t)(js_now_ms() * 1000.0); }

static struct tm tm_buf;

struct tm *gmtime(const time_t *t) {
  long long secs = *t, days = secs / 86400, rem = secs % 86400;
  if (rem < 0) { rem += 86400; days--; }
  tm_buf.tm_hour = (int)(rem / 3600);
  tm_buf.tm_min = (int)(rem % 3600 / 60);
  tm_buf.tm_sec = (int)(rem % 60);
  tm_buf.tm_wday = (int)((days + 4) % 7);
  if (tm_buf.tm_wday < 0) tm_buf.tm_wday += 7;
  /* Algoritmo de días civiles (Howard Hinnant). */
  long long z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
  long long doe = z - era * 146097, yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long long y = yoe + era * 400, doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  long long d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y++;
  tm_buf.tm_year = (int)(y - 1900);
  tm_buf.tm_mon = (int)(m - 1);
  tm_buf.tm_mday = (int)d;
  static const int cum[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  int leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
  tm_buf.tm_yday = cum[m - 1] + (int)d - 1 + (leap && m > 2);
  tm_buf.tm_isdst = 0;
  return &tm_buf;
}

struct tm *localtime(const time_t *t) {
  time_t local = *t - (time_t)js_tz_offset_min() * 60;
  return gmtime(&local);
}

struct tm *localtime_r(const time_t *t, struct tm *out) { *out = *localtime(t); return out; }

/* ---------- Archivos en memoria (ROM y BIOS) ---------- */

#define MAX_FILES 4
static struct { char path[64]; const uint8_t *data; int64_t size; } files[MAX_FILES];

EXPORT(fe_register_file) int fe_register_file(const char *path, const uint8_t *data, int size) {
  for (int i = 0; i < MAX_FILES; i++) {
    if (!files[i].data || !strcmp(files[i].path, path)) {
      strncpy(files[i].path, path, sizeof(files[i].path) - 1);
      files[i].data = data;
      files[i].size = size;
      return 1;
    }
  }
  return 0;
}

struct RFILE { const uint8_t *data; int64_t size, pos; };

void filestream_vfs_init(const struct retro_vfs_interface_info *info) { (void)info; }

RFILE *filestream_open(const char *path, unsigned mode, unsigned hints) {
  (void)mode; (void)hints;
  for (int i = 0; i < MAX_FILES; i++) {
    if (files[i].data && !strcmp(files[i].path, path)) {
      RFILE *f = malloc(sizeof(RFILE));
      f->data = files[i].data;
      f->size = files[i].size;
      f->pos = 0;
      return f;
    }
  }
  return NULL;
}

int64_t filestream_read(RFILE *f, void *buf, int64_t len) {
  if (f->pos + len > f->size) len = f->size - f->pos;
  if (len <= 0) return 0;
  memcpy(buf, f->data + f->pos, (size_t)len);
  f->pos += len;
  return len;
}

int64_t filestream_seek(RFILE *f, int64_t offset, int whence) {
  if (whence == SEEK_SET) f->pos = offset;
  else if (whence == SEEK_CUR) f->pos += offset;
  else f->pos = f->size + offset;
  return 0;
}

int64_t filestream_get_size(RFILE *f) { return f->size; }
int filestream_close(RFILE *f) { free(f); return 0; }
