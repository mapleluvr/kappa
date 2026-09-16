# Environment Variables

Kappa uses environment variables in three ways:

- Variables such as `PI_OFFLINE` configure the Kappa process (legacy `PI_*` names still work).
- Kappa sets process markers so child processes can identify Kappa as the launching agent.
- Commands run by the LLM-callable shell tools receive `KAPPA_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=kappa` is a generic marker that lets tooling identify Kappa as the agent that launched the process.
- `KAPPA_CODING_AGENT=true` lets child processes detect that they run inside Kappa. Inherited `PI_CODING_AGENT` is cleared so a parent Pi session cannot mislabel Kappa.

Child processes inherit both markers. They are not session-specific and are not set automatically when Kappa is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Kappa session state:

| Variable | Description |
|----------|-------------|
| `KAPPA_SESSION_ID` | Current session ID |
| `KAPPA_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `KAPPA_PROVIDER` | Currently selected model provider |
| `KAPPA_MODEL` | Currently selected model ID |
| `KAPPA_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Kappa. `KAPPA_PROVIDER` and `KAPPA_MODEL` identify the selected Kappa model, not a different upstream model that a router may choose internally. Inherited `PI_SESSION_*` values are stripped so a nested Kappa process does not look like Pi.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$KAPPA_PROVIDER" "$KAPPA_MODEL"
printf 'reasoning=%s session=%s\n' "$KAPPA_REASONING_LEVEL" "$KAPPA_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$KAPPA_SESSION_FILE" ]; then
  tail -n 1 "$KAPPA_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Kappa. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Kappa removes inherited `KAPPA_*` and leftover `PI_SESSION_*` values so nested processes do not expose stale parent-session metadata.

## Pi Process Configuration

These variables are read by Pi itself:

| Variable | Description |
|----------|-------------|
| `KAPPA_AGENT_DIR` | Override the config directory; default is `~/.kappa/agent` |
| `KAPPA_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `KAPPA_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `PI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).

`PI_SERVER_DIR` and `PI_SERVER_ID` apply only to the source-only [experimental remote harness](development.md#experimental-remote-harness), not distributed builds.
