#pragma once
/* Sin entrada de consola en el navegador: select() nunca tiene nada listo. */
#include <sys/types.h>
typedef struct { unsigned long bits[1]; } fd_set;
#ifndef _STRUCT_TIMEVAL
#define _STRUCT_TIMEVAL
struct timeval { long tv_sec; long tv_usec; };
#endif
#define FD_ZERO(s) ((s)->bits[0] = 0)
#define FD_SET(fd, s) ((s)->bits[0] |= 1UL << (fd))
#define FD_ISSET(fd, s) (((s)->bits[0] >> (fd)) & 1)
static inline int select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *t) { (void)n; (void)r; (void)w; (void)e; (void)t; return 0; }
