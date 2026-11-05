/* Frontend libretro mínimo para Super Nintendo (snes9x2005) en el navegador.
 * Igual que el de GBA, pero con dos mandos y tamaño de imagen variable. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <libretro.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

IMPORT(js_log) void js_log(const char *msg, size_t len);

#define MAX_W 512
#define MAX_H 480
#define AUDIO_MAX 8192

static uint16_t framebuffer[MAX_W * MAX_H];
static unsigned fb_w = 256, fb_h = 224;
static int16_t audio[AUDIO_MAX * 2];
static unsigned audio_frames;
static uint32_t buttons[2];

static const struct { const char *key, *value; } options[] = {
  { "snes9x_2005_region", "auto" },
  { "snes9x_2005_frameskip", "disabled" },
  { "snes9x_2005_low_pass_filter", "disabled" },
  { "snes9x_2005_overclock_cycles", "disabled" },
  { "snes9x_2005_reduce_sprite_flicker", "disabled" },
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
  case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE:
    if (data) *(int *)data = 3;
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
  case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
  case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
  case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
  case RETRO_ENVIRONMENT_SET_GEOMETRY:
    return true;
  default:
    return false;
  }
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data || width > MAX_W || height > MAX_H) return;
  fb_w = width;
  fb_h = height;
  for (unsigned y = 0; y < height; y++)
    memcpy(framebuffer + y * width, (const uint8_t *)data + y * pitch, width * 2);
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
  if (port > 1 || device != RETRO_DEVICE_JOYPAD) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)buttons[port];
  return (buttons[port] >> id) & 1;
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
  retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
}

EXPORT(fe_load_mem) bool fe_load_mem(const void *data, size_t size) {
  struct retro_game_info info = { "/rom.sfc", data, size, NULL };
  return retro_load_game(&info);
}

EXPORT(fe_run) void fe_run(void) {
  audio_frames = 0;
  retro_run();
}

EXPORT(fe_reset) void fe_reset(void) { retro_reset(); }
EXPORT(fe_set_buttons) void fe_set_buttons(uint32_t mask) { buttons[0] = mask; }
EXPORT(fe_set_buttons2) void fe_set_buttons2(uint32_t mask) { buttons[1] = mask; }
EXPORT(fe_framebuffer) uint16_t *fe_framebuffer(void) { return framebuffer; }
EXPORT(fe_width) unsigned fe_width(void) { return fb_w; }
EXPORT(fe_height) unsigned fe_height(void) { return fb_h; }
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
EXPORT(fe_ram_data) void *fe_ram_data(void) { return retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM); }
EXPORT(fe_ram_size) size_t fe_ram_size(void) { return retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM); }
EXPORT(fe_state_size) size_t fe_state_size(void) { return retro_serialize_size(); }
EXPORT(fe_state_save) bool fe_state_save(void *buf, size_t size) { return retro_serialize(buf, size); }
EXPORT(fe_state_load) bool fe_state_load(const void *buf, size_t size) { return retro_unserialize(buf, size); }
