/**
 * 端到端验证：splash-web 反代确实把采样默认值补进上游请求体。
 * 用一个假上游（http server）代替真 Splash，不需要加载模型。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 拿一个空闲端口（有竞态但足够本机测试） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForLine(child, needle, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early code=${code} stderr=${child.__stderr || ''}`));
    });
  });
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('反代注入采样默认值', () => {
  let upstream;
  let upstreamPort;
  let webPort;
  let child;
  let tmpDir;
  let lastBody;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splash-web-sampling-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        model: '/nonexistent/model',
        host: '127.0.0.1',
        port: 8000,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        applySamplingDefaults: true,
      }),
    );

    lastBody = null;
    upstream = http.createServer((req, res) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        lastBody = JSON.parse(Buffer.concat(parts).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    upstreamPort = await freePort();
    await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

    webPort = await freePort();
    child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
      cwd: root,
      env: {
        ...process.env,
        SPLASH_WEB_CONFIG_DIR: tmpDir,
        SPLASH_WEB_PORT: String(webPort),
        SPLASH_WEB_UPSTREAM_PORT: String(upstreamPort),
        SPLASH_WEB_DRY_RUN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (c) => {
      child.__stderr = (child.__stderr || '') + c.toString();
    });
    await waitForLine(child, 'public');
  });

  after(async () => {
    if (child) child.kill('SIGTERM');
    if (upstream) await new Promise((r) => upstream.close(r));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('缺省字段被补上，并回写 x-splash-web-sampling', async () => {
    const res = await post(webPort, '/v1/chat/completions', {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(lastBody.temperature, 0.7);
    assert.deepEqual(lastBody.top_p, 0.9);
    assert.deepEqual(lastBody.top_k, 40);
    assert.match(String(res.headers['x-splash-web-sampling'] || ''), /temperature=0\.7/);
  });

  it('客户端显式值不被覆盖', async () => {
    const res = await post(webPort, '/v1/chat/completions', {
      model: 'x',
      messages: [],
      temperature: 0.1,
      top_k: 5,
    });
    assert.equal(res.status, 200);
    assert.equal(lastBody.temperature, 0.1);
    assert.equal(lastBody.top_k, 5);
    assert.equal(lastBody.top_p, 0.9, '未显式传的 top_p 仍应补齐');
    assert.match(String(res.headers['x-splash-web-sampling'] || ''), /top_p=0\.9/);
  });

  it('非采样路径不注入', async () => {
    await post(webPort, '/v1/models', { anything: true });
    assert.deepEqual(lastBody, { anything: true });
  });
});
