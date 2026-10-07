// Pure classification only; ENETUNREACH must come from the actual route operation.
#ifndef R05_NET_DENIAL_ORACLE_H
#define R05_NET_DENIAL_ORACLE_H
#include <errno.h>

enum r05_net_stage {
    R05_SOCKET, R05_SETUP, R05_CONNECT, R05_CONNECT_RESULT,
    R05_POLL, R05_SO_ERROR_QUERY, R05_SEND
};
enum r05_denial {
    R05_CONFINEMENT_REFUSAL, R05_UNEXPECTED_SUCCESS, R05_UNEXPECTED_ERROR,
    R05_TIMEOUT, R05_UNAVAILABLE
};
static enum r05_denial r05_classify_net_denial(
    int succeeded, int err, enum r05_net_stage stage, int udp) {
    if (succeeded) return R05_UNEXPECTED_SUCCESS;
    if (err == ETIMEDOUT) return R05_TIMEOUT;
    if (err == EAFNOSUPPORT || err == EPROTONOSUPPORT || err == EOPNOTSUPP)
        return R05_UNAVAILABLE;
    // The selected network-none route is absent. Socket/fcntl/poll/query
    // failures, ECONNREFUSED, EHOSTUNREACH and policy errors are not this oracle.
    if (err == ENETUNREACH &&
        (stage == R05_CONNECT || stage == R05_CONNECT_RESULT ||
         (stage == R05_SEND && udp)))
        return R05_CONFINEMENT_REFUSAL;
    return R05_UNEXPECTED_ERROR;
}
static const char *r05_denial_name(enum r05_denial value) {
    switch (value) {
        case R05_CONFINEMENT_REFUSAL: return "confinement_refusal";
        case R05_UNEXPECTED_SUCCESS: return "unexpected_success";
        case R05_TIMEOUT: return "timeout";
        case R05_UNAVAILABLE: return "unavailable";
        default: return "unexpected_error";
    }
}
static const char *r05_stage_name(enum r05_net_stage value) {
    switch (value) {
        case R05_SOCKET: return "socket";
        case R05_SETUP: return "setup";
        case R05_CONNECT: return "connect";
        case R05_CONNECT_RESULT: return "connect_result";
        case R05_POLL: return "poll";
        case R05_SO_ERROR_QUERY: return "so_error_query";
        default: return "send";
    }
}
#endif
