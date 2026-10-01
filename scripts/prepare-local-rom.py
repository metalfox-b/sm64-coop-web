"""Read each player's local ROM from the browser filesystem, never the server."""
from pathlib import Path
source=Path(__file__).resolve().parent.parent/'vendor/coopdx'
p=source/'src/pc/rom_checker.cpp';s=p.read_text()
old='bool main_rom_handler(void) {'
new='''bool main_rom_handler(void) {
#ifdef __EMSCRIPTEN__
    // The client validates the player's ROM before the engine is started.
    snprintf(gRomFilename, SYS_MAX_PATH, "/coop/player.z64");
    gRomIsValid = fs_sys_file_exists(gRomFilename);
    return gRomIsValid;
#endif'''
if new not in s:
    assert s.count(old)==1
    p.write_text(s.replace(old,new))
