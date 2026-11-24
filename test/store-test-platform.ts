import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const wantsXattr = (command: string) => command === '/bin/getfattr' || command === '/bin/setfattr';
const pythonXattr = `
import errno, os, re, sys
tool = 'getfattr' if sys.argv[1] == 'get' else 'setfattr'
dialect = sys.argv[-1]
try:
    if sys.argv[1] == 'get':
        sys.stdout.buffer.write(os.getxattr(3, sys.argv[2]))
    else:
        value = sys.argv[3]
        if value.startswith('0x'):
            encoded = value[2:]
            if len(encoded) % 2 or not re.fullmatch('[0-9a-fA-F]*', encoded):
                sys.stderr.write('setfattr: /proc/self/fd/3: Invalid argument\\n')
                sys.exit(1)
            data = bytes.fromhex(encoded)
        else:
            data = value.encode()
        os.setxattr(3, sys.argv[2], data)
except OSError as error:
    if error.errno == errno.ENODATA and sys.argv[1] == 'get' and dialect == 'toybox':
        # Toybox getfattr: a missing attribute is a silent success.
        sys.exit(0)
    if error.errno == errno.ENODATA:
        sys.stderr.write('getfattr: /proc/self/fd/3: user.council_store_identity: No such attribute\\n')
    else:
        message = 'Operation not supported' if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP) else error.strerror
        sys.stderr.write(f'{tool}: /proc/self/fd/3: {message}\\n')
    sys.exit(1)
`;

// Test hosts may ship Linux xattrs without the attr command-line package.
export function installXattrTestTransport(): void {
  const spawn = childProcess.spawnSync;
  childProcess.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
    if (!wantsXattr(command) || fs.existsSync(command)) return spawn(command, args, options);
    const read = command === '/bin/getfattr';
    const expected = read
      ? ['--only-values', '-n', 'user.council_store_identity', '--', '/proc/self/fd/3']
      : ['-n', 'user.council_store_identity', '-v', args[3], '--', '/proc/self/fd/3'];
    if (JSON.stringify(args) !== JSON.stringify(expected) || options.env?.LC_ALL !== 'C' ||
        !Array.isArray(options.stdio) || typeof options.stdio[3] !== 'number') {
      throw new Error('Malformed fd-3 xattr invocation');
    }
    const dialect = process.env.COUNCIL_TEST_XATTR_DIALECT === 'gnu' ? 'gnu' : 'toybox';
    return spawn('/usr/bin/python3', ['-S', '-c', pythonXattr, read ? 'get' : 'set',
      'user.council_store_identity', ...(read ? [] : [args[3]!]), dialect], options);
  }) as typeof spawn;
  syncBuiltinESMExports();
}

export function guardStoreLinks(): void {
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => {
    if (process.env.COUNCIL_STORE_NO_LINK === '1' && !String(destination).includes('/.link-probe-') &&
        /[/\\]src[/\\]store[/\\]/.test(new Error().stack ?? '')) {
      throw new Error('Store called linkSync in forced mode');
    }
    link(source, destination);
  };
  syncBuiltinESMExports();
}
