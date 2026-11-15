#pragma once
/* Sin señales en el navegador. */
#define SIGINT 2
#define SIGTRAP 5
typedef void (*sighandler_t)(int);
static inline sighandler_t signal(int s, sighandler_t h) { (void)s; (void)h; return 0; }
static inline int raise(int s) { (void)s; return 0; }
