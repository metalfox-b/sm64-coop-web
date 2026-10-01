//! Native Rust input boundary for the original Coop Deluxe engine.
//! This adapter does not replace or approximate Mario's action/physics code.
#![deny(unsafe_op_in_unsafe_fn)]


// Rust and Emscripten must share one allocator; two independent Wasm heaps
// starting at __heap_base would eventually overwrite each other's objects.
#[cfg(target_arch = "wasm32")]
mod allocator {
    use std::alloc::{GlobalAlloc, Layout};
    unsafe extern "C" {
        fn aligned_alloc(alignment: usize, size: usize) -> *mut u8;
        fn free(pointer: *mut u8);
    }
    struct SharedHeap;
    unsafe impl GlobalAlloc for SharedHeap {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align().max(16);
            let Some(size) = layout.size().max(1).checked_add(align - 1) else {
                return core::ptr::null_mut();
            };
            unsafe { aligned_alloc(align, size & !(align - 1)) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, _: Layout) {
            unsafe { free(pointer) }
        }
    }
    #[global_allocator]
    static HEAP: SharedHeap = SharedHeap;
}

const A: u16 = 0x8000;
const B: u16 = 0x4000;
const Z: u16 = 0x2000;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputFrame {
    pub buttons: u16,
    pub x: i8,
    pub y: i8,
    pub camera_x: i8,
    pub camera_y: i8,
    pub mouse_x: i32,
    pub mouse_y: i32,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct InputState {
    frame: InputFrame,
    gesture: u32,
    phase: u8,
    ticks: u32,
}
impl InputState {
    pub const fn new() -> Self {
        Self {
            frame: InputFrame {
                buttons: 0,
                x: 0,
                y: 0,
                camera_x: 0,
                camera_y: 0,
                mouse_x: 0,
                mouse_y: 0,
            },
            gesture: 0,
            phase: 0,
            ticks: 0,
        }
    }
    pub fn set(&mut self, frame: InputFrame) {
        let mx = self.frame.mouse_x.saturating_add(frame.mouse_x);
        let my = self.frame.mouse_y.saturating_add(frame.mouse_y);
        self.frame = frame;
        self.frame.mouse_x = mx;
        self.frame.mouse_y = my;
    }
    pub fn gesture(&mut self, action: u32, airborne: bool) {
        if action > 4 || (action == 3 && !airborne) {
            return;
        }
        self.gesture = action;
        self.phase = 0;
    }
    pub fn tick(&mut self) -> InputFrame {
        self.ticks = self.ticks.wrapping_add(1);
        let mut frame = self.frame;
        match self.gesture {
            1 => frame.buttons |= A,
            2 => frame.buttons |= B,
            3 => frame.buttons |= Z,
            4 => {
                frame.buttons = (frame.buttons & !A) | Z;
                if self.phase >= 2 {
                    frame.buttons |= A;
                }
            }
            _ => return frame,
        }
        self.phase += 1;
        if self.phase >= if self.gesture == 4 { 7 } else { 5 } {
            self.gesture = 0;
        }
        frame
    }
    pub fn take_mouse(&mut self, y: bool) -> i32 {
        core::mem::take(if y {
            &mut self.frame.mouse_y
        } else {
            &mut self.frame.mouse_x
        })
    }
}
// The browser runtime is deliberately single threaded. This state is owned by
// its one simulation thread; no exported callback invokes another concurrently.
static mut INPUT: InputState = InputState::new();
#[unsafe(no_mangle)]
pub extern "C" fn sm64_rust_input_set(
    buttons: u16,
    x: i8,
    y: i8,
    cx: i8,
    cy: i8,
    mx: i32,
    my: i32,
) {
    unsafe {
        (&mut *core::ptr::addr_of_mut!(INPUT)).set(InputFrame {
            buttons,
            x,
            y,
            camera_x: cx,
            camera_y: cy,
            mouse_x: mx,
            mouse_y: my,
        });
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn sm64_rust_gesture(action: u32, airborne: u32) {
    unsafe {
        (&mut *core::ptr::addr_of_mut!(INPUT)).gesture(action, airborne != 0);
    }
}
/// # Safety
/// `out` must point to one writable, aligned InputFrame in the same Wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm64_rust_input_tick(out: *mut InputFrame) {
    if !out.is_null() {
        unsafe {
            out.write((&mut *core::ptr::addr_of_mut!(INPUT)).tick());
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn sm64_rust_mouse(y: u32) -> i32 {
    unsafe { (&mut *core::ptr::addr_of_mut!(INPUT)).take_mouse(y != 0) }
}
#[unsafe(no_mangle)]
pub extern "C" fn sm64_rust_input_reset() {
    unsafe {
        core::ptr::addr_of_mut!(INPUT).write(InputState::new());
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn sm64_rust_adapter_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_jump_has_two_crouch_ticks_before_jump() {
        let mut s = InputState::new();
        s.set(InputFrame {
            x: 60,
            y: 40,
            ..Default::default()
        });
        s.gesture(4, false);
        let frames: std::vec::Vec<_> = (0..8).map(|_| s.tick()).collect();
        assert_eq!(
            frames
                .iter()
                .map(|f| f.buttons)
                .collect::<std::vec::Vec<_>>(),
            [Z, Z, Z | A, Z | A, Z | A, Z | A, Z | A, 0]
        );
        assert!(frames.iter().all(|f| f.x == 60 && f.y == 40));
    }
    #[test]
    fn short_gesture_survives_many_render_updates_before_simulation() {
        let mut s = InputState::new();
        s.gesture(1, false);
        for _ in 0..20 {
            s.set(InputFrame::default());
        }
        for _ in 0..5 {
            assert_eq!(s.tick().buttons, A);
        }
        assert_eq!(s.tick().buttons, 0);
    }
    #[test]
    fn airborne_guard_and_cancel() {
        let mut s = InputState::new();
        s.gesture(3, false);
        assert_eq!(s.tick().buttons, 0);
        s.gesture(3, true);
        assert_eq!(s.tick().buttons, Z);
        s.gesture(0, false);
        assert_eq!(s.tick().buttons, 0);
    }
    #[test]
    fn mouse_deltas_accumulate_and_are_consumed_once() {
        let mut s = InputState::new();
        for _ in 0..3 {
            s.set(InputFrame {
                mouse_x: 7,
                mouse_y: -3,
                ..Default::default()
            });
        }
        assert_eq!(s.take_mouse(false), 21);
        assert_eq!(s.take_mouse(true), -9);
        assert_eq!(s.take_mouse(false), 0);
    }
    #[test]
    fn abi_layout() {
        assert_eq!(core::mem::size_of::<InputFrame>(), 16);
        assert_eq!(core::mem::offset_of!(InputFrame, mouse_x), 8);
    }
}
