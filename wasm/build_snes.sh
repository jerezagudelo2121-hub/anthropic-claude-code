#!/usr/bin/env bash
# Compila el núcleo snes9x2005 (libretro, Super Nintendo) a WebAssembly con clang + wasm-ld.
# Uso: wasm/build_snes.sh   → genera site/snes/snes9x.wasm
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
REPO="https://github.com/libretro/snes9x2005.git"
COMMIT="a79dfe9047e7fec58808aefe48ad2bf499c7af11"
WORK="${SNES_WORK:-$HERE/.build}"
SRC="$WORK/snes9x2005"
OBJ="$WORK/obj-snes"
OUT="$ROOT/site/snes/snes9x.wasm"

mkdir -p "$WORK" "$OBJ" "$(dirname "$OUT")"
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "$REPO" "$SRC"
fi
git -C "$SRC" fetch --quiet --depth 1 origin "$COMMIT" 2>/dev/null || true
git -C "$SRC" checkout --quiet "$COMMIT"
cp "$SRC/copyright" "$ROOT/site/snes/COPYRIGHT"

FLAGS=(--target=wasm32 -O2 -mbulk-memory -mnontrapping-fptoint -nostdlib -ffreestanding
       -I"$HERE/include" -I"$SRC/source" -I"$SRC" -I"$SRC/libretro-common/include"
       -D__LIBRETRO__ -DLOAD_FROM_MEMORY -DINLINE=inline -DFRONTEND_SUPPORTS_RGB565
       -include time.h -Wno-everything)

SOURCES=(c4 c4emu cheats2 cheats clip cpu cpuexec cpuops data dma dsp1 fxemu fxinst gfx getset
         globals memmap obc1 ppu sa1 sa1cpu sdd1 sdd1emu seta010 seta011 seta018 seta spc7110
         spc7110dec srtc tile apu soundux spc700)

rm -f "$OBJ"/*.o
for f in "${SOURCES[@]}"; do
  clang "${FLAGS[@]}" -c "$SRC/source/$f.c" -o "$OBJ/$f.o"
done
clang "${FLAGS[@]}" -c "$SRC/libretro.c" -o "$OBJ/libretro.o"
clang "${FLAGS[@]}" -fno-builtin -c "$HERE/shim.c" -o "$OBJ/shim.o"
clang "${FLAGS[@]}" -c "$HERE/frontend_snes.c" -o "$OBJ/frontend.o"

wasm-ld --no-entry --strip-all --gc-sections -z stack-size=1048576 \
  --initial-memory=33554432 --max-memory=536870912 \
  --export-memory -o "$OUT" "$OBJ"/*.o

echo "OK → $OUT ($(stat -c %s "$OUT") bytes)"
