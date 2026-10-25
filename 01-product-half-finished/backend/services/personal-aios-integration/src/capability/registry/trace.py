"""Linux syscall evidence from a parent tracer, outside the package chroot."""
import ctypes
import json
import os
import resource  # Load before chroot hides a non-system interpreter's extension directory.
import signal
import struct
import sys


def drop_privileges():
    libc = ctypes.CDLL(None, use_errno=True)
    # Locked no-root semantics prevent exec of a root-owned binary restoring capabilities.
    if libc.prctl(28, 1 | 2 | 4 | 8, 0, 0, 0) or libc.prctl(38, 1, 0, 0, 0):
        raise OSError('cannot restrict package privileges')
    for capability in range(41):
        if libc.prctl(24, capability, 0, 0, 0):
            raise OSError('cannot drop package capability')
    seccomp = ctypes.CDLL('libseccomp.so.2')
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    policy = seccomp.seccomp_init(0x7fff0000)
    if not policy:
        raise OSError('cannot initialize package syscall policy')
    try:
        for name in (b'unshare', b'setns', b'mount', b'umount2', b'pivot_root', b'chroot', b'ptrace',
                     b'process_vm_writev', b'io_uring_setup', b'io_uring_enter', b'io_uring_register',
                     b'bpf', b'open_by_handle_at', b'clone3'):
            number = seccomp.seccomp_syscall_resolve_name(name)
            if number < 0 or seccomp.seccomp_rule_add(policy, 0x00050000 | 38, number, 0):
                raise OSError('cannot restrict package syscall')
        if seccomp.seccomp_load(policy):
            raise OSError('cannot load package syscall policy')
    finally:
        seccomp.seccomp_release(policy)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 << 20, 16 << 20))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def trace(command, root, audit):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.ptrace.restype = ctypes.c_long
    seccomp = ctypes.CDLL('libseccomp.so.2')
    seccomp.seccomp_arch_native.restype = ctypes.c_uint32
    native_arch = seccomp.seccomp_arch_native()
    syscall = lambda name: seccomp.seccomp_syscall_resolve_name(name.encode())
    opens = {syscall('open'): (0, 1), syscall('openat'): (1, 2), syscall('creat'): (0, None)}
    mutations = {syscall(name): index for index, names in [(0,
        'truncate rename mkdir rmdir link unlink symlink chmod chown lchown mknod utime utimes setxattr lsetxattr removexattr lremovexattr'), (1,
        'mkdirat mknodat fchownat unlinkat renameat linkat symlinkat fchmodat utimensat renameat2 futimesat')]
        for name in names.split()}
    fd_writes = {syscall(name) for name in 'write pwrite64 writev pwritev pwritev2 ftruncate fchmod fchown fallocate fsetxattr fremovexattr'.split()}
    sockets = {syscall('socket'), syscall('socketpair')}

    def ptrace(op, pid, addr=0, data=0):
        ctypes.set_errno(0)
        value = libc.ptrace(op, pid, ctypes.c_void_p(addr), data if hasattr(data, '_obj') else ctypes.c_void_p(data))
        if value == -1 and ctypes.get_errno():
            if op == 24 and ctypes.get_errno() == 3:
                return 0  # A sibling's exit_group can reap a stopped thread before resume.
            raise OSError(ctypes.get_errno(), 'ptrace')
        return value

    def string(pid, address):
        data = bytearray()
        try:
            for offset in range(0, 4096, 8):
                part = ptrace(2, pid, address + offset).to_bytes(8, sys.byteorder, signed=True)
                data.extend(part.split(b'\0', 1)[0])
                if b'\0' in part:
                    break
        except OSError:
            pass
        return data.decode('utf8', 'replace')

    child = os.fork()
    if child == 0:
        try:
            ptrace(0, 0)
            os.kill(os.getpid(), signal.SIGSTOP)
            os.chroot(root)
            os.chdir('/work')
            drop_privileges()
            os.execvpe(command[0], command, {
                'PATH': '/opt/node/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': '/work',
                'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': '/opt/yimi:/opt/deps',
                'LANG': 'C.UTF-8', 'OUT': '/work', 'TMPDIR': '/work',
            })
        except BaseException:
            os._exit(127)
    os.waitpid(child, 0)
    ptrace(0x4200, child, 0, 1 | 2 | 4 | 8 | 0x100000)  # syscall stops, fork/vfork/clone, EXITKILL
    ptrace(24, child)
    writes, network = set(), set()
    status_code = 1
    while True:
        try:
            pid, status = os.waitpid(-1, 0x40000000)
        except ChildProcessError:
            break
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            if pid == child:
                status_code = os.waitstatus_to_exitcode(status)
            continue
        stopped = os.WSTOPSIG(status)
        if status >> 16:
            ptrace(24, pid)
            continue
        if stopped == signal.SIGTRAP | 0x80:
            info = ctypes.create_string_buffer(128)
            ptrace(0x420e, pid, 128, ctypes.byref(info))  # PTRACE_GET_SYSCALL_INFO, Linux >=5.3
            if int.from_bytes(info.raw[4:8], sys.byteorder) != native_arch:
                network.add('unmonitored_architecture_forbidden')
                os.kill(pid, signal.SIGKILL)
            if info.raw[0] == 1:
                number, *arguments = struct.unpack_from('=7Q', info.raw, 24)
                a = arguments[0]
                if number & 0x40000000:
                    network.add('unmonitored_abi_forbidden')
                    os.kill(pid, signal.SIGKILL)
                # open/openat/creat, including attempted writes to a read-only mount.
                if number in opens:
                    path_index, flags_index = opens[number]
                    pointer, flags = arguments[path_index], arguments[flags_index] if flags_index is not None else 1
                    if flags & (3 | 64 | 512 | 1024):
                        path = string(pid, pointer)
                        if path != '/dev/null':
                            writes.add('open:' + path)
                if number == syscall('openat2'):
                    flags = ptrace(2, pid, arguments[2])
                    if flags & (3 | 64 | 512 | 1024):
                        writes.add('openat2:' + string(pid, arguments[1]))
                if number in mutations:
                    writes.add('mutation:' + string(pid, arguments[mutations[number]]))
                # fd 0..2 are the MCP/log pipes; other writes include inherited sockets.
                if number in fd_writes and a > 2:
                    try:
                        target = os.readlink(f'/proc/{pid}/fd/{a}')
                    except OSError:
                        target = 'unresolved-fd'
                    if target != '/dev/null' and not target.startswith(('pipe:', 'socket:', 'anon_inode:')):
                        writes.add('fd:' + target)
                if number in sockets and a != 1:
                    network.add('socket_family:' + str(a))
            ptrace(24, pid)
        else:
            ptrace(24, pid, 0, 0 if stopped in (signal.SIGSTOP, signal.SIGTRAP) else stopped)
    audit.write_text(json.dumps({'writes': sorted(writes), 'network': sorted(network), 'exit': status_code}))
    return status_code
