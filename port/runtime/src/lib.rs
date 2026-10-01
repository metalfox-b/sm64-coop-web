//! Actual translated original SM64 physics/actions, plus the native input ABI.
//! Renderer, audio, objects and other unported systems still come from the
//! comparison engine while this incremental port is validated.
pub use physics as original;
pub use sm64_native_adapter as input;
