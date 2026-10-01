"""Export the real CoopDX build as a wasm32 C2Rust compilation database.

No approximate gameplay is generated here. Clang sees the pinned game's own
preprocessor configuration, headers, struct layouts and source functions.
"""
import hashlib, json, os, shlex, subprocess, shutil
from pathlib import Path
root=Path(__file__).resolve().parent.parent
source=root/'vendor/coopdx'
out=root/'private/source-port'
out.mkdir(parents=True,exist_ok=True)
makefile=out/'commands.mk'
makefile.write_text('''.PHONY: export-translation
export-translation:
\t@$(foreach file,$(C_FILES),$(info TRANSLATE $(CC) $(PROF_FLAGS) -c $(CFLAGS) -o $(BUILD_DIR)/$(file:.c=.o) $(file))) true
''')
result=subprocess.run(['make','-s','-f','Makefile','-f',str(makefile),'export-translation','HOST_OS=Web','TARGET_BITS=32','DISCORD_SDK=0','COOPNET=0','UPDATER=0','ICON=0','USE_APP=0','COMPILER=clang','DEBUG_INFO_LEVEL=0'],cwd=source,capture_output=True,text=True,check=True)
sysroot=root/'vendor/emscripten-cache/sysroot'
clang=os.environ.get('SM64_PORT_CLANG') or shutil.which('clang') or 'clang'
database=[]
inventory=[]
for line in result.stdout.splitlines():
    if not line.startswith('TRANSLATE '):continue
    args=shlex.split(line[len('TRANSLATE '):]);file=args[-1]
    # Lua, libc and browser OS glue are separate platform dependencies. All SM64
    # engine/game/level/object/audio C units are listed, including included .inc.c.
    if not file.startswith(('src/','actors/','levels/','data/','sound/')):continue
    flags=[a for a in args[1:] if not a.startswith('-sUSE_')]
    command=[clang,'--target=wasm32-unknown-emscripten','--sysroot='+str(sysroot),'-isystem',str(sysroot/'include/SDL2'),'-isystem',str(sysroot/'include'),'-Xclang','-iwithsysroot/include/compat','-std=gnu11',*flags]
    database.append({'directory':str(source),'file':str(source/file),'arguments':command})
    inventory.append({'source':file,'sha256':hashlib.sha256((source/file).read_bytes()).hexdigest(),'group':'game' if file.startswith(('src/game/','src/engine/','levels/','actors/')) else 'platform'})
(out/'compile_commands.json').write_text(json.dumps(database,indent=2))
(out/'source-inventory.json').write_text(json.dumps({'reference':'Coop Deluxe v1.5.1','target':'wasm32-unknown-emscripten','units':inventory},indent=2)+'\n')
math=[c for c in database if c['file'].endswith('/src/engine/math_util.c')]
(out/'math_commands.json').write_text(json.dumps(math,indent=2))
print(f'Captured {len(database)} original translation units; compiler database stays private.')
