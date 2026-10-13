import manifest from "../../theme.json"
import { fetchSite } from "@/lib/api"
import { themeConfig } from "@/lib/cfsm"
import { resolveConfig } from "./config-values"

/**
 * The operator's settings over the defaults declared in theme.json. Monitor kept
 * them behind a per-theme endpoint; CF-Server-Monitor stores a third-party
 * theme's settings inside `/api/config`'s `theme_options`, so they are read from
 * there — under a `guangao` key when present, else from the object directly. A
 * saved value of another type -- left by an older version of this theme --
 * counts as unsaved, and any failure renders the defaults rather than an error.
 */
export function loadConfig(): Promise<Record<string, unknown>> {
  return fetchSite()
    .then((config) => resolveConfig(manifest.config, themeConfig(config)))
    .catch(() => resolveConfig(manifest.config, {}))
}
