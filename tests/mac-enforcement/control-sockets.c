#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
    if (argc < 2 || argc > 13) return 2;
#ifdef AF_VSOCK
    int vsock_family = AF_VSOCK;
#else
    int vsock_family = -1;
#endif
    printf("{\"afVsockFromSDK\":%d,\"sockInfoVsockFromSDK\":%d,\"streamTypeFromSDK\":%d,\"processes\":[", vsock_family, SOCKINFO_VSOCK, SOCK_STREAM);
    for (int index = 1; index < argc; index++) {
        char *end = NULL;
        long parsed = strtol(argv[index], &end, 10);
        if (!end || *end || parsed < 2 || parsed > 2147483647) return 2;
        pid_t pid = (pid_t)parsed;
        if (index > 1) printf(",");
        struct proc_bsdinfo before;
        memset(&before, 0, sizeof(before));
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before)) {
            printf("{\"pid\":%d,\"identityErrno\":%d}", pid, errno);
            continue;
        }
        int required = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
        if (required <= 0 || required > 1048576) {
            printf("{\"pid\":%d,\"listErrno\":%d}", pid, errno);
            continue;
        }
        int capacity = required + 64 * sizeof(struct proc_fdinfo);
        struct proc_fdinfo *fds = calloc(1, capacity);
        if (!fds) return 3;
        int count = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
        if (count <= 0 || count >= capacity || count % sizeof(struct proc_fdinfo)) {
            printf("{\"pid\":%d,\"snapshotErrno\":%d}", pid, errno);
            free(fds);
            continue;
        }
        printf("{\"pid\":%d,\"parentPID\":%u,\"uid\":%u,\"birthSeconds\":%llu,\"birthMicroseconds\":%llu,\"sockets\":[",
               pid, before.pbi_ppid, before.pbi_uid, (unsigned long long)before.pbi_start_tvsec,
               (unsigned long long)before.pbi_start_tvusec);
        int first = 1;
        for (int item = 0; item < count / (int)sizeof(struct proc_fdinfo); item++) {
            if (fds[item].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
            if (!first) printf(",");
            first = 0;
            struct socket_fdinfo socket;
            memset(&socket, 0, sizeof(socket));
            int length = proc_pidfdinfo(pid, fds[item].proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket));
            if (length != (int)sizeof(socket)) {
                printf("{\"fd\":%d,\"inspectionErrno\":%d}", fds[item].proc_fd, errno);
                continue;
            }
            printf("{\"fd\":%d,\"family\":%d,\"type\":%d,\"protocol\":%d,\"kind\":%d,\"state\":%d,\"connected\":%s",
                   fds[item].proc_fd, socket.psi.soi_family, socket.psi.soi_type, socket.psi.soi_protocol,
                   socket.psi.soi_kind, socket.psi.soi_state,
                   (socket.psi.soi_state & SOI_S_ISCONNECTED) ? "true" : "false");
            if (socket.psi.soi_kind == SOCKINFO_VSOCK) {
                struct vsock_sockinfo *vm = &socket.psi.soi_proto.pri_vsock;
                printf(",\"localCID\":%u,\"localPort\":%u,\"remoteCID\":%u,\"remotePort\":%u",
                       vm->local_cid, vm->local_port, vm->remote_cid, vm->remote_port);
            }
            printf("}");
        }
        struct proc_bsdinfo after;
        memset(&after, 0, sizeof(after));
        int stable = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) == (int)sizeof(after) &&
                     before.pbi_start_tvsec == after.pbi_start_tvsec && before.pbi_start_tvusec == after.pbi_start_tvusec &&
                     before.pbi_uid == after.pbi_uid && before.pbi_ppid == after.pbi_ppid;
        printf("],\"identityStable\":%s}", stable ? "true" : "false");
        free(fds);
    }
    printf("]}\n");
    return 0;
}
