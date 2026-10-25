// Inspect the filesystem, independently of Git's ignore rules and index flags.
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync} from 'node:fs';
import {join, posix, sep} from 'node:path';

export function inspectTree(root, tree, canonicalHash) {
  const tracked = new Map(), parents = new Set(), dirty = [], products = [];
  for (const record of tree.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), path = record.slice(tab + 1);
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (type !== 'blob') throw new Error(`Unsupported tracked object: ${path} (${type})`);
    tracked.set(path, {mode, oid});
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) parents.add(parent);
  }
  function walk(dir) {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (!dir && name === '.git') continue;
      const path = dir ? `${dir}/${name}` : name, absolute = join(root, path), stat = lstatSync(absolute);
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      const mode = type === 'symlink' ? '120000' : type === 'file' ? (stat.mode & 0o111 ? '100755' : '100644') : type;
      const target = type === 'symlink' ? readlinkSync(absolute) : '';
      const expected = tracked.get(path);
      if (expected) {
        tracked.delete(path);
        const bytes = type === 'symlink' ? Buffer.from(target) : type === 'file' ? readFileSync(absolute) : Buffer.alloc(0);
        let oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        // Upstream deliberately checks PowerShell out as CRLF. Compare canonical Git bytes.
        if (oid !== expected.oid && type === 'file' && canonicalHash) oid = canonicalHash(path);
        if (expected.mode !== mode || expected.oid !== oid) dirty.push(path);
      } else if (type !== 'directory' || !parents.has(path)) products.push([path, mode, target]);
      if (type === 'directory') walk(path);
    }
  }
  walk('');
  dirty.push(...tracked.keys());
  products.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {dirty, products};
}

export function productInventory(products, path) {
  const entries = products.filter(([name]) => name === path || name.startsWith(`${path}/`));
  return {path_count: entries.length, paths_sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
}

// uv gives its seed archives random names. They remain data confined to this root.
export function checkSeedCache(root) {
  if (!lstatSync(root).isDirectory()) throw new Error(`${root}: seed cache must be a directory`);
  const boundary = realpathSync(root);
  function walk(path) {
    const stat = lstatSync(path);
    if (stat.mode & 0o6000) throw new Error(`${path}: setuid/setgid seed entry`);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (target !== boundary && !target.startsWith(boundary + sep))
        throw new Error(`${path}: seed symlink escapes ${root}`);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (!stat.isFile()) throw new Error(`${path}: unsupported seed entry type`);
  }
  walk(root);
}
