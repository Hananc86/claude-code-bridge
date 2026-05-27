# claude-code-bridge

Use Claude Code from your browser. Runs a local server that connects your browser tools to the Claude CLI on your machine.

## Install

```bash
npm install -g claude-code-bridge
```

Requires Node.js 18+ and [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) installed.

## Usage

### Local mode (same machine)

```bash
claude-code-bridge start --port 8091
```

Starts an HTTP server on `127.0.0.1:8091` wrapping `claude -p`. Send prompts via `POST /ask`.

### Relay mode (remote access)

```bash
claude-code-bridge start \
  --relay-url wss://your-relay-server.example.com/agent/ws \
  --machine my-laptop \
  --token <your-machine-bearer>
```

Connect to Claude on this machine from another device (requires a relay server).

### Auto-start on boot

```bash
claude-code-bridge install-service --relay-url ... --machine ... --token ...
```

Registers as a system service (Windows Scheduled Task / macOS LaunchAgent / Linux systemd user unit).

## API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/ask` | POST | Send a prompt to Claude |
| `/sessions` | GET | List all sessions |
| `/sessions/:id/messages` | GET | Get session messages |
| `/sessions/:id/stop` | POST | Stop a running session |
| `/sessions/:id/star` | POST | Toggle star on a session |
| `/sessions/:id/marks` | GET/PATCH | Per-message marks |
| `/sessions/:id/title` | PATCH | Rename a session |
| `/chatgpt-bindings` | GET/POST | Conversation bindings |

## Configuration

All options can be set via CLI flags or environment variables:

| Flag | Env var | Default |
|---|---|---|
| `--port` | `BRIDGE_PORT` | 8091 |
| `--host` | `BRIDGE_HOST` | 127.0.0.1 |
| `--cwd` | `BRIDGE_CWD` | Current directory |
| `--timeout` | `BRIDGE_TIMEOUT` | 7200 (seconds) |
| `--relay-url` | `BRIDGE_RELAY_URL` | — |
| `--machine` | `BRIDGE_MACHINE_NAME` | — |
| `--token` | `BRIDGE_MACHINE_TOKEN` | — |
| `--cf-id` | `BRIDGE_CF_ID` | — |
| `--cf-secret` | `BRIDGE_CF_SECRET` | — |

## License

MIT
