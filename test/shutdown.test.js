import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('shutdown UI + route wiring', () => {
  it('admin page has 关闭整体服务 button and confirm flow', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /关闭整体服务/);
    assert.match(html, /id="btn-shutdown"/);
    assert.match(html, /id="btn-shutdown-yes"/);
    assert.match(html, /id="shutdown-confirm"/);
    assert.match(html, /确认关闭/);
  });

  it('app.js calls POST /shutdown after confirm', () => {
    const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
    assert.match(js, /btn-shutdown-yes/);
    assert.match(js, /\/shutdown/);
    assert.match(js, /method:\s*'POST'/);
  });

  it('server.js registers POST /shutdown, calls shutdownAll, then process.exit', () => {
    const src = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
    assert.match(src, /adminApi\.post\('\/shutdown'/);
    assert.match(src, /shutdownAll/);
    assert.match(src, /process\.exit\(0\)/);
    assert.match(src, /exiting:\s*true/);
  });

  it('process-manager exports shutdownAll that stops managed then returns message', () => {
    const src = fs.readFileSync(path.join(root, 'src/process-manager.js'), 'utf8');
    assert.match(src, /export async function shutdownAll/);
    assert.match(src, /stopManaged\(opts\)/);
    assert.match(src, /splash-web 即将退出/);
  });
});
