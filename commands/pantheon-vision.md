---
description: "Configure Pantheon vision interactively: auth check, mode (native|tool|auto), vision model, tool fallback. Saves to opencode-vision.json. Usage: /pantheon-vision"
agent: hermes
---
# /pantheon-vision — Configure Vision

**What:** Walks the user through configuring Pantheon's image-vision plugin
(native multimodal model via the opencode Zen endpoint, or MCP tool fallback).
**Usage:** `/pantheon-vision [--global]`
**When:** First-time setup, changing the vision model, troubleshooting images
not being described, switching between native and tool mode.

## Steps

1. **Check connectivity & key source**
   - Read the opencode auth store: `<data dir>/auth.json`
     (default `~/.local/share/opencode/auth.json`) via `readOpencodeAuthToken`.
   - Credentials follow the endpoint (never cross providers):
     - **Zen endpoints** (`opencode`, `opencode-go*`): the env keys
       `PANTHEON_OPENCODE_API_KEY` / `OPENCODE_API_KEY` first, then the auth
       store — the resolved provider entry first, then the legacy Zen entries
       `opencode-go` then `opencode`.
     - **Non-Zen endpoints** (e.g. discovered OpenAI-compatible providers):
       ONLY that provider's own auth-store entry. The shared Zen env keys and
       the legacy `opencode-go` / `opencode` entries are never attached to a
       non-Zen base URL; absent an own credential the image falls through to
       the tool→local chain.
   - Report whether the user is connected (`opencode auth login`) or has an
     env key — for a non-Zen target, report the target provider's own entry.
   - **Never log or echo the token itself** — only connected/not connected.

2. **Show current status (mode + resolved target + origin)**
   - Effective mode precedence: env `PANTHEON_VISION_MODE` > config file
     `mode` > default `auto`.
   - Resolved target + origin, in precedence order:
     env `PANTHEON_VISION_MODEL` → config `visionModel` (project
     `.opencode/opencode-vision.json`, then user
     `~/.config/opencode/opencode-vision.json`) → active preset `vision.model`
     → **automatic discovery** in the host catalog (`GET /config/providers`)
     → built-in default.
   - Resolve the installed helper first (do not assume the current project
     contains Pantheon source). Check, in order:
     `$OPENCODE_CONFIG_DIR/.opencode/scripts/`,
     `$OPENCODE_CONFIG_DIR/scripts/`,
     `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/scripts/`,
     `$HOME/.opencode/scripts/`, `.opencode/scripts/`, then
     `$(npm root -g)/pantheon-opencode/scripts/`. Run the first existing
     `vision-status.mjs` as `node "$helper" --dir="$PWD"` and show its output
     (mode + target + origin). The same helper drives the picker with
     `--list` (enumerate candidates) and `--set <provider/model>` (pin one).
   - If the helper is missing, resolve inline with the same precedence and be
     honest: discovery needs the live host catalog, so when no explicit model
     is configured report `auto (resolved at session start)` and name the
     fallback default — never invent a value.

3. **Ask what to set (interactive)**
   - **Mode:** `native` | `tool` | `auto`
     - `native` — describe images via the multimodal model directly (needs a
       usable credential for the resolved endpoint)
      - `tool` — always use the MCP tool fallback (`imageAnalysisTool`)
     - `auto` — try native first, fall back to the tool (default)
   - **Vision model — show the picker, do NOT make the user type blind.**
     Run `node "$helper" --list --dir="$PWD"` and present its numbered list.
     - **Read the `Source:` line out loud.** It is `host catalog`
       (`capabilities.input.image`) when the live catalog is available, or
       `heuristic` (`opencode models` + known vision families) otherwise — the
       heuristic is a *guess*, so say so; never present it as certain.
     - Each row shows `Access` (free/paid when the catalog reports cost) and
       `Credential`. **`Credential: no` means the native path has no key for
       that provider, so images degrade to the MCP tool fallback (which then
       falls back to local metadata like EXIF/size) — that is expected, not an
       error.** `yes (env|store)` means a key is present (never echo it).
     - Let the user choose by **number** or type a `provider/model`. Then apply
       it with `node "$helper" --set <provider/model> --dir="$PWD"` (add
       `--global` to pin in the user config; default is the project config).
     - If the list is empty, report the helper's `Source: none` reason (e.g.
       `opencode models` unavailable) and let the user type the model manually.
     - Precedence for the effective model is unchanged: env
       `PANTHEON_VISION_MODEL` > config `visionModel` > active preset
       `vision.model` > automatic discovery > default `opencode-go/mimo-v2.5`.
    - **Tool fallback:** `imageAnalysisTool` (default
      `pantheon_vision_vision_describe`). Bifrost is opt-in only when
      explicitly selected here or through `PANTHEON_VISION_TOOL`.

4. **Save the config**
   - The `--set` in step 3 already merged `visionModel` atomically
     (`.bak` backup, existing keys preserved, corrupted JSON left untouched).
     If the user typed a model instead of using `--set`, apply it the same way.
   - Default target: project config `.opencode/opencode-vision.json`
     (resolved alongside the user config `~/.config/opencode/opencode-vision.json`;
     project wins on conflicts).
   - `--global` → write to `~/.config/opencode/opencode-vision.json`.
   - Shape:
     ```json
     {
       "mode": "auto",
       "visionModel": "opencode-go/mimo-v2.5",
        "imageAnalysisTool": "pantheon_vision_vision_describe"
     }
     ```
   - Optional fields also supported: `models` (model wildcard patterns),
     `promptTemplate` (with `{imageList}`/`{imageCount}`/`{toolName}`/`{userText}`).

5. **Wrap up**
   - Tell the user to restart opencode (config is read at startup / per turn)
     and test by pasting an image with a question.
   - If no key and no auth store entry exist, recommend `opencode auth login`
     (native mode) or leaving the tool fallback enabled.

## Rules

- Do NOT print tokens or auth.json contents.
- Do NOT overwrite existing config keys not being changed — merge.
- If the config file is corrupted JSON, warn and ask before overwriting.
- State the picker's `Source:` (catalog vs heuristic) honestly — a heuristic
  list is a guess; never imply certainty about image capability.
