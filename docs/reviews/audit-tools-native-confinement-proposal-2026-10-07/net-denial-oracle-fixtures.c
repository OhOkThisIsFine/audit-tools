// Offline observations of the exact classifier used by native-probe.c.
// These fixtures perform no socket/filesystem operation and prove no OS boundary.
#include <stdio.h>
#include "net-denial-oracle.h"
struct fixture {
    const char *name;
    int succeeded, err;
    enum r05_net_stage stage;
    int udp;
    enum r05_denial expected;
};
int main(void) {
    const struct fixture cases[] = {
        {"tcp_direct_no_route",0,ENETUNREACH,R05_CONNECT,0,R05_CONFINEMENT_REFUSAL},
        {"tcp_async_no_route",0,ENETUNREACH,R05_CONNECT_RESULT,0,R05_CONFINEMENT_REFUSAL},
        {"udp_connect_no_route",0,ENETUNREACH,R05_CONNECT,1,R05_CONFINEMENT_REFUSAL},
        {"udp_send_no_route",0,ENETUNREACH,R05_SEND,1,R05_CONFINEMENT_REFUSAL},
        {"tcp_poll_timeout",0,ETIMEDOUT,R05_POLL,0,R05_TIMEOUT},
        {"tcp_connect_timeout",0,ETIMEDOUT,R05_CONNECT,0,R05_TIMEOUT},
        {"socket_missing_ipv6",0,EAFNOSUPPORT,R05_SOCKET,0,R05_UNAVAILABLE},
        {"socket_missing_protocol",0,EPROTONOSUPPORT,R05_SOCKET,1,R05_UNAVAILABLE},
        {"connect_unsupported_family",0,EAFNOSUPPORT,R05_CONNECT,0,R05_UNAVAILABLE},
        {"send_unsupported_transport",0,EOPNOTSUPP,R05_SEND,1,R05_UNAVAILABLE},
        {"socket_policy_error",0,EPERM,R05_SOCKET,0,R05_UNEXPECTED_ERROR},
        {"socket_exhausted",0,EMFILE,R05_SOCKET,0,R05_UNEXPECTED_ERROR},
        {"socket_route_error_is_not_route_observation",0,ENETUNREACH,R05_SOCKET,0,R05_UNEXPECTED_ERROR},
        {"setup_error",0,EINVAL,R05_SETUP,0,R05_UNEXPECTED_ERROR},
        {"setup_route_error_is_not_route_observation",0,ENETUNREACH,R05_SETUP,0,R05_UNEXPECTED_ERROR},
        {"poll_route_error_is_not_route_observation",0,ENETUNREACH,R05_POLL,0,R05_UNEXPECTED_ERROR},
        {"poll_interrupted",0,EINTR,R05_POLL,0,R05_UNEXPECTED_ERROR},
        {"query_route_error_is_not_connect_result",0,ENETUNREACH,R05_SO_ERROR_QUERY,0,R05_UNEXPECTED_ERROR},
        {"query_error",0,EBADF,R05_SO_ERROR_QUERY,0,R05_UNEXPECTED_ERROR},
        {"connect_endpoint_absent",0,ECONNREFUSED,R05_CONNECT_RESULT,0,R05_UNEXPECTED_ERROR},
        {"connect_host_unreachable_is_not_selected_route_oracle",0,EHOSTUNREACH,R05_CONNECT,0,R05_UNEXPECTED_ERROR},
        {"connect_bad_argument",0,EINVAL,R05_CONNECT,0,R05_UNEXPECTED_ERROR},
        {"udp_buffer_error",0,ENOBUFS,R05_SEND,1,R05_UNEXPECTED_ERROR},
        {"tcp_send_no_route_is_not_selected_denial_stage",0,ENETUNREACH,R05_SEND,0,R05_UNEXPECTED_ERROR},
        {"tcp_success",1,0,R05_CONNECT,0,R05_UNEXPECTED_SUCCESS},
        {"udp_send_success",1,0,R05_SEND,1,R05_UNEXPECTED_SUCCESS},
        {"inconsistent_success_and_errno",1,ENETUNREACH,R05_CONNECT,0,R05_UNEXPECTED_SUCCESS},
        {"failed_without_errno",0,0,R05_CONNECT,0,R05_UNEXPECTED_ERROR},
    };
    unsigned failed = 0;
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; ++i) {
        const struct fixture *f = &cases[i];
        enum r05_denial actual = r05_classify_net_denial(f->succeeded,f->err,f->stage,f->udp);
        if (actual != f->expected) {
            fprintf(stderr,"%s: %s gave %s, expected %s\n",f->name,
                    r05_stage_name(f->stage),r05_denial_name(actual),r05_denial_name(f->expected));
            ++failed;
        }
        // Old oracle regression control: a failed operation alone was green.
        if (!f->succeeded && f->expected != R05_CONFINEMENT_REFUSAL && actual == R05_CONFINEMENT_REFUSAL)
            ++failed;
    }
    printf("R05 pure denial-oracle fixtures: %u failed of %zu\n",
           failed,sizeof cases / sizeof cases[0]);
    return failed ? 1 : 0;
}
