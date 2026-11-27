#!/usr/bin/env python3
"""Limit a converter to its job directory and the immutable toolchain."""
import ctypes as c
import errno
import os
import platform
import resource
import socket
import stat
import sys
from pathlib import Path

# Linux asm-generic assigns the same values on the supported image architectures.
CREATE_RULESET, ADD_RULE, RESTRICT_SELF = 444, 445, 446
ACCESS_QUERY = 1
PATH_BENEATH = 1
ABITRUNCATE = 3
READ_EXEC = (1 << 0) | (1 << 2)
READ_DIRECTORY = 1 << 3
WRITE_FILE = 1 << 1
ALL_FILESYSTEM = (1 << 15) - 1

class Ruleset(c.Structure):
    _fields_ = [('handled_access_fs', c.c_uint64)]

class PathRule(c.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', c.c_uint64), ('parent_fd', c.c_int32)]

class SyscallArgument(c.Structure):
    _fields_ = [('index', c.c_uint), ('op', c.c_int), ('first', c.c_uint64), ('second', c.c_uint64)]

def checked(value, label):
    if value < 0:
        raise OSError(c.get_errno(), label)
    return value

def deny_syscalls():
    library = c.CDLL('libseccomp.so.2')
    library.seccomp_init.argtypes = [c.c_uint32]
    library.seccomp_init.restype = c.c_void_p
    library.seccomp_syscall_resolve_name.argtypes = [c.c_char_p]
    library.seccomp_rule_add.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint]
    library.seccomp_rule_add_array.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint, c.POINTER(SyscallArgument)]
    library.seccomp_load.argtypes = [c.c_void_p]
    library.seccomp_release.argtypes = [c.c_void_p]
    filter_context = library.seccomp_init(0x7fff0000)
    if not filter_context:
        raise RuntimeError('Cannot create conversion syscall filter')
    try:
        deny = 0x00050000 | errno.EPERM
        # LibreOffice creates an IPC listener even with an isolated profile.
        # Deny outbound connect and allow socket creation only for AF_UNIX.
        not_local = SyscallArgument(0, 1, socket.AF_UNIX, 0)  # SCMP_CMP_NE
        socket_call = library.seccomp_syscall_resolve_name(b'socket')
        if socket_call < 0 or library.seccomp_rule_add_array(filter_context, deny, socket_call, 1, c.byref(not_local)):
            raise RuntimeError('Cannot restrict conversion socket families')
        for name in (
            'socketcall', 'connect', 'sendto', 'sendmsg', 'sendmmsg',
            'io_uring_setup', 'io_uring_register', 'io_uring_enter', 'bpf', 'keyctl',
            'ptrace', 'process_vm_readv', 'process_vm_writev', 'pidfd_open', 'pidfd_getfd',
            'pidfd_send_signal', 'kill', 'tkill', 'tgkill', 'rt_sigqueueinfo', 'rt_tgsigqueueinfo',
            'mount', 'umount2', 'pivot_root', 'setns', 'unshare', 'open_by_handle_at',
        ):
            number = library.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and library.seccomp_rule_add(filter_context, deny, number, 0):
                raise RuntimeError('Cannot register conversion syscall filter')
        if library.seccomp_load(filter_context):
            raise RuntimeError('Cannot install conversion syscall filter')
    finally:
        library.seccomp_release(filter_context)

def isolate(job):
    if platform.machine() not in ('x86_64', 'aarch64'):
        raise RuntimeError('Unsupported conversion architecture')
    libc = c.CDLL(None, use_errno=True)
    libc.syscall.restype = c.c_long
    version = checked(libc.syscall(CREATE_RULESET, 0, 0, ACCESS_QUERY), 'Landlock ABI')
    if version < ABITRUNCATE:
        raise RuntimeError('Conversion requires Linux Landlock ABI 3 or newer')
    rules = Ruleset(ALL_FILESYSTEM)
    handle = checked(libc.syscall(CREATE_RULESET, c.byref(rules), c.sizeof(rules), 0), 'Landlock create')
    try:
        for path, flags in [
            (job, ALL_FILESYSTEM & ~(1 << 0)),
            ('/usr', READ_EXEC | READ_DIRECTORY), ('/opt/log4stellar/container/soffice.sh', READ_EXEC), ('/etc/fonts', READ_EXEC | READ_DIRECTORY),
            ('/etc/libreoffice', READ_EXEC | READ_DIRECTORY), ('/etc/ld.so.cache', READ_EXEC),
            ('/etc/passwd', READ_EXEC), ('/etc/group', READ_EXEC), ('/etc/nsswitch.conf', READ_EXEC),
            ('/dev/null', READ_EXEC | WRITE_FILE), ('/dev/urandom', READ_EXEC),
        ]:
            if not os.path.exists(path):
                continue
            with_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                if not stat.S_ISDIR(os.fstat(with_fd).st_mode):
                    flags &= ~READ_DIRECTORY
                rule = PathRule(flags, with_fd)
                checked(libc.syscall(ADD_RULE, handle, PATH_BENEATH, c.byref(rule), 0), 'Landlock rule')
            finally:
                os.close(with_fd)
        checked(libc.prctl(38, 1, 0, 0, 0), 'no_new_privs')
        deny_syscalls()
        checked(libc.syscall(RESTRICT_SELF, handle, 0), 'Landlock restrict')
    finally:
        os.close(handle)

def main():
    job = Path(sys.argv[1]).resolve(strict=True)
    if not job.is_dir() or job == Path('/'):
        raise ValueError('Invalid conversion task directory')
    binary = sys.argv[2]
    if binary not in ('/usr/bin/bash', '/usr/bin/true'):
        raise ValueError('Invalid converter')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024**2,) * 2)
    resource.setrlimit(resource.RLIMIT_FSIZE, (100 * 1024**2,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (40, 40))
    os.chdir(job)
    isolate(str(job))
    os.execve(binary, sys.argv[2:], {
        'PATH': '/usr/bin:/bin', 'HOME': str(job), 'TMPDIR': str(job),
        'LANG': 'C.UTF-8', 'SAL_USE_VCLPLUGIN': 'svp', 'OMP_THREAD_LIMIT': '1',
    })

if __name__ == '__main__':
    main()
