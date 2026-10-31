# GBA Web 🎮

Emulador de **Game Boy Advance** que funciona en el navegador del iPhone (y de cualquier
móvil u ordenador). No hay que instalar nada: abres la página, cargas tu ROM y juegas.
Incluye **multijugador online** para jugar con un amigo.

## Qué tiene

- Motor **gpSP** (el núcleo de RetroArch que usa el multijugador de Pokémon Quetzal),
  compilado a WebAssembly. Funciona en Safari sin instalar nada.
- Mando táctil tipo Game Boy: cruceta con diagonales, A, B, L, R, START, SELECT y botón
  de avance rápido ⏩ (mantener pulsado). Se puede deslizar el dedo entre botones.
- Pantalla lo más grande posible: de borde a borde en vertical y a toda la altura en horizontal.
  Opción **Ocultar mando** para jugar solo con la pantalla (por ejemplo, con un mando Bluetooth).
- **Gráficos (WebGL)**: filtros *Original* (píxeles nítidos), *HD* (bordes suaves, Scale2x ×2),
  *LCD* (rejilla de la pantalla de la GBA) y *CRT* (tele antigua), más la opción *Colores de la GBA original*.
- **Personalizar**: 9 diseños de consola (Medianoche, Gris clásico, Morado transparente, Plata,
  Retro 8 bits, Retro 16 bits, Amarillo eléctrico, Neón y Negro mate) y fondos (Atardecer, Océano,
  Bosque, Galaxia o **tu propia foto**).
- **Partidas guardadas automáticas** (las del propio juego) cada 5 s y al salir de Safari.
- **3 ranuras de guardado rápido** (save states), silenciar, reiniciar.
- **Velocidad x1, x2, x3, x4 y x8** desde el menú, o manteniendo ⏩ (x4). Se desactiva en multijugador.
- Exportar / importar el archivo `.sav` (por ejemplo, para pasar tu partida del Android).
- **Biblioteca de juegos**: añade varias ROMs a la vez y quedan guardadas en el móvil, con la
  portada de cada juego (una captura de su pantalla), buscador, renombrar y eliminar.
- BIOS de GBA opcional (`gba_bios.bin`).
- Se puede añadir a la pantalla de inicio y se abre a pantalla completa, como una app.
- Tus ROMs y partidas **se quedan en tu dispositivo**, nunca se suben a internet.

## 🌐 Juego incluido: Pixelterra

En la pantalla de inicio, **🌐 Juegos web → Pixelterra** (`site/juegos/pixelterra/`): un juego
original para el navegador, inspirado en la idea de mezclar mundos de bloques con criaturas
coleccionables, con criaturas, nombres y gráficos propios (todo dibujado con código).

- Mundo generado (isla con playa, bosque, hierba alta y montañas con carbón, hierro y gemas).
- **A**: talar, picar, cortar hierba (bayas), usar el banco o la hoguera. **B**: poner bloques.
- **Fabricar**: tablas, palos, banco de trabajo, picos de madera/piedra/hierro, cubos, supercubos,
  hogueras, ladrillos y pociones.
- **12 criaturas** de 6 tipos, combates por turnos con eficacias, experiencia y niveles, captura
  con cubos, equipo de 6 y caja.
- Día y noche (de noche aparecen criaturas distintas y las hogueras iluminan). Guardado automático.

## Cómo jugar en el iPhone

1. Abre la página en **Safari**.
2. (Opcional) Pulsa **Compartir → Añadir a pantalla de inicio**.
3. Pulsa **Añadir juegos** y elige tus archivos `.gba` (o `.zip`) desde la app Archivos.
4. Toca un juego de tu biblioteca para jugar.

## Cómo jugar en Android

1. Abre la página en **Chrome**.
2. Pulsa **📲 Instalar como app** (o menú **⋮ → Instalar aplicación**). Queda con su icono en el móvil.
3. Añade tus juegos y toca uno para jugar.

En Android además: **vibración** al pulsar los botones (se puede quitar en ☰ → Opciones), el
**botón atrás** abre/cierra el menú sin salir del juego, **pantalla completa** que oculta las barras
de Android, **🔄 Girar pantalla**, y la web **funciona sin internet** para jugar solo (service worker).

## Multijugador con un amigo

Menú **☰ → Multijugador online**. Hay dos modos:

### 🔗 Jugar juntos (cada uno con su partida)

Cada uno juega en **su propio móvil, con su propia partida y su propio equipo**, y las consolas
se conectan como con el **cable link / adaptador inalámbrico** de la GBA. Es lo que usa el
multijugador de **Pokémon Quetzal** (y los combates/intercambios de Pokémon).

1. Los dos elegís un **apodo** en la pantalla de inicio.
2. Uno **añade al otro** por su apodo (👥 Amigos → Añadir amigo). Al otro le aparece solo.
   Cuando tu amigo tiene la web abierta sale con el **punto verde** y lo que está jugando.
3. Abre tu juego y, en **☰ → 👥 Amigos**, pulsa **Invitar**.
4. A tu amigo le sale *"Aabio te invita a jugar Quetzal"* → **Aceptar**. Se abre su Quetzal de
   la biblioteca y entra en tu **sala** (anfitrión + hasta 3 amigos; los huecos salen como "Libre").
5. Ya en la sala, **invitaos desde el propio juego** (menú multijugador de Quetzal).

También se puede entrar con el **código de sala** (Jugar juntos → Enviar invitación) si tu
amigo aún no está en tu lista. Los dos necesitáis **la misma ROM** (misma versión).

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

- `site/` — la web estática (HTML/CSS/JS). `engine.js` ejecuta el núcleo, `renderer.js` dibuja la
  pantalla con WebGL y los filtros, y `app.js` es la interfaz y el multijugador.
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
