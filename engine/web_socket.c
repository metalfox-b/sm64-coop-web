#include "pc/network/socket/socket.h"
#include "pc/configfile.h"
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

char gGetHostName[MAX_CONFIG_STRING] = "relay";
static u32 sAddresses[MAX_PLAYERS];
static u32 sIncomingAddress;

EM_JS(int, bridge_send, (u32 target, const u8* data, u16 length), {
    return Module.coopBridge.send(target, HEAPU8.subarray(data, data + length));
});
EM_JS(u32, bridge_host, (), { return Module.coopBridge.host; });
EM_JS(u32, bridge_id, (), { return Module.coopBridge.id; });

EMSCRIPTEN_KEEPALIVE void web_receive(u32 sender, u8* data, u16 length) {
    if (gNetworkType == NT_NONE || length >= PACKET_LENGTH) return;
    u8 localIndex = UNKNOWN_LOCAL_INDEX;
    for (int i = 1; i < MAX_PLAYERS; i++) {
        if (sAddresses[i] == sender) { localIndex = i; break; }
    }
    sIncomingAddress = sender;
    network_receive(localIndex, &sIncomingAddress, data, length);
}
static bool initialize(enum NetworkType type, bool reconnecting) {
    memset(sAddresses, 0, sizeof(sAddresses));
    sIncomingAddress = bridge_host();
    if (type == NT_CLIENT) {
        gNetworkType = NT_CLIENT;
        network_send_mod_list_request();
    }
    return true;
}
static s64 get_id(u8 index) { return index ? sAddresses[index] : bridge_id(); }
static char* get_id_str(u8 index) {
    static char value[32]; snprintf(value, sizeof(value), "%u", index ? sAddresses[index] : sIncomingAddress); return value;
}
static void save_id(u8 index, s64 id) { if (index && index < MAX_PLAYERS) sAddresses[index] = sIncomingAddress; }
static void clear_id(u8 index) { if (index < MAX_PLAYERS) sAddresses[index] = 0; }
static void* dup_addr(u8 index) { u32* addr = malloc(sizeof(u32)); *addr = index ? sAddresses[index] : sIncomingAddress; return addr; }
static bool match_addr(void* a, void* b) { return *(u32*)a == *(u32*)b; }
static void update(void) {}
static int send_packet(u8 index, void* address, u8* data, u16 length) {
    u32 target = index ? sAddresses[index] : (address ? *(u32*)address : bridge_host());
    return bridge_send(target, data, length) ? 0 : -1;
}
static void lobby(char* output, u32 length) { snprintf(output, length, "activity"); }
static void web_shutdown(bool reconnecting) { memset(sAddresses, 0, sizeof(sAddresses)); }
struct NetworkSystem gNetworkSystemSocket = {
    .initialize=initialize, .get_id=get_id, .get_id_str=get_id_str, .save_id=save_id,
    .clear_id=clear_id, .dup_addr=dup_addr, .match_addr=match_addr, .update=update,
    .send=send_packet, .get_lobby_id=lobby, .get_lobby_secret=lobby, .shutdown=web_shutdown,
    .requireServerBroadcast=true, .name="Activity Relay",
};
