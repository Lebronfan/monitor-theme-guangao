import { test, expect } from "@playwright/test";
import { demoHistory } from "../dev/fixtures";

for (const variant of ["promo", "neon", "retro"])
  test(`${variant} mobile time labels stay inside the chart`, async ({
    page,
  }) => {
    await page.route("**/api/themes/monitor-theme-guangao/config", (route) =>
      route.fulfill({ json: { variant } }),
    );
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: {
          authed: false,
          site_name: "演示数据 · 非真实节点",
          public_page: true,
          history_days: 30,
        },
      }),
    );
    await page.route("**/api/nodes/*/metrics?*", (route) => {
      const data = demoHistory();
      const end = Date.UTC(2026, 9, 12) / 1000;
      const hours = Number(
        new URL(route.request().url()).searchParams.get("hours"),
      );
      const start = data.metrics[0].ts;
      const span = data.metrics.at(-1)!.ts - start;
      const timestamp = (ts: number) =>
        end - hours * 3600 + Math.round(((ts - start) / span) * hours * 3600);
      return route.fulfill({
        json: {
          ...data,
          metrics: data.metrics.map((row) => ({
            ...row,
            ts: timestamp(row.ts),
          })),
          ping: data.ping.map((row) => ({ ...row, ts: timestamp(row.ts) })),
        },
      });
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/node/1");
    await expect(page.locator(".recharts-area-curve")).toHaveCount(3);
    for (const tab of ["资源", "网络延迟"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      for (const range of ["1 小时", "30 天"]) {
        await page.getByRole("button", { name: range, exact: true }).click();
        for (const width of [360, 390, 430, 1280]) {
          await page.setViewportSize({ width, height: 800 });
          await expect
            .poll(async () =>
              page.locator(".recharts-surface").evaluateAll(
                (charts) =>
                  charts.length > 0 &&
                  charts.every((chart) => {
                    const bounds = chart.getBoundingClientRect();
                    const texts = [
                      ...chart.querySelectorAll(
                        ".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value",
                      ),
                    ];
                    return (
                      texts.length > 0 &&
                      texts.every((text) => {
                        const rect = text.getBoundingClientRect();
                        return (
                          rect.left >= bounds.left + 1 &&
                          rect.right <= bounds.right - 1
                        );
                      })
                    );
                  }),
              ),
            )
            .toBe(true);
        }
      }
    }
  });
