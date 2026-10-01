// Included in original star_select.c: retain its progression/unlock semantics.
EMSCRIPTEN_KEEPALIVE void web_star_choose(int index, int confirm) {
    if (!web_star_active() || index < 0 || index >= sVisibleStars) return;
    u8 stars = save_file_get_star_flags(gCurrSaveFileNum - 1, gCurrCourseNum - 1);
    if (!(stars & (1 << index)) && index + 1 != sInitSelectedActNum) return;
    int selectable = 0;
    for (int i = 0; i < index; i++) if ((stars & (1 << i)) || i + 1 == sInitSelectedActNum) selectable++;
    sSelectableStarIndex = selectable; sSelectedActIndex = index;
    if (confirm && sActSelectorMenuTimer >= 11) star_select_finish_selection();
}
EMSCRIPTEN_KEEPALIVE void web_star_snapshot(void) {
    EM_ASM({ Module.webStars = []; });
    if (!web_star_active()) return;
    u8 stars = save_file_get_star_flags(gCurrSaveFileNum - 1, gCurrCourseNum - 1);
    for (int i = 0; i < sVisibleStars; i++) {
        const u8* name = get_star_name_sm64(gCurrCourseNum, i + 1, 1);
        char* text = name ? convert_string_sm64_to_ascii(NULL, name) : NULL;
        EM_ASM({ Module.webStars.push({index:$0,label:$1?UTF8ToString($1):'Star '+($0+1),collected:!!$2,enabled:!!$3,selected:!!$4}); },
            i, text, stars & (1 << i), sActSelectorMenuTimer >= 11 && ((stars & (1 << i)) || i + 1 == sInitSelectedActNum), sSelectedActIndex == i);
        free(text);
    }
}
