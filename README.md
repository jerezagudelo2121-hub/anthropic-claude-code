# GBA Web 🎮

Emulador de **Game Boy Advance** que funciona en el navegador del iPhone (y de cualquier
móvil u ordenador). No hay que instalar nada: abres la página, cargas tu ROM y juegas.
Incluye **multijugador online** para jugar con un amigo.

## Qué tiene

- Motor **gpSP** (el núcleo de RetroArch que usa el multijugador de Pokémon Quetzal),
  compilado a WebAssembly. Funciona en Safari sin instalar nada.
- Mando táctil tipo Game Boy: cruceta con diagonales, A, B, L, R, START, SELECT y botón
  de avance rápido ⏩ (mantener pulsado). Se puede deslizar el dedo entre botones.
- Vista vertical y horizontal.
- **Partidas guardadas automáticas** (las del propio juego) cada 5 s y al salir de Safari.
- **3 ranuras de guardado rápido** (save states), silenciar, reiniciar.
- **Velocidad x1, x2, x3, x4 y x8** desde el menú, o manteniendo ⏩ (x4). Se desactiva en multijugador.
- Exportar / importar el archivo `.sav` (por ejemplo, para pasar tu partida del Android).
- **Biblioteca de juegos**: añade varias ROMs a la vez y quedan guardadas en el móvil, con la
  portada de cada juego (una captura de su pantalla), buscador, renombrar y eliminar.
- BIOS de GBA opcional (`gba_bios.bin`).
- Se puede añadir a la pantalla de inicio y se abre a pantalla completa, como una app.
- Tus ROMs y partidas **se quedan en tu dispositivo**, nunca se suben a internet.

## Cómo jugar en el iPhone

1. Abre la página en **Safari**.
2. (Opcional) Pulsa **Compartir → Añadir a pantalla de inicio**.
3. Pulsa **Añadir juegos** y elige tus archivos `.gba` (o `.zip`) desde la app Archivos.
4. Toca un juego de tu biblioteca para jugar.

## Multijugador con un amigo

Menú **☰ → Multijugador online**. Hay dos modos:

### 🔗 Jugar juntos (cada uno con su partida)

Cada uno juega en **su propio móvil, con su propia partida y su propio equipo**, y las dos
consolas se conectan como con el **cable link / adaptador inalámbrico** de la GBA. Es lo que
usa el multijugador de **Pokémon Quetzal** (y los combates/intercambios de Pokémon).

1. Los dos necesitáis **la misma ROM** (misma versión) y abrir esta web.
2. Uno carga su juego y pulsa **Jugar juntos**. Sale un código; pulsa **Enviar invitación**.
3. El otro abre el enlace (o escribe el código), **carga su ROM** y queda conectado.
4. Dentro del juego, entrad al modo multijugador como haríais con RetroArch.

Funciona como el netplay de RetroArch con gpSP: el núcleo elige solo el modo correcto
(cable link de Pokémon para hacks como Quetzal, adaptador inalámbrico para Esmeralda/Rojo Fuego).
No se puede conectar con RetroArch: los dos jugadores tienen que usar esta web.

### 📺 Compartir mi pantalla

Tu amigo ve tu juego en directo con sonido y puede usar su mando en tu partida (como pasarse
la consola). No necesita la ROM. Puedes desactivar sus controles cuando quieras.

La conexión es directa entre los móviles (WebRTC). Para encontrarse usan el servidor
público y gratuito de PeerJS. En algunas redes móviles muy restrictivas la conexión directa
puede fallar; en ese caso probad con Wi‑Fi, o añadid un servidor TURN en `ICE_SERVERS`
(`site/app.js`).

## Controles con teclado (ordenador)

| GBA | Tecla |
| --- | --- |
| Cruceta | Flechas |
| A / B | Z / X |
| L / R | Q / E (o A / S) |
| START / SELECT | Enter / V |

También funcionan los mandos Bluetooth (PlayStation, Xbox…) conectados al iPhone.

## Publicarlo (para tener tu enlace)

El sitio es estático (carpeta `site/`) y se publica solo con **GitHub Pages**:

1. En GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Sube los cambios a la rama `main`. El flujo `.github/workflows/pages.yml` publica la web en
   `https://<tu-usuario>.github.io/<repositorio>/`.

(GitHub Pages es gratis en repositorios públicos.) También vale cualquier hosting estático:
Netlify, Cloudflare Pages, Vercel… solo hay que subir la carpeta `site/`.

Para probarlo en local: `cd site && python3 -m http.server 8000` y abre http://localhost:8000.

## Cómo está hecho

- `site/` — la web estática (HTML/CSS/JS). `engine.js` ejecuta el núcleo; `app.js` es la interfaz
  y el multijugador.
- `site/gpsp/gpsp.wasm` — gpSP compilado a WebAssembly con `wasm/build.sh` (clang + wasm-ld,
  sin Emscripten). `wasm/frontend.c` es un frontend libretro mínimo que expone vídeo, audio,
  mandos y la interfaz *netpacket* de red; `wasm/shim.c` es una pequeña biblioteca C.
- Multijugador "Jugar juntos": los paquetes *netpacket* de gpSP viajan por un canal de datos
  WebRTC. El anfitrión es el cliente 0 y reenvía los mensajes entre invitados.

Para recompilar el núcleo: `wasm/build.sh` (necesita `clang`, `wasm-ld`, `git` y `python3`).

## Créditos y licencias

- [gpSP](https://github.com/libretro/gpsp) (GPL-2.0), commit `5819380`, compilado en
  `site/gpsp/gpsp.wasm`. Licencia en `site/gpsp/COPYING`; el código fuente se obtiene con `wasm/build.sh`.
- [PeerJS](https://peerjs.com) 1.5.5 (MIT) — `site/vendor/peerjs`
- [fflate](https://github.com/101arrowz/fflate) 0.8.2 (MIT) — `site/vendor/fflate`, para abrir ROMs `.zip`.

No se incluye ningún juego. Usa solo copias de seguridad de juegos que tengas.
