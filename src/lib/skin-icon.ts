import { useEffect, useState } from "react";
import promo from "@/assets/brand-promo.svg?no-inline";
import royal from "@/assets/brand-royal.svg?no-inline";
import retro from "@/assets/brand-retro.svg?no-inline";
import defaultMarkup from "@/assets/brand-promo.svg?raw";

const icons: Record<string, string> = { promo, neon: royal, retro };
const normalize = (markup: string) => markup.replace(/\r/g, "").trim();

/** The Hub answers unknown paths with its own page shell, so a response only
 * counts as a site icon when it is actually SVG. Anything else means there is no
 * custom artwork to preserve: fall back to ours, which follows the chosen skin,
 * rather than to a URL the hub does not serve. */
export function useSkinIcon(variant: string) {
  const [usesDefault, setUsesDefault] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/favicon.svg", { signal: controller.signal, cache: "no-cache" })
      .then(async response => {
        if (!response.ok) return "";
        const type = response.headers.get("content-type") || "";
        return type.includes("svg") ? await response.text() : "";
      })
      .then(markup => {
        if (controller.signal.aborted) return;
        setUsesDefault(markup === "" || normalize(markup) === normalize(defaultMarkup));
      })
      .catch(() => { /* Keep our own artwork when the site's icon is unavailable. */ });
    return () => controller.abort();
  }, []);
  const icon = usesDefault ? (icons[variant] || promo) : "/favicon.svg";
  useEffect(() => {
    if (usesDefault) document.querySelector('link[rel="icon"]')?.setAttribute("href", icon);
  }, [usesDefault, icon]);
  return icon;
}
