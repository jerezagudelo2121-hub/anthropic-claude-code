/* Frontend libretro mínimo para el navegador: une gpSP con JavaScript.
 * Vídeo, audio y mandos se intercambian por memoria compartida; los paquetes
 * del adaptador inalámbrico (netpacket) viajan por WebRTC desde JavaScript. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <libretro.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

IMPORT(js_log) void js_log(const char *msg, size_t len);
IMPORT(js_net_send) void js_net_send(const void *buf, size_t len, unsigned client_id);
IMPORT(js_net_poll) void js_net_poll(void);

#define SCREEN_W 240
#define SCREEN_H 160
#define AUDIO_MAX 8192

static uint16_t framebuffer[SCREEN_W * SCREEN_H];
static int16_t audio[AUDIO_MAX * 2];
static unsigned audio_frames;
static uint32_t buttons;
static const struct retro_netpacket_callback *netpacket;

static const struct { const char *key, *value; } options[] = {
  { "gpsp_serial", "auto" },             /* Emerald/Quetzal → adaptador inalámbrico */
  { "gpsp_bios", "auto" },               /* gba_bios.bin si existe, si no el integrado */
  { "gpsp_boot_mode", "game" },
  { "gpsp_rtc", "auto" },
  { "gpsp_rtc_time_source", "system" },  /* hora real para eventos de Pokémon */
  { "gpsp_sound_rate", "32768" },
  { "gpsp_frameskip", "disabled" },
};

static void log_printf(enum retro_log_level level, const char *fmt, ...) {
  (void)level;
  char buf[512];
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  extern int vsnprintf(char *, size_t, const char *, __builtin_va_list);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  __builtin_va_end(ap);
  js_log(buf, strlen(buf));
}

static bool environment(unsigned cmd, void *data) {
  switch (cmd) {
  case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
    ((struct retro_log_callback *)data)->log = log_printf;
    return true;
  case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
  case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
    *(const char **)data = "/sys";
    return true;
  case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
    return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_RGB565;
  case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
    return true;
  case RETRO_ENVIRONMENT_GET_VARIABLE: {
    struct retro_variable *var = data;
    for (size_t i = 0; i < sizeof(options) / sizeof(options[0]); i++)
      if (!strcmp(var->key, options[i].key)) { var->value = options[i].value; return true; }
    var->value = NULL;
    return false;
  }
  case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
    *(bool *)data = false;
    return true;
  case RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE:
    netpacket = data;
    return true;
  case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
  case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
  case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
    return true;
  default:
    return false;
  }
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data || width != SCREEN_W || height != SCREEN_H) return;
  for (unsigned y = 0; y < SCREEN_H; y++)
    memcpy(framebuffer + y * SCREEN_W, (const uint8_t *)data + y * pitch, SCREEN_W * 2);
}

static size_t audio_batch(const int16_t *data, size_t frames) {
  if (audio_frames + frames > AUDIO_MAX) frames = AUDIO_MAX - audio_frames;
  memcpy(audio + audio_frames * 2, data, frames * 4);
  audio_frames += (unsigned)frames;
  return frames;
}

static void audio_sample(int16_t left, int16_t right) {
  int16_t s[2] = { left, right };
  audio_batch(s, 1);
}

static void input_poll(void) {}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  (void)index;
  if (port != 0 || device != RETRO_DEVICE_JOYPAD) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)buttons;
  return (buttons >> id) & 1;
}

/* ---------- API para JavaScript ---------- */

EXPORT(fe_init) void fe_init(void) {
  retro_set_environment(environment);
  retro_set_video_refresh(video_refresh);
  retro_set_audio_sample(audio_sample);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(input_poll);
  retro_set_input_state(input_state);
  retro_init();
}

EXPORT(fe_load) bool fe_load(const char *path) {
  struct retro_game_info info = { path, NULL, 0, NULL };
  return retro_load_game(&info);
}

EXPORT(fe_run) void fe_run(void) {
  audio_frames = 0;
  retro_run();
}

EXPORT(fe_reset) void fe_reset(void) { retro_reset(); }
EXPORT(fe_set_buttons) void fe_set_buttons(uint32_t mask) { buttons = mask; }
EXPORT(fe_framebuffer) uint16_t *fe_framebuffer(void) { return framebuffer; }
EXPORT(fe_audio) int16_t *fe_audio(void) { return audio; }
EXPORT(fe_audio_frames) unsigned fe_audio_frames(void) { return audio_frames; }

EXPORT(fe_sample_rate) double fe_sample_rate(void) {
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  return av.timing.sample_rate;
}

EXPORT(fe_fps) double fe_fps(void) {
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  return av.timing.fps;
}

EXPORT(fe_save_data) void *fe_save_data(void) { return retro_get_memory_data(RETRO_MEMORY_SAVE_RAM); }
EXPORT(fe_save_size) size_t fe_save_size(void) { return retro_get_memory_size(RETRO_MEMORY_SAVE_RAM); }
EXPORT(fe_state_size) size_t fe_state_size(void) { return retro_serialize_size(); }
EXPORT(fe_state_save) bool fe_state_save(void *buf, size_t size) { return retro_serialize(buf, size); }
EXPORT(fe_state_load) bool fe_state_load(const void *buf, size_t size) { return retro_unserialize(buf, size); }

/* ---------- Adaptador inalámbrico por la red ---------- */

static void net_send(int flags, const void *buf, size_t len, uint16_t client_id) {
  (void)flags;
  js_net_send(buf, len, client_id);
}

static void net_poll_receive(void) { js_net_poll(); }

EXPORT(fe_net_supported) bool fe_net_supported(void) { return netpacket != NULL; }

EXPORT(fe_net_start) void fe_net_start(unsigned client_id) {
  if (netpacket && netpacket->start) netpacket->start((uint16_t)client_id, net_send, net_poll_receive);
}

EXPORT(fe_net_stop) void fe_net_stop(void) {
  if (netpacket && netpacket->stop) netpacket->stop();
}

EXPORT(fe_net_connected) bool fe_net_connected(unsigned client_id) {
  return netpacket && netpacket->connected ? netpacket->connected((uint16_t)client_id) : true;
}

EXPORT(fe_net_disconnected) void fe_net_disconnected(unsigned client_id) {
  if (netpacket && netpacket->disconnected) netpacket->disconnected((uint16_t)client_id);
}

EXPORT(fe_net_receive) void fe_net_receive(const void *buf, size_t len, unsigned client_id) {
  if (netpacket && netpacket->receive) netpacket->receive(buf, len, (uint16_t)client_id);
}

EXPORT(fe_net_poll) void fe_net_poll(void) {
  if (netpacket && netpacket->poll) netpacket->poll();
}
