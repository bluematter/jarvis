# Vendored front-end libs

Committed so the HUD runs straight from a clone with no build step or runtime CDN (Jarvis is local-first).

| File            | Package              | Version | License |
|-----------------|----------------------|---------|---------|
| `xterm.js`      | `@xterm/xterm`       | 5.5.0   | MIT     |
| `xterm.css`     | `@xterm/xterm`       | 5.5.0   | MIT     |
| `addon-fit.js`  | `@xterm/addon-fit`   | 0.10.0  | MIT     |

These render the in-HUD terminal panel. The PTYs they attach to are spawned by the bridge via
`node-pty`. To refresh: re-download the same files from `https://unpkg.com/@xterm/<pkg>@<ver>/...`.
