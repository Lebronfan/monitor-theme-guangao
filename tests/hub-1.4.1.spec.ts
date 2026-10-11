import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { demoNodes, demoHistory } from '../dev/fixtures';

test('Hub 1.4.1 rejected WS handshake falls back to REST and retries the stream', async ({ page }) => {
  let connections = 0, reads = 0;
  let acceptStream = false, restCpu = 12.8;
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    connections++;
    if (!acceptStream) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      // Keep the stream pending long enough to observe the fallback poll.
      const timer = setTimeout(() => client.send(JSON.stringify({ nodes: [{
        ...demoNodes[0], metrics: { ...demoNodes[0].metrics, cpu: 55.5 },
      }] })), 1500);
      client.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test WS address unavailable');
  try {
    await page.addInitScript(url => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor() { super(url); }
      };
    }, `ws://127.0.0.1:${address.port}/api/ws`);
    await page.route('**/api/nodes', route => {
      reads++;
      return route.fulfill({ json: { nodes: [{ ...demoNodes[0], metrics: {
        ...demoNodes[0].metrics, cpu: restCpu,
      } }] } });
    });
    await page.goto('/');
    const cpu = page.getByRole('article').first().locator('.resource-tile').first().locator('strong');
    await expect(cpu).toHaveText('12.8%');
    const initialReads = reads;
    restCpu = 72.5;
    await expect(cpu).toHaveText('72.5%', { timeout: 10000 });
    expect(reads).toBeGreaterThan(initialReads);
    acceptStream = true;
    await expect(cpu).toHaveText('55.5%', { timeout: 10000 });
    expect(connections).toBeGreaterThanOrEqual(2);
    const settledReads = reads;
    await page.waitForTimeout(5500);
    expect(reads).toBe(settledReads);
  } finally {
    await page.close();
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const blocked of ['getter', 'methods']) test(`Hub 1.4.1 storage ${blocked} SecurityError keeps the page usable`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(mode => {
    const denied = () => { throw new DOMException('Site data disabled', 'SecurityError'); };
    if (mode === 'getter') Object.defineProperty(window, 'localStorage', { get: denied });
    else {
      Storage.prototype.getItem = denied;
      Storage.prototype.setItem = denied;
      Storage.prototype.removeItem = denied;
    }
  }, blocked);
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(6);
  await page.getByRole('button', { name: '外观设置', exact: true }).click();
  await page.getByRole('combobox', { name: '广告墙风格' }).click();
  await page.getByRole('option', { name: '澳门皇家赌场风' }).click();
  await expect(page.locator('.monitor-app')).toHaveAttribute('data-variant', 'neon');
  await page.getByRole('button', { name: '停止动效', exact: true }).click();
  await page.getByRole('button', { name: '关闭边框灯', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(6);
  expect(errors).toEqual([]);
});

for (const newer of [false, true]) test(`history tolerates ${newer ? 'Hub 1.4.1 extra' : 'older Hub missing'} optional metric fields`, async ({ page }) => {
  await page.route('**/api/nodes/*/metrics?*', route => {
    const data = demoHistory();
    return route.fulfill({ json: { ...data, metrics: data.metrics.map(row => newer
      ? { ...row, swap_used: 0, tcp: 42, udp: 12, procs: 86 }
      : row) } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/node/1');
  await expect(page.locator('.recharts-area-curve')).toHaveCount(3);
  await page.getByRole('button', { name: '网络延迟', exact: true }).click();
  await expect(page.locator('.recharts-line-curve').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('legacy agent strings remain plain text even without Hub 1.4.1 sanitizing', async ({ page }) => {
  const marker = '<img src=x onerror="window.agentMarkupExecuted=true">';
  await page.routeWebSocket('**/api/ws*', () => {});
  await page.route('**/api/nodes', route => route.fulfill({ json: { nodes: [{
    ...demoNodes[0], name: marker, os: marker, kernel: marker,
    arch: marker, virt: marker, cpu_name: marker, agent_version: marker,
  }] } }));
  await page.goto('/node/1');
  await expect(page.locator('.detail-body')).toContainText(marker);
  await expect(page.locator('.detail-body img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'agentMarkupExecuted'))).toBeUndefined();
});
