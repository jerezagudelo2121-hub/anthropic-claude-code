# GBA Web 🎮

Emulador de **Game Boy Advance** que funciona en el navegador del iPhone (y de cualquier
móvil u ordenador). No hay que instalar nada: abres la página, cargas tu ROM y juegas.
Incluye **multijugador online** para jugar con un amigo.

## Qué tiene

- Motor **mGBA** (el mismo que usan los mejores emuladores de Android), compilado a WebAssembly.
- Mando táctil tipo Game Boy: cruceta con diagonales, A, B, L, R, START, SELECT y botón
  de avance rápido ⏩ (mantener pulsado). Se puede deslizar el dedo entre botones.
- Vista vertical y horizontal.
- **Partidas guardadas automáticas** (las del propio juego) cada 30 s y al salir de Safari.
- **3 ranuras de guardado rápido** (save states), velocidad x2, silenciar, reiniciar.
- Exportar / importar el archivo `.sav` (por ejemplo, para pasar tu partida del Android).
- Recuerda los últimos 5 juegos para no tener que buscar la ROM cada vez.
- Se puede añadir a la pantalla de inicio y se abre a pantalla completa, como una app.
- Tus ROMs y partidas **se quedan en tu dispositivo**, nunca se suben a internet.

## Cómo jugar en el iPhone

1. Abre la página en **Safari**.
2. (Opcional) Pulsa **Compartir → Añadir a pantalla de inicio**.
3. Pulsa **Cargar ROM** y elige tu archivo `.gba` (o `.zip`) desde la app Archivos.

## Multijugador con un amigo

1. Tú cargas el juego y abres el menú **☰ → Jugar con un amigo**.
2. Aparece un código de 6 letras. Pulsa **Enviar invitación** (WhatsApp, iMessage…).
3. Tu amigo abre el enlace (o escribe el código en la página de inicio). **No necesita la ROM.**
4. Tu amigo ve el juego en directo con sonido y puede usar su propio mando.
   Desde el menú puedes desactivar sus controles cuando quieras (por turnos).

> **Importante:** funciona como si los dos compartierais **una misma Game Boy** (ideal para
> jugar por turnos, cooperativo o ayudar en una zona difícil). No es un cable link entre dos
> consolas, así que los intercambios o combates Pokémon entre dos partidas distintas no son
> posibles: ningún emulador web lo permite hoy en día.

La conexión es directa entre los dos móviles (WebRTC). Para encontrarse usan el servidor
público y gratuito de PeerJS. En algunas redes móviles muy restrictivas la conexión directa
puede fallar; en ese caso probad con Wi‑Fi, o añadid un servidor TURN en `ICE_SERVERS`
(`site/app.js`).

## Controles con teclado (ordenador)

| GBA | Tecla |
| --- | --- |
| Cruceta | Flechas |
| A / B | Z / X |
| L / R | Q / E |
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

## Créditos y licencias

- [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3 (GPL-3.0) — `site/vendor/emulatorjs`
- [mGBA](https://mgba.io) (MPL-2.0), núcleo incluido en `site/vendor/emulatorjs/data/cores`
- [PeerJS](https://peerjs.com) 1.5.5 (MIT) — `site/vendor/peerjs`

No se incluye ningún juego. Usa solo copias de seguridad de juegos que tengas.
