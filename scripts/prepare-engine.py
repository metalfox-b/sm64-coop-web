from pathlib import Path
import shutil
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))
from audio32 import prepare as prepare_audio32
root = Path(__file__).resolve().parent.parent
source = root / 'vendor/coopdx'

def copy_if_changed(src, dst):
    if not dst.exists() or src.read_bytes() != dst.read_bytes():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)

def replace(file, before, after):
    path = source / file
    text = path.read_text()
    if after in text:
        return
    if text.count(before) != 1:
        raise RuntimeError(f'Upstream anchor changed: {file}: {before[:80]}')
    path.write_text(text.replace(before, after))

copy_if_changed(root / 'engine/web_socket.c', source / 'src/pc/network/socket/socket.c')
copy_if_changed(root / 'engine/web_bridge.c', source / 'src/pc/web_bridge.c')
copy_if_changed(root / 'engine/native_input.h', source / 'src/pc/native_input.h')
for path in (root / 'vendor/lua/src').glob('*'):
    if path.suffix in ('.c', '.h'):
        destination = source / 'lib/lua/src' / path.name
        copy_if_changed(path, destination)

replace('Makefile', 'ENDIAN_BITWIDTH       :=', 'include ../../engine/web.mk\n\nENDIAN_BITWIDTH       :=')
replace('Makefile', 'DUMMY != $(MAKE) -C $(TOOLS_DIR) >&2 || echo FAIL', 'DUMMY := $(shell $(MAKE) -C $(TOOLS_DIR) >&2 || echo FAIL)')
replace('Makefile', 'DUMMY != mkdir -p $(ALL_DIRS)', 'DUMMY := $(shell mkdir -p $(ALL_DIRS))')
# Apple's GNU make 3.81 treats the newer `define name =` spelling as part
# of the variable name, silently dropping every generated level dependency.
replace('Makefile.split', 'define level_rules =\n', 'define level_rules\n')
replace('src/pc/pc_main.c', '#include <stdlib.h>', '#include <emscripten.h>\n#include <stdlib.h>')
replace('src/pc/pc_main.c', '    CTX_EXTENT(CTX_RENDER, produce_interpolation_frames_and_delay);', '    /* Web presentation is paced by requestAnimationFrame in web_frame. */')
prepared_main = source / 'src/pc/pc_main.c'
prepared_text = prepared_main.read_text()
prepared_text = prepared_text.replace('static f64 lastTick = -1, lastPresent = -1;', 'static f64 lastTick = -1, nextPresent = -1;').replace('    if (lastPresent >= 0 && now - lastPresent < 1.0 / 60.0 - 0.001) return;\n    lastPresent = now;', '    if (nextPresent >= 0 && now + 0.0005 < nextPresent) return;\n    // Keep the presentation deadline on a fixed grid. Resetting it to the\n    // current clock on every frame drops valid RAF frames under small jitter.\n    nextPresent = nextPresent < 0 || now - nextPresent > 0.1 ? now + 1.0 / 60.0 : nextPresent + 1.0 / 60.0;')
if prepared_text != prepared_main.read_text(): prepared_main.write_text(prepared_text)
replace('src/pc/pc_main.c', 'int main(int argc, char *argv[]) {', '''static void web_frame(void) {
    static f64 lastTick = -1, nextPresent = -1;
    f64 now = emscripten_get_now() / 1000.0;
    if (nextPresent >= 0 && now + 0.0005 < nextPresent) return;
    // Keep the presentation deadline on a fixed grid. Resetting it to the
    // current clock on every frame drops valid RAF frames under small jitter.
    nextPresent = nextPresent < 0 || now - nextPresent > 0.1 ? now + 1.0 / 60.0 : nextPresent + 1.0 / 60.0;
    if (lastTick < 0 || now - lastTick > 0.2) lastTick = now - sFrameTime;
    int updates = 0;
    while (now - lastTick >= sFrameTime - 0.0001 && updates < 2) {
        gWindowApi->main_loop(produce_one_frame);
        lastTick += sFrameTime; updates++;
    }
    gRenderingInterpolated = true;
    gRenderingDelta = clamp((now - lastTick) / sFrameTime, 0.f, 1.f);
    gFramePercentage = gRenderingDelta;
    gfx_start_frame();
    if (!gSkipInterpolationTitleScreen) patch_interpolations(gRenderingDelta);
    send_display_list(gGfxSPTask);
    gfx_end_frame_render(); gfx_display_frame();
    gRenderingInterpolated = false;
    EM_ASM({ Module.coopBridge.presented(); });
}

int main(int argc, char *argv[]) {''')
start = (source / 'src/pc/pc_main.c').read_text()
if 'emscripten_set_main_loop(web_frame' not in start:
    begin = start.index('    // main loop\n    while (true) {')
    end = start.index('\n    return 0;\n}', begin)
    (source / 'src/pc/pc_main.c').write_text(start[:begin] + '    emscripten_set_main_loop(web_frame, 0, 0);\n' + start[end:])
replace('src/pc/controller/controller_entry_point.c', 'void osContGetReadData(OSContPad *pad) {', 'extern void web_read_input(OSContPad*);\nvoid osContGetReadData(OSContPad *pad) {')
replace('src/pc/controller/controller_entry_point.c', '''    for (size_t i = 0; i < sizeof(controller_implementations) / sizeof(struct ControllerAPI *); i++) {
        controller_implementations[i]->read(pad);
    }''', '    web_read_input(pad);')
replace('src/pc/controller/controller_mouse.c', 'void controller_mouse_read_relative(void) {', '''extern s32 web_mouse_x(void);
extern s32 web_mouse_y(void);
void controller_mouse_read_relative(void) {
    mouse_init_ok = true;
    mouse_x = web_mouse_x(); mouse_y = web_mouse_y(); mouse_buttons = 0;
    return;''')
# The browser wrapper handles asset versions. Native updater requests cannot run in an Activity.
updater = source / 'src/pc/update_checker.c'
updater_stub = '#include "update_checker.h"\nbool gUpdateMessage=false;\nvoid show_update_popup(void) {}\nvoid check_for_updates(void) {}\n'
if updater.read_text() != updater_stub:
    updater.write_text(updater_stub)
replace('src/pc/configfile.c', 'configEnableFreeCamera               = false;', 'configEnableFreeCamera               = true;')
replace('src/pc/configfile.c', 'configFreeCameraAnalog               = false;', 'configFreeCameraAnalog               = true;')
replace('src/pc/configfile.c', 'configFreeCameraLCentering           = false;', 'configFreeCameraLCentering           = true;')
replace('src/pc/configfile.c', 'configFreeCameraMouse                = false;', 'configFreeCameraMouse                = true;')
replace('src/pc/configfile.c', 'configCameraInvertY                  = true;', 'configCameraInvertY                  = false;')
replace('src/pc/ultra_reimplementation.c', '    fclose(fp);\n\n    return ret;', '    fclose(fp);\n    if (ret == 0) { extern void web_save_snapshot(void); web_save_snapshot(); }\n\n    return ret;')
replace('src/pc/platform.c', 'const char *sys_exe_path_file(void) {', 'const char *sys_exe_path_file(void) {\n    return "/coop/sm64";')
replace('src/pc/gfx/gfx_opengl.c', '''    if (vmajor >= 3 && !is_es) {
        glGenVertexArrays(1, &opengl_vao);
        glBindVertexArray(opengl_vao);
    }''', '''#ifndef USE_GLES
    if (vmajor >= 3 && !is_es) {
        glGenVertexArrays(1, &opengl_vao);
        glBindVertexArray(opengl_vao);
    }
#endif''')
prepare_audio32(source)
print('Applied checked browser transport, frame pacing, input and camera patches.')

# Browser pointer ownership and native menu hit testing.
replace('src/pc/controller/controller_mouse.c', 'void controller_mouse_read_window(void) {', 'extern void web_read_pointer(void);\nvoid controller_mouse_read_window(void) {\n    web_read_pointer(); return;')
replace('src/pc/controller/controller_mouse.c', 'void controller_mouse_enter_relative(void) {', 'void controller_mouse_enter_relative(void) {\n    mouse_relative_enabled = true; return;')
replace('src/pc/controller/controller_mouse.c', 'void controller_mouse_leave_relative(void) {', 'void controller_mouse_leave_relative(void) {\n    mouse_relative_enabled = false; return;')
replace('src/pc/djui/djui_gfx.c', 'f32 djui_gfx_get_scale(void) {', 'f32 djui_gfx_get_scale(void) {\n    u32 webWidth, webHeight; gfx_get_dimensions(&webWidth, &webHeight);\n    if (webWidth < webHeight) return (f32)webWidth / 580.0f;')
# Hover must take ownership even when a touch begins at the saved cursor position.
replace('src/pc/djui/djui_cursor.c', '    // update mouse cursor\n', '    extern int web_ui_state(void);\n    if (web_ui_state() == 1 && mouse_window_x >= 0) sCursorMouseControlled = true;\n    // update mouse cursor\n')
# Act selection uses the same selectable-star index as the original pad handler.
replace('src/menu/star_select.c', 's32 lvl_init_act_selector_values_and_stars(UNUSED s32 arg, UNUSED s32 unused) {', 'static int sWebStarActive;\nint web_star_active(void) { return sWebStarActive; }\ns32 lvl_init_act_selector_values_and_stars(UNUSED s32 arg, UNUSED s32 unused) {\n    sWebStarActive = 1;')
replace('src/menu/star_select.c', 'void star_select_finish_selection(void) {', 'void star_select_finish_selection(void) {\n    sWebStarActive = 0;')
replace('src/menu/star_select.c', '    if (gDjuiInMainMenu) { return 1; }', '    if (gDjuiInMainMenu) { sWebStarActive = 0; return 1; }')
replace('src/menu/star_select.c', 'void bhv_act_selector_loop(void) {', '''void web_star_pointer(float x, float y, int click) {
    if (!web_star_active() || y < 0.65f || y > 0.96f) return;
    float aspect = gfx_current_dimensions.aspect_ratio;
    float screenX = 160.0f + (x - 0.5f) * 240.0f * aspect;
    int index = (int)floorf((screenX - (143 - sVisibleStars * 17 + 34)) / 34 + 0.5f);
    if (index < 0 || index >= sVisibleStars) return;
    u8 stars = save_file_get_star_flags(gCurrSaveFileNum - 1, gCurrCourseNum - 1);
    if (!(stars & (1 << index)) && index + 1 != sInitSelectedActNum) return;
    int selectable = 0;
    for (int i = 0; i < index; i++) if ((stars & (1 << i)) || i + 1 == sInitSelectedActNum) selectable++;
    sSelectableStarIndex = selectable; sSelectedActIndex = index;
    if (click && sActSelectorMenuTimer >= 11) star_select_finish_selection();
}
void bhv_act_selector_loop(void) {''')
replace('src/menu/star_select.c', '#include <stdio.h>', '#include <stdio.h>\n#include "gfx_dimensions.h"\nint web_star_active(void);')
# Keep a useful horizontal field of view on a tall display. Physics/camera
# collision stay original; only the projection adapts to the viewport.
if 'static float web_portrait_fov' not in (source/'src/game/rendering_graph_node.c').read_text():
 replace('src/game/rendering_graph_node.c', '#include "gfx_dimensions.h"', '''#include <math.h>
#include "gfx_dimensions.h"
static float web_portrait_fov(float fov) {
    float aspect = gfx_current_dimensions.aspect_ratio;
    if (aspect >= 1.0f) return fov;
    return fminf(110.0f, atanf(tanf(fov * 0.00872664626f) / aspect) * 114.591559f);
}''')
# A modest extra 15% view width in portrait; landscape is unchanged.
replace('src/game/rendering_graph_node.c',
    'return fminf(110.0f, atanf(tanf(fov * 0.00872664626f) / aspect) * 114.591559f);',
    'return fminf(120.0f, atanf(tanf(fov * 0.00872664626f) * 1.15f / aspect) * 114.591559f);')
replace('src/game/rendering_graph_node.c', 'guPerspective(mtx, &perspNorm, node->prevFov, aspect, near, far, 1.0f);', 'guPerspective(mtx, &perspNorm, web_portrait_fov(node->prevFov), aspect, near, far, 1.0f);')
replace('src/game/rendering_graph_node.c', 'guPerspective(sPerspectiveMtx, &perspNorm, fovInterpolated, sPerspectiveAspect, near, far, 1.0f);', 'guPerspective(sPerspectiveMtx, &perspNorm, web_portrait_fov(fovInterpolated), sPerspectiveAspect, near, far, 1.0f);')
replace('src/game/rendering_graph_node.c', 's16 halfFov = (gCurGraphNodeCamFrustum->fov / 2.0f + 1.0f)', 's16 halfFov = (web_portrait_fov(gCurGraphNodeCamFrustum->fov) / 2.0f + 1.0f)')
# Reflow the original HUD into three rows rather than overlapping its counters.
replace('src/game/hud.c', '    print_text(168, HUD_TOP_Y, "+");', '    print_text(GFX_DIMENSIONS_ASPECT_RATIO < 1 ? GFX_DIMENSIONS_RECT_FROM_LEFT_EDGE(22) : 168, GFX_DIMENSIONS_ASPECT_RATIO < 1 ? 185 : HUD_TOP_Y, "+");')
replace('src/game/hud.c', '    print_text(184, HUD_TOP_Y, "*");', '    print_text(GFX_DIMENSIONS_ASPECT_RATIO < 1 ? GFX_DIMENSIONS_RECT_FROM_LEFT_EDGE(38) : 184, GFX_DIMENSIONS_ASPECT_RATIO < 1 ? 185 : HUD_TOP_Y, "*");')
replace('src/game/hud.c', '    print_text_fmt_int(198, HUD_TOP_Y, "%d", gHudDisplay.coins);', '    print_text_fmt_int(GFX_DIMENSIONS_ASPECT_RATIO < 1 ? GFX_DIMENSIONS_RECT_FROM_LEFT_EDGE(54) : 198, GFX_DIMENSIONS_ASPECT_RATIO < 1 ? 185 : HUD_TOP_Y, "%d", gHudDisplay.coins);')
replace('src/game/hud.c', 'void render_hud_stars(void) {', '''void render_hud_stars(void) {
    if (GFX_DIMENSIONS_ASPECT_RATIO < 1) {
        print_text(GFX_DIMENSIONS_RECT_FROM_LEFT_EDGE(22), 161, "-");
        print_text(GFX_DIMENSIONS_RECT_FROM_LEFT_EDGE(38), 161, "*");
        print_text_fmt_int(GFX_DIMENSIONS_RECT_FROM_LEFT_EDGE(54), 161, "%d", gHudDisplay.stars);
        return;
    }''')
# Dialogue text is still the original display list, scaled to fit the width.
replace('src/game/ingame_menu.c', '    } else if (gDialogID != DIALOG_NONE) {\n        // The Peach', '''    } else if (gDialogID != DIALOG_NONE) {
        if (GFX_DIMENSIONS_ASPECT_RATIO < 1.0f) {
            f32 scale = GFX_DIMENSIONS_ASPECT_RATIO / (4.0f / 3.0f);
            create_dl_translation_matrix(MENU_MTX_NOPUSH, 160 * (1 - scale), 160 * (1 - scale), 0);
            create_dl_scale_matrix(MENU_MTX_NOPUSH, scale, scale, 1);
        }
        // The Peach''')

replace('src/pc/djui/djui_button.c', 'struct DjuiButton* djui_button_create(', '''const char* web_button_text(struct DjuiBase* base) {
    return base->destroy == djui_button_destroy ? ((struct DjuiButton*)base)->text->message : NULL;
}
struct DjuiButton* djui_button_create(''')
replace('src/pc/djui/djui_panel_menu.c', 'f32 widthMultiplier = center ? DJUI_THEME_CENTERED_WIDTH : 1.0f;', 'f32 widthMultiplier = (configWindow.w < configWindow.h) ? 1.0f : (center ? DJUI_THEME_CENTERED_WIDTH : 1.0f);')
replace('src/pc/djui/djui_button.c', 'djui_base_set_size(base, 200, configDjuiThemeCenter ? 50 : 64);', 'djui_base_set_size(base, 200, configWindow.w < configWindow.h ? 72 : (configDjuiThemeCenter ? 50 : 64));')

replace('src/game/hud.c', '        bool showHud = (!gDjuiInMainMenu && !gOverrideHideHud);', '        extern int web_portrait_hud(void);\n        bool showHud = (!gDjuiInMainMenu && !gOverrideHideHud && !web_portrait_hud());')

copy_if_changed(root / 'engine/star_pointer.inc.c', source / 'src/menu/web_star_pointer.inc.h')
replace('src/menu/star_select.c', '#include "gfx_dimensions.h"', '#include <emscripten.h>\n#include "gfx_dimensions.h"')
star_source = source / 'src/menu/star_select.c'
if '#include "web_star_pointer.inc.h"' not in star_source.read_text():
    star_source.write_text(star_source.read_text() + '\n#include "web_star_pointer.inc.h"\n')
replace('src/pc/djui/djui_panel_pause.c', 'void djui_panel_pause_quit_yes(UNUSED struct DjuiBase* caller) {', 'extern void web_leave_lobby(void);\nvoid djui_panel_pause_quit_yes(UNUSED struct DjuiBase* caller) {\n    web_leave_lobby(); return;')
replace('src/pc/djui/djui_button.c', 'djui_base_set_size(base, 1.0f, configDjuiThemeCenter ? 50 : 64);', 'djui_base_set_size(base, 1.0f, configWindow.w < configWindow.h ? 72 : (configDjuiThemeCenter ? 50 : 64));')

# Optional bounded sound selection trace, disabled unless a browser probe enables it.
replace('src/audio/external.c', 'void play_sound(s32 soundBits, f32 *pos) {',
    'void play_sound(s32 soundBits, f32 *pos) {\n    extern void web_trace_sound(u32); web_trace_sound((u32)soundBits);')
# Converted banks retain the shipped 64-bit offsets/sizes even on wasm32.
# Keep their original pool budget so loading music cannot evict resident SFX.
replace('src/audio/data.h', '#define EXT_AUDIO_HEAP_SIZE', '''#ifdef __EMSCRIPTEN__
#define WEB_AUDIO_POOL_SIZE(size) ((size) * 2)
#else
#define WEB_AUDIO_POOL_SIZE(size) DOUBLE_SIZE_ON_64_BIT(size)
#endif
#define EXT_AUDIO_HEAP_SIZE''')
for audio_file in ['src/audio/data.c', 'src/audio/heap.c', 'src/buffers/buffers.c']:
    path = source / audio_file
    text = path.read_text()
    if 'DOUBLE_SIZE_ON_64_BIT(' in text:
        path.write_text(text.replace('DOUBLE_SIZE_ON_64_BIT(', 'WEB_AUDIO_POOL_SIZE('))
