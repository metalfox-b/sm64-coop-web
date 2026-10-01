"""Checked GLSL ES 1.00 fixes for the preserved CoopDX browser baseline."""
from pathlib import Path
path = Path(__file__).resolve().parent.parent / 'vendor/coopdx/src/pc/gfx/gfx_opengl.c'
text = path.read_text()
for before, after in [
    ('(uShaderFlagValues[4] - 2) * texel.rgb', '(uShaderFlagValues[4] - 2.0) * texel.rgb'),
    ('int levels = int(max(1.0, uShaderFlagValues[6]));', 'float levels = floor(max(1.0, uShaderFlagValues[6]));'),
]:
    if after in text: continue
    if text.count(before) != 1: raise RuntimeError('Upstream shader anchor changed: ' + before)
    text = text.replace(before, after)
path.write_text(text)
print('Applied GLSL ES numeric type corrections.')
