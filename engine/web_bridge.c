#include <emscripten.h>
#include "sm64.h"
#include "native_input.h"
#include <stdio.h>
#include <string.h>
#include <SDL2/SDL.h>
#include "pc/configfile.h"
#include "pc/fs/fs.h"
#include "pc/network/network.h"
#include "pc/pc_main.h"
#include "game/level_update.h"
#include "game/mario.h"
#include "game/camera.h"
#include "game/save_file.h"
#include "pc/djui/djui.h"
#include "pc/djui/djui_panel.h"
#include "pc/djui/djui_panel_pause.h"
#include "pc/controller/controller_mouse.h"
#include "pc/gfx/gfx_pc.h"
#include "game/ingame_menu.h"
#include "game/hud.h"


static float sPointerX = -1, sPointerY = -1;
static int sPointerPhase, sPointerHeld;
extern int web_star_active(void);
extern void web_star_pointer(float x, float y, int click);
extern s8 gDialogLineNum;
extern s8 gLastDialogResponse;
EMSCRIPTEN_KEEPALIVE int web_ui_state(void) {
    return djui_panel_is_active() ? 1 : get_dialog_id() >= 0 ? 2 : web_star_active() ? 4 : 0;
}
EMSCRIPTEN_KEEPALIVE u32 web_player_action(void) { return gMarioStates[0].action; }
EMSCRIPTEN_KEEPALIVE int web_airborne(void) { return (gMarioStates[0].action & ACT_FLAG_AIR) != 0; }
EMSCRIPTEN_KEEPALIVE void web_action(int action) {
    // Runs in simulation ticks so a short gesture cannot disappear between RAFs.
    if (action == 3 && !web_airborne()) return;
    if (!action) sm64_rust_input_reset();
    else sm64_rust_gesture(action, web_airborne());
}
EMSCRIPTEN_KEEPALIVE void web_menu(void) {
    sm64_rust_input_reset(); sPointerPhase = sPointerHeld = 0;
    if (djui_panel_is_active()) djui_panel_back();
    else if (!web_ui_state()) djui_panel_pause_create(NULL);
}
EMSCRIPTEN_KEEPALIVE void web_pointer(float x, float y, int event) {
    sPointerX = x; sPointerY = y;
    int ui = web_ui_state();
    if (event < 0) { sPointerPhase = sPointerHeld = 0; return; }
    if (ui == 4) { web_star_pointer(x, y, event == 0); return; }
    if (ui == 2) {
        if (gLastDialogResponse && gDialogBoxState == 1) gDialogLineNum = x < 0.5f ? 1 : 2;
        if (event == 0) web_action(1);
        return;
    }
    if (ui != 1) return;
    if (event == 1) { sPointerPhase = 1; sPointerHeld = 1; }
    if (event == 0) sPointerHeld = 0;
}
void web_read_pointer(void) {
    mouse_window_x = sPointerX * gfx_current_dimensions.width;
    mouse_window_y = sPointerY * gfx_current_dimensions.height;
    // First tick hovers, second presses, then releases: taps between game
    // frames still run the native hover / down / up handlers in order.
    mouse_window_buttons = sPointerPhase >= 3 ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE int web_hovered(void) { return (int)(uintptr_t)gDjuiHovered; }

EMSCRIPTEN_KEEPALIVE void web_input(u16 buttons, s8 x, s8 y, s8 cx, s8 cy, s32 mx, s32 my) {
    sm64_rust_input_set(buttons, x, y, cx, cy, mx, my);
}
EMSCRIPTEN_KEEPALIVE void web_read_input(OSContPad* pad) {
    struct RustInputFrame input;
    sm64_rust_input_tick(&input);
    controller_mouse_read_relative();
    pad->button = input.buttons; pad->stick_x = input.x; pad->stick_y = input.y;
    pad->ext_stick_x = input.camera_x; pad->ext_stick_y = input.camera_y;
    if (sPointerPhase == 1) sPointerPhase = 2;
    else if (sPointerPhase == 2) sPointerPhase = 3;
    else if (sPointerPhase == 3) sPointerPhase = 4;
    else if (sPointerPhase == 4 && !sPointerHeld) sPointerPhase = 0;
}
EMSCRIPTEN_KEEPALIVE s32 web_mouse_x(void) { return sm64_rust_mouse(0); }
EMSCRIPTEN_KEEPALIVE s32 web_mouse_y(void) { return sm64_rust_mouse(1); }
EMSCRIPTEN_KEEPALIVE u32 web_rust_adapter_version(void) { return sm64_rust_adapter_version(); }
EM_JS(void, notify_save, (const u8* data), { Module.coopBridge.save(HEAPU8.slice(data, data + 512)); });
EMSCRIPTEN_KEEPALIVE void web_save_snapshot(void) {
    if (gNetworkType != NT_SERVER) return;
    u8 bytes[512];
    fs_file_t* file = fs_open(SAVE_FILENAME);
    if (!file) return;
    size_t length = fs_read(file, bytes, sizeof(bytes)); fs_close(file);
    if (length == sizeof(bytes)) notify_save(bytes);
}
extern void update_all_mario_stars(void);
extern u8* gOverrideEeprom;
EMSCRIPTEN_KEEPALIVE void web_reload_save(void) {
    if (gNetworkType == NT_CLIENT && gOverrideEeprom) {
        fs_file_t* file = fs_open(SAVE_FILENAME);
        if (!file) return;
        u8 bytes[512]; size_t length = fs_read(file, bytes, sizeof(bytes)); fs_close(file);
        if (length != sizeof(bytes)) return;
        memcpy(gOverrideEeprom, bytes, sizeof(bytes));
    }
    save_file_load_all(TRUE); update_all_mario_stars();
}
EM_JS(void, diagnostics, (s32 level, s32 area, s32 type, s32 players, s32 stars,
    f32 x, f32 y, f32 z, f32 cameraX, f32 cameraY, f32 cameraZ,
    f32 focusX, f32 focusY, f32 focusZ, s32 yaw,
    s32 freeCamera, s32 analog, s32 mouse, s32 collision), {
    Module.coopBridge.diagnostics({level, area, networkType:type, players, stars,
        position:[x,y,z], heapBytes:HEAPU8.length,
        camera:{position:[cameraX,cameraY,cameraZ], focus:[focusX,focusY,focusZ], yaw,
            enabled:!!freeCamera, analog:!!analog, mouse:!!mouse, collision:!!collision}});
});
EMSCRIPTEN_KEEPALIVE void web_diagnostics(void) {
    int players = 0; for (int i=0; i<MAX_PLAYERS; i++) if (gNetworkPlayers[i].connected) players++;
    diagnostics(gCurrLevelNum, gCurrAreaIndex, gNetworkType, players, gMarioStates[0].numStars,
        gMarioStates[0].pos[0], gMarioStates[0].pos[1], gMarioStates[0].pos[2],
        gLakituState.pos[0], gLakituState.pos[1], gLakituState.pos[2],
        gLakituState.focus[0], gLakituState.focus[1], gLakituState.focus[2], gLakituState.yaw,
        configEnableFreeCamera, configFreeCameraAnalog, configFreeCameraMouse, configFreeCameraHasCollision);
}
EMSCRIPTEN_KEEPALIVE void web_resize(int width, int height) {
    configWindow.w = width; configWindow.h = height; configWindow.settings_changed = true;
}
extern void game_deinit(void);
EMSCRIPTEN_KEEPALIVE void web_stop(void) { emscripten_cancel_main_loop(); game_deinit(); }
EMSCRIPTEN_KEEPALIVE void web_mute(int mute) { configMasterVolume = mute ? 0 : 100; }

extern const char* web_button_text(struct DjuiBase*);
static void web_menu_visit(struct DjuiBase* base) {
    if (!base || !base->visible) return;
    const char* text = web_button_text(base);
    if (text && base->interactable && base->enabled) {
        float scale = djui_gfx_get_scale();
        EM_ASM({ Module.webMenuItems.push({label:UTF8ToString($0),id:$1,x:$2,y:$3,width:$4,height:$5}); },
            text, (uintptr_t)base, base->elem.x * scale / gfx_current_dimensions.width,
            base->elem.y * scale / gfx_current_dimensions.height,
            base->elem.width * scale / gfx_current_dimensions.width,
            base->elem.height * scale / gfx_current_dimensions.height);
    }
    for (struct DjuiBaseChild* child = base->child; child; child = child->next) web_menu_visit(child->base);
}
EMSCRIPTEN_KEEPALIVE void web_menu_snapshot(void) {
    EM_ASM({ Module.webMenuItems = []; });
    if (gDjuiRoot && djui_panel_is_active()) web_menu_visit(&gDjuiRoot->base);
}

int web_portrait_hud(void) { return configWindow.w < configWindow.h; }
EMSCRIPTEN_KEEPALIVE void web_hud_snapshot(void) {
    EM_ASM({ Module.coopBridge.hud?.({lives:$0,coins:$1,stars:$2,health:$3,keys:$4,flags:$5,timer:$6,cap:$7}); },
        gHudDisplay.lives, gHudDisplay.coins, gHudDisplay.stars, gHudDisplay.wedges,
        gHudDisplay.keys, gOverrideHideHud ? 0 : gHudDisplay.flags, gHudDisplay.timer, gMarioStates[0].capTimer);
}

EM_JS(void, web_leave_lobby, (), { Module.coopBridge.leave?.(); });

// Bounded diagnostic history; no recording or sample data leaves the browser.
static int sAudioTraceEnabled;
void web_trace_sound(u32 sound) {
    if (!sAudioTraceEnabled) return;
    struct MarioState *m = &gMarioStates[0];
    EM_ASM({ if (Module.webSoundTrace) {
        const events = Module.webSoundEvents ||= [];
        events.push({sound:$0>>>0,level:$1,terrain:$2,addend:$3>>>0,floor:$4});
        if (events.length > 256) events.shift();
    } }, sound, gCurrLevelNum, m->area ? m->area->terrainType : -1,
         m->terrainSoundAddend, m->floor ? m->floor->type : -1);
}
#include "audio/internal.h"
#include "audio/load.h"
#include "audio/playback.h"
#include "sound/sound_data.h"
#include "pc/lua/utils/smlua_level_utils.h"
EMSCRIPTEN_KEEPALIVE void web_audio_probe(int castle) {
    if (!EM_ASM_INT({ return !!Module.webSoundTrace; })) return;
    sAudioTraceEnabled = 1;
    if (castle) { warp_to_level(6, 1, 1); return; }
    EM_ASM({ Module.webAudioSamples = []; });
    if (!gCtlEntries) return;
    for (int i = 0; i < gCtlEntries[1].numInstruments; i++) {
        struct Instrument *instrument = gCtlEntries[1].instruments[i];
        if (!instrument || !instrument->normalNotesSound.sample) continue;
        struct AudioBankSample *sample = instrument->normalNotesSound.sample;
        EM_ASM({ Module.webAudioSamples.push({instrument:$0,offset:$1,tuning:$2,size:$3,bytes:Array.from(HEAPU8.subarray($4,$4+Math.min($3,32)))}); },
            i, (int)(sample->sampleAddr - gSoundDataRaw), instrument->normalNotesSound.tuning, sample->sampleSize, sample->sampleAddr);
    }
}
