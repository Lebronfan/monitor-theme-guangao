import { test, expect } from '@playwright/test';

for (const variant of ['promo', 'neon', 'retro']) test(`${variant} copied Markdown includes the exact calculation inputs and custom day basis`, async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: {
    writeText: async (text: string) => { Reflect.set(window, 'copiedMarkdown', text); },
  } }));
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    const drawn: string[] = [];
    Reflect.set(window, 'exportedImageText', drawn);
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      drawn.push(text);
      if (maxWidth === undefined) original.call(this, text, x, y);
      else original.call(this, text, x, y, maxWidth);
    };
  });
  await page.route('**/api/themes/monitor-theme-guangao/config', route => route.fulfill({ json: { variant } }));
  await page.route('https://api.frankfurter.dev/**', route => route.fulfill({ json: { rate: 7, date: '2026-10-10' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '剩余价值计算器', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('续费金额', { exact: true }).fill('100');
  await dialog.getByRole('combobox', { name: '货币', exact: true }).click();
  await page.getByRole('option', { name: 'USD', exact: true }).click();
  await expect(dialog.getByLabel('外币汇率', { exact: true })).toHaveValue('7');
  await dialog.getByRole('combobox', { name: '付款周期', exact: true }).click();
  await page.getByRole('option', { name: '月付 · 30 天', exact: true }).click();
  await dialog.getByLabel('交易日期', { exact: true }).fill('2026-10-10');
  await dialog.getByLabel('到期时间', { exact: true }).fill('2026-10-25');
  for (const [days, result] of [['30', '350.00'], ['31', '338.71']]) {
    if (days === '31') await dialog.getByLabel('周期天数', { exact: true }).fill(days);
    await dialog.getByRole('button', { name: '复制 Markdown', exact: true }).click();
    const text = await page.evaluate(() => Reflect.get(window, 'copiedMarkdown'));
    expect(text).toContain('| 交易日期 | 2026-10-10 |');
    expect(text).toContain('| 到期日期 | 2026-10-25 |');
    expect(text).toContain('| 外币汇率 | 1 USD = 7 CNY |');
    expect(text).toContain(`| 周期天数 | ${days} 天 |`);
    expect(text).toContain(`100 USD × 7 CNY/USD × 15 天 ÷ ${days} 天 = ¥${result}`);
    expect(text).toContain('以本次填写的周期天数为准');
    await expect(dialog.getByLabel('Markdown 结果')).toHaveValue(text);
  }
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载图片', exact: true }).click();
  const image = await downloaded;
  expect(await image.failure()).toBeNull();
  const drawn = await page.evaluate(() => Reflect.get(window, 'exportedImageText') as string[]);
  for (const label of ['交易日期', '外币汇率', '周期天数', '核对公式']) expect(drawn).toContain(label);
  expect(drawn).toContain('2026-10-10');
  expect(drawn).toContain('31 天');
  expect(drawn.join('')).toContain('100 USD × 7 CNY/USD × 15 天 ÷ 31 天 = ¥338.71');
});
