"""Modern stable Rust for pointer-only opaque declarations from C2Rust.

Fail closed if an opaque C type is used by value, sized, or otherwise referenced.
No gameplay expressions or layouts of complete structs are changed here.
"""
from pathlib import Path
import re, sys
root=Path(sys.argv[1]).resolve()
count=0
for path in (root/'src').rglob('*.rs'):
    source=path.read_text();names=re.findall(r'^    pub type (\w+);$',source,re.M)
    for name in names:
        declaration=r'    pub type '+name+r';\n'
        without=re.sub(declaration,'',source)
        without_pointers=re.sub(r'\*(?:mut|const) '+name+r'\b','*mut core::ffi::c_void',without)
        if re.search(r'\b'+name+r'\b',without_pointers):
            raise RuntimeError(f'Opaque type requires review: {path}: {name}')
        source=without
    if names:
        opaque=''.join(f'#[repr(C)]\npub struct {name} {{ _opaque: [u8; 0] }}\n' for name in names)
        source=opaque+source;count+=len(names)
    if path.name == 'math_util.rs':
        # These three definitions are external inline functions in math_util.c,
        # unlike the static inline vector helpers from its header. C2Rust emits
        # them as private functions, losing the symbols used by other units.
        for name in ('sins', 'coss', 'atan2s'):
            old=f'unsafe extern "C" fn {name}('
            if source.count(old) != 1:
                raise RuntimeError(f'Expected one translated definition: {name}')
            source=source.replace(old, f'#[no_mangle]\npub unsafe extern "C" fn {name}(')
    path.write_text(source)
lib=root/'lib.rs'
text=lib.read_text().replace('#![feature(extern_types)]\n','').replace('#![feature(raw_ref_op)]\n','')
lib.write_text(text)
(root/'rust-toolchain.toml').write_text('[toolchain]\nchannel = "1.99.0"\ntargets = ["wasm32-unknown-unknown"]\n')
print(f'Modernized {count} pointer-only opaque declarations; gameplay expressions unchanged.')
