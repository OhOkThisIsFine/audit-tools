// Synthetic qualification helper only; no product code or provider access.
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static int verdict(const char *op, int ok, int err, int expect_ok) {
    printf("{\"operation\":\"%s\",\"succeeded\":%s,\"errno\":%d}\n",
           op, ok ? "true" : "false", err);
    return ok == expect_ok ? 0 : 1;
}
int main(int argc, char **argv) {
    if (argc < 4) return 2;
    int expect_ok = strcmp(argv[argc - 1], "allow") == 0;
    if (strcmp(argv[1], "read") == 0 || strcmp(argv[1], "write") == 0) {
        int reading = strcmp(argv[1], "read") == 0;
        int fd = open(argv[2], reading ? O_RDONLY : O_WRONLY | O_CREAT | O_EXCL, 0600);
        int err = fd < 0 ? errno : 0;
        int ok = fd >= 0;
        if (ok) {
            char bytes[32];
            ssize_t n = reading ? read(fd, bytes, sizeof bytes) :
                write(fd, "R05 synthetic marker\n", 21);
            if (n < 0) { ok = 0; err = errno; }
            close(fd);
        }
        return verdict(argv[1], ok, err, expect_ok);
    }
    if (strcmp(argv[1], "family") == 0) {
        int domain = atoi(argv[2]);
        int fd = socket(domain, SOCK_STREAM, 0), err = fd < 0 ? errno : 0;
        if (fd >= 0) close(fd);
        // A policy denial must be EPERM, not merely missing kernel support.
        if (!expect_ok && err != EPERM) return 1;
        return verdict("family", fd >= 0, err, expect_ok);
    }
    if (strcmp(argv[1], "net") != 0 || argc != 8) return 2;
    int family = strcmp(argv[2], "4") == 0 ? AF_INET : AF_INET6;
    int type = strcmp(argv[3], "tcp") == 0 ? SOCK_STREAM : SOCK_DGRAM;
    struct sockaddr_storage addr; memset(&addr, 0, sizeof addr);
    socklen_t len;
    if (family == AF_INET) {
        struct sockaddr_in *a = (struct sockaddr_in *)&addr;
        a->sin_family = AF_INET; a->sin_port = htons((unsigned short)atoi(argv[5]));
        if (inet_pton(AF_INET, argv[4], &a->sin_addr) != 1) return 2;
        len = sizeof *a;
    } else {
        struct sockaddr_in6 *a = (struct sockaddr_in6 *)&addr;
        a->sin6_family = AF_INET6; a->sin6_port = htons((unsigned short)atoi(argv[5]));
        if (inet_pton(AF_INET6, argv[4], &a->sin6_addr) != 1) return 2;
        len = sizeof *a;
    }
    int fd = socket(family, type, 0);
    if (fd < 0) return verdict("net", 0, errno, expect_ok);
    if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0) { close(fd); return 2; }
    int rc = connect(fd, (struct sockaddr *)&addr, len), err = rc < 0 ? errno : 0;
    if (rc < 0 && err == EINPROGRESS) {
        struct pollfd p = {fd, POLLOUT, 0};
        rc = poll(&p, 1, 1500);
        if (rc > 0) {
            socklen_t size = sizeof err;
            if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &size) < 0) err = errno;
        } else err = rc == 0 ? ETIMEDOUT : errno;
    }
    int connected = err == 0;
    if (!expect_ok) {
        // Denial oracle is inability to connect/send, not absence of echo.
        if (connected && type == SOCK_DGRAM) {
            ssize_t sent = send(fd, argv[6], strlen(argv[6]), 0);
            if (sent < 0) { connected = 0; err = errno; }
        }
        close(fd);
        return verdict("net", connected, err, 0);
    }
    int ok = connected;
    if (ok) {
        size_t wanted = strlen(argv[6]);
        if (send(fd, argv[6], wanted, 0) != (ssize_t)wanted) { ok = 0; err = errno; }
        else {
            struct pollfd p = {fd, POLLIN, 0};
            rc = poll(&p, 1, 1500);
            char reply[128];
            ssize_t n = rc > 0 ? recv(fd, reply, sizeof reply, 0) : -1;
            size_t got = n > 0 ? (size_t)n : 0;
            while (type == SOCK_STREAM && got > 0 && got < wanted) {
                p.revents = 0;
                rc = poll(&p, 1, 1500);
                n = rc > 0 ? recv(fd, reply + got, sizeof reply - got, 0) : -1;
                if (n <= 0) break;
                got += (size_t)n;
            }
            ok = got == wanted && memcmp(reply, argv[6], wanted) == 0;
            if (!ok) err = rc == 0 ? ETIMEDOUT : (errno ? errno : EPROTO);
        }
    }
    close(fd);
    return verdict("net", ok, err, 1);
}
