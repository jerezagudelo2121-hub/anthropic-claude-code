#!/usr/bin/env bash
# Compila el núcleo gpSP (libretro) a WebAssembly con clang + wasm-ld, sin Emscripten.
# Uso: wasm/build.sh   → genera site/gpsp/gpsp.wasm
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
GPSP_REPO="https://github.com/libretro/gpsp.git"
GPSP_COMMIT="5819380c2ffb0900219d700a382ee68c464ebb99"
WORK="${GPSP_WORK:-$HERE/.build}"
SRC="$WORK/gpsp"
OBJ="$WORK/obj"
OUT="$ROOT/site/gpsp/gpsp.wasm"

mkdir -p "$WORK" "$OBJ" "$(dirname "$OUT")"
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "$GPSP_REPO" "$SRC"
fi
git -C "$SRC" fetch --quiet --depth 1 origin "$GPSP_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout --quiet "$GPSP_COMMIT"

# bios_data.S usa .incbin; para wasm se genera como array de C.
python3 - "$SRC/bios/open_gba_bios.bin" "$OBJ/bios_data.c" <<'EOF'
import sys
data = open(sys.argv[1], "rb").read()
with open(sys.argv[2], "w") as f:
    f.write("unsigned char open_gba_bios_rom[%d] = {\n" % len(data))
    for i in range(0, len(data), 16):
        f.write("".join("%d," % b for b in data[i:i + 16]) + "\n")
    f.write("};\n")
EOF

FLAGS=(--target=wasm32 -O2 -mbulk-memory -mnontrapping-fptoint -nostdlib -ffreestanding
       -I"$HERE/include" -I"$SRC/libretro" -I"$SRC/libretro/libretro-common/include" -I"$SRC"
       -D__LIBRETRO__ -DFRONTEND_SUPPORTS_RGB565 -DINLINE=inline -Wno-everything)

C_SOURCES=(main.c gba_memory.c savestate.c input.c sound.c cheats.c memmap.c serial.c gbp.c
           rfu.c serial_proto.c libretro/libretro.c gba_cc_lut.c
           libretro/libretro-common/compat/compat_strl.c
           libretro/libretro-common/string/stdstring.c
           libretro/libretro-common/encodings/encoding_utf.c)

for f in "${C_SOURCES[@]}"; do
  clang "${FLAGS[@]}" -c "$SRC/$f" -o "$OBJ/$(basename "$f").o"
done
for f in video.cc cpu.cc; do
  clang++ "${FLAGS[@]}" -fno-exceptions -fno-rtti -c "$SRC/$f" -o "$OBJ/$f.o"
done
clang "${FLAGS[@]}" -c "$OBJ/bios_data.c" -o "$OBJ/bios_data.o"
clang "${FLAGS[@]}" -fno-builtin -c "$HERE/shim.c" -o "$OBJ/shim.o"
clang "${FLAGS[@]}" -c "$HERE/frontend.c" -o "$OBJ/frontend.o"

wasm-ld --no-entry --strip-all --gc-sections -z stack-size=1048576 \
  --initial-memory=67108864 --max-memory=1073741824 \
  --export-memory -o "$OUT" "$OBJ"/*.o

echo "OK → $OUT ($(stat -c %s "$OUT") bytes)"
