#!/usr/bin/env bash
# Compila un núcleo libretro en C a WebAssembly con clang + wasm-ld (sin Emscripten), usando
# el frontend genérico (frontend_core.c) y la pequeña libc de shim.c.
# Uso: wasm/build_core.sh nes|gb|md   → genera site/cores/<núcleo>.wasm
set -euo pipefail

CORE="${1:?Uso: wasm/build_core.sh nes|gb|md}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="${CORE_WORK:-$HERE/.build}"
OUT_DIR="$ROOT/site/cores"
mkdir -p "$WORK" "$OUT_DIR"

fetch() {  # repo commit dir
  if [ ! -d "$3/.git" ]; then git clone --quiet "$1" "$3"; fi
  git -C "$3" fetch --quiet --depth 1 origin "$2" 2>/dev/null || true
  git -C "$3" checkout --quiet "$2"
}

case "$CORE" in
  nes)  # FCEUmm
    SRC="$WORK/libretro-fceumm"
    fetch https://github.com/libretro/libretro-fceumm.git 3338664 "$SRC"
    C="$SRC/src"; LC="$C/drivers/libretro/libretro-common"
    INC=(-I"$C/drivers/libretro" -I"$LC/include" -I"$C" -I"$C/input" -I"$C/boards")
    DEFS=(-D__LIBRETRO__ -DPATH_MAX=1024 -DFCEU_VERSION_NUMERIC=9900 -DFRONTEND_SUPPORTS_RGB565)
    FILES=("$C"/boards/*.c "$C"/input/*.c "$C"/drivers/libretro/libretro.c "$C"/drivers/libretro/libretro_dipswitch.c)
    for f in cart cheat crc32 fceu-endian fceu-memory fceu fds fds_apu file filter general input md5 nsf \
             palette ppu sound state video vsuni ines unif x6502; do FILES+=("$C/$f.c"); done
    LICENSE="$SRC/Copying"
    ;;
  gb)  # SameBoy (Game Boy y Game Boy Color)
    SRC="$WORK/SameBoy"
    fetch https://github.com/libretro/SameBoy.git aa158a8 "$SRC"
    LC="$SRC/libretro/libretro-common"
    # Arranques (boot ROMs) libres que trae SameBoy ya compilados: se pasan a C.
    for b in dmg cgb agb sgb sgb2; do
      python3 - "$SRC/BootROMs/prebuilt/${b}_boot.bin" "$WORK/gb-${b}_boot.c" "${b}_boot" <<'PY'
import sys
d = open(sys.argv[1], "rb").read()
with open(sys.argv[2], "w") as f:
    f.write("const unsigned char %s[] = {%s};\n" % (sys.argv[3], ",".join(str(x) for x in d)))
    f.write("const unsigned %s_length = sizeof(%s);\n" % (sys.argv[3], sys.argv[3]))
PY
    done
    INC=(-I"$SRC" -I"$LC/include")
    DEFS=(-D__LIBRETRO__ -DGB_INTERNAL -DGB_DISABLE_TIMEKEEPING -DGB_DISABLE_REWIND -DGB_DISABLE_DEBUGGER -DGB_DISABLE_CHEATS
          -D_GNU_SOURCE -D_USE_MATH_DEFINES -DGB_VERSION=\"0.15.4\" -std=gnu11)
    FILES=()
    for f in gb sgb apu memory mbc timing display symbol_hash camera sm83_cpu joypad save_state random rumble; do
      FILES+=("$SRC/Core/$f.c")
    done
    FILES+=("$WORK"/gb-*_boot.c "$SRC/libretro/libretro.c")
    LICENSE="$SRC/LICENSE"
    ;;
  md)  # Genesis Plus GX (Mega Drive / Genesis, Master System y Game Gear)
    SRC="$WORK/Genesis-Plus-GX"
    fetch https://github.com/libretro/Genesis-Plus-GX.git b9c2316 "$SRC"
    # Sin setjmp/longjmp en WebAssembly: se desactiva la emulación de "address error" del 68000
    # (solo la usan unos pocos juegos de forma deliberada).
    sed -i 's/#define M68K_EMULATE_ADDRESS_ERROR  OPT_ON/#define M68K_EMULATE_ADDRESS_ERROR  OPT_OFF/' "$SRC/core/m68k/m68kconf.h"
    LC="$SRC/libretro/libretro-common"
    DIRS=(core core/z80 core/m68k core/ntsc core/sound core/sound/minimp3 core/input_hw core/cd_hw core/cart_hw core/cart_hw/svp)
    INC=(-I"$SRC/libretro" -I"$LC/include" -I"$SRC/libretro/deps/zlib-1.2.11")
    FILES=()
    for d in "${DIRS[@]}"; do INC+=(-I"$SRC/$d"); for f in "$SRC/$d"/*.c; do [ -e "$f" ] && FILES+=("$f"); done; done
    for z in adler32 crc32 inffast inflate inftrees zutil; do FILES+=("$SRC/libretro/deps/zlib-1.2.11/$z.c"); done
    FILES+=("$SRC/libretro/libretro.c" "$LC/streams/file_stream_transforms.c")
    DEFS=(-D__LIBRETRO__ -DLSB_FIRST -DBYTE_ORDER=LITTLE_ENDIAN -DHAVE_ZLIB -DUSE_16BPP_RENDERING
          -DFRONTEND_SUPPORTS_RGB565 -DNDEBUG)
    INLINE_DEF="static inline"
    LICENSE="$SRC/LICENSE.txt"
    ;;
  *)
    echo "Núcleo desconocido: $CORE" >&2; exit 1 ;;
esac

for f in compat/compat_strl.c compat/compat_strcasestr.c compat/compat_posix_string.c compat/compat_snprintf.c \
         string/stdstring.c encodings/encoding_utf.c; do
  [ -f "$LC/$f" ] && FILES+=("$LC/$f")
done

FLAGS=(--target=wasm32 -O2 -mbulk-memory -mnontrapping-fptoint -nostdlib -ffreestanding
       -I"$HERE/include" "${INC[@]}" "${DEFS[@]}" -DINLINE="${INLINE_DEF:-inline}" -include time.h -Wno-everything)

OBJ="$WORK/obj-$CORE"
mkdir -p "$OBJ"
find "$OBJ" -name '*.o' -delete
i=0
for f in "${FILES[@]}"; do
  i=$((i + 1))
  clang "${FLAGS[@]}" -c "$f" -o "$OBJ/$i-$(basename "$f" .c).o" || FAILED="${FAILED:-} $f"
done
[ -z "${FAILED:-}" ] || { echo "No compilaron:$FAILED" >&2; exit 1; }
clang "${FLAGS[@]}" -fno-builtin -c "$HERE/shim.c" -o "$OBJ/zz-shim.o"
clang "${FLAGS[@]}" -c "$HERE/frontend_core.c" -o "$OBJ/zz-frontend.o"

OUT="$OUT_DIR/$CORE.wasm"
wasm-ld --no-entry --strip-all --gc-sections -z stack-size=1048576 \
  --initial-memory=33554432 --max-memory=536870912 \
  --export-memory -o "$OUT" "$OBJ"/*.o
cp "$LICENSE" "$OUT_DIR/$CORE.LICENSE.txt"
echo "OK → $OUT ($(stat -c %s "$OUT") bytes)"
