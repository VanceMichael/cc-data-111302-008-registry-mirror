// 最小化 POSIX ustar 归档的生成与只读解析。
// 目的仅在于为本地来源制造可核对完整性的归档字节，以及采集后在内存中清点归档内容；
// 不做解包落盘、不切换权限、不执行任何生命周期脚本。
import {createHash} from 'node:crypto';

const BLOCK = 512;
const NAME_MAX = 100;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeString(buffer, offset, value, length) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar 字段超长: ${value}`);
  bytes.copy(buffer, offset);
}

// entries: [{name, data(Buffer|string), mode?}]，按调用顺序写入，mtime 固定为 0，保证字节可复现。
export function createTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const name = entry.name.replace(/^\.?\//, '');
    if (name.length === 0 || name.length > NAME_MAX) throw new Error(`不支持的归档条目名: ${entry.name}`);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const header = Buffer.alloc(BLOCK);
    writeString(header, 0, name, NAME_MAX);
    header.write(octal(entry.mode ?? 0o644, 8), 100, 8, 'ascii'); // mode
    header.write(octal(0, 8), 108, 8, 'ascii'); // uid
    header.write(octal(0, 8), 116, 8, 'ascii'); // gid
    header.write(octal(data.length, 12), 124, 12, 'ascii'); // size
    header.write(octal(0, 12), 136, 12, 'ascii'); // mtime 固定
    header.write('        ', 148, 8, 'ascii'); // checksum 先填空格
    header.write('0', 156, 1, 'ascii'); // typeflag: 普通文件
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);
    blocks.push(data);
    const padding = BLOCK - (data.length % BLOCK || BLOCK);
    if (padding < BLOCK) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // 结尾两个零块
  return Buffer.concat(blocks);
}

// 只读解析：返回 [{name, size, mode, unsafe}]，unsafe 标记路径穿越等不可信特征。
export function listTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    if (header.toString('ascii', 257, 262) !== 'ustar') throw new Error('不是受支持的 ustar 归档');
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(header.toString('ascii', 124, 136).replace(/[\0 ]/g, ''), 8) || 0;
    const mode = header.toString('ascii', 100, 108).replace(/[\0 ]/g, '');
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = offset + BLOCK;
    if (dataStart + size > buffer.length) throw new Error('归档长度不足，条目被截断');
    const unsafe =
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      name.includes('\\') ||
      (typeflag !== '0' && typeflag !== '\0');
    entries.push({name, size, mode, typeflag, unsafe, dataStart});
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

export function integrityOf(buffer, algorithm = 'sha512') {
  return `${algorithm}-${createHash(algorithm).update(buffer).digest('base64')}`;
}
