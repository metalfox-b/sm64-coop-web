# Included after upstream source/flag discovery, before its target rules.
EMCC ?= emcc
EMXX ?= em++
CC := $(EMCC)
CC_CHECK := $(EMCC)
CXX := $(EMXX)
LD := $(EMXX)
CPP := $(EMCC) -E -P -x c
CP := cp
EXE := $(BUILD_DIR)/sm64.js
EXTRA_CPP_FLAGS := -std=c++17
EXTRA_CPP_INCLUDES :=
BACKEND_CFLAGS := -sUSE_SDL=2 -sUSE_ZLIB=1 -DUSE_GLES=1 -DHAVE_SDL2=1
SRC_DIRS += lib/lua/src
CFLAGS := -O2 -g0 -DNDEBUG $(DEF_INC_CFLAGS) $(BACKEND_CFLAGS) -D_LANGUAGE_C -fno-strict-aliasing -fwrapv -Wno-incompatible-function-pointer-types -Wno-int-conversion -Wno-deprecated-non-prototype -Wno-format -Wno-macro-redefined
CC_CHECK_CFLAGS := $(CFLAGS) -fsyntax-only
CPPFLAGS := -P -Wno-trigraphs $(DEF_INC_CFLAGS)
ifeq ($(RUST_PHYSICS),1)
RUST_ARCHIVE := ../../port/runtime/target/wasm32-unknown-unknown/release/libsm64_original_runtime.a
C_FILES := $(filter-out src/engine/math_util.c src/engine/surface_collision.c src/engine/surface_load.c src/game/mario.c src/game/mario_step.c src/game/mario_actions_%,$(C_FILES))
else
RUST_ARCHIVE := ../../target/wasm32-unknown-unknown/release/libsm64_native_adapter.a
endif
LDFLAGS := -O2 --profiling-funcs --emit-symbol-map -sUSE_SDL=2 -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=2097152 -sENVIRONMENT=web -sMODULARIZE=1 -sEXPORT_NAME=createSM64 -sEXPORT_ES6=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sINCOMING_MODULE_JS_API=canvas,wasmBinary,locateFile,print,printErr,onAbort,noInitialRun,preRun,postRun,arguments,onRuntimeInitialized -sMIN_WEBGL_VERSION=1 -sMAX_WEBGL_VERSION=2 -sFILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain,UTF8ToString,HEAPU8 -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_web_receive,_web_input,_web_read_input,_web_mouse_x,_web_mouse_y,_web_save_snapshot,_web_reload_save,_web_diagnostics,_web_resize,_web_stop,_web_mute,_web_ui_state,_web_menu,_web_pointer,_web_action,_web_airborne,_web_player_action,_web_hovered,_web_rust_adapter_version -sASSERTIONS=1 $(RUST_ARCHIVE) --preload-file lang@/coop/lang -lm
C_FILES := $(filter-out src/pc/network/socket/socket_linux.c src/pc/network/socket/socket_windows.c,$(C_FILES))
C_FILES += $(filter-out lib/lua/src/lua.c lib/lua/src/luac.c,$(wildcard lib/lua/src/*.c))
O_FILES := $(foreach file,$(C_FILES),$(BUILD_DIR)/$(file:.c=.o)) $(foreach file,$(CPP_FILES),$(BUILD_DIR)/$(file:.cpp=.o)) $(foreach file,$(S_FILES),$(BUILD_DIR)/$(file:.s=.o)) $(foreach file,$(GENERATED_C_FILES),$(file:.c=.o))

# Changing browser compiler flags must invalidate existing native object files.
$(O_FILES) $(ULTRA_O_FILES) $(GODDARD_O_FILES): ../../engine/web.mk
$(EXE): ../../engine/web.mk ../../scripts/prepare-engine.py

$(EXE): $(RUST_ARCHIVE)
