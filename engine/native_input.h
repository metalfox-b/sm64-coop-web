#ifndef SM64_NATIVE_INPUT_H
#define SM64_NATIVE_INPUT_H
#include <stdint.h>
#include <stddef.h>
struct RustInputFrame {
    uint16_t buttons;
    int8_t x, y, camera_x, camera_y;
    int32_t mouse_x, mouse_y;
};
_Static_assert(sizeof(struct RustInputFrame) == 16, "Rust input ABI size");
_Static_assert(offsetof(struct RustInputFrame, mouse_x) == 8, "Rust input ABI offset");
void sm64_rust_input_set(uint16_t, int8_t, int8_t, int8_t, int8_t, int32_t, int32_t);
void sm64_rust_input_tick(struct RustInputFrame*);
void sm64_rust_gesture(uint32_t, uint32_t);
int32_t sm64_rust_mouse(uint32_t);
void sm64_rust_input_reset(void);
uint32_t sm64_rust_adapter_version(void);
#endif
