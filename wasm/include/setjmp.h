#pragma once
/* WebAssembly sin excepciones: no hay saltos largos. Solo para compilar; los núcleos se
 * configuran para no usarlos (p. ej. Genesis Plus GX sin emular errores de dirección). */
typedef int jmp_buf[1];
static inline int setjmp(jmp_buf b) { (void)b; return 0; }
static inline void longjmp(jmp_buf b, int v) { (void)b; (void)v; __builtin_trap(); }
