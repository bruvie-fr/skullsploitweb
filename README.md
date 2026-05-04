# skullsploit

Black-and-white, key-invited script hub. Comfy noir.

## Run

```bash
npm install
npm start
```

Then open http://localhost:3000

## Roles

There are two kinds of accounts:

| Role          | What they can do                                         |
| ------------- | -------------------------------------------------------- |
| **developer** | Mint invite keys, publish scripts, browse everything.    |
| **member**    | Browse games + scripts, like scripts, join games.        |

There is **no** "admin" role. Developers are the only privileged users.

## Adding developers

**Developers can only be added by editing `data/devs.json` directly.**

The seeded developer is:

| Username | Password        |
| -------- | --------------- |
| `bruvo`  | `Bruvofr@2011`  |

To add another developer, stop the server and edit `data/devs.json`:

```json
[
  { "username": "bruvo",  "passwordHash": "$2a$10$...",  "createdAt": "..." },
  { "username": "newdev", "passwordHash": "<bcrypt hash here>", "createdAt": "2026-05-04T00:00:00.000Z" }
]
```

To generate a bcrypt hash for a new dev's password (cost 10):

```bash
node -e "console.log(require('bcryptjs').hashSync('THE_PASSWORD', 10))"
```

## Adding members

Members sign up at `/signup` using a one-use **invite key**. Devs mint invite keys from the `/dev` workshop. Each key creates exactly one account, then is marked `consumed`.

## Pages

| Path          | Who                  | What                                                 |
| ------------- | -------------------- | ---------------------------------------------------- |
| `/`           | anyone               | Welcome landing                                      |
| `/signup`     | anyone with a key    | Create an account                                    |
| `/login`      | anyone               | Sign in (devs and members use the same form)         |
| `/dashboard`  | members + devs       | Home                                                 |
| `/games`      | members + devs       | Games we currently support (placeholder API for now) |
| `/scripts`    | members + devs       | Script hub with likes                                |
| `/dev`        | devs only            | Mint invite keys + publish scripts                   |

Devs are *never* asked for a key when navigating — they sign in normally and get full access.

## Wiring the real games API

Replace the handler in `server.js`:

```js
app.get('/api/games', (req, res) => {
  // your real fetch / DB call here
});
```

The frontend at `/games` consumes `{ games: [{ id, name, players, supported }, ...] }`.

## Data files

- `data/devs.json` — developer accounts (edit by hand only)
- `data/users.json` — member accounts (created via signup with a key)
- `data/keys.json` — invite keys
- `data/scripts.json` — script hub entries

## Aesthetic notes

- Pure black + warm cream — `#0d0d0d` and `#ece9e3`. Nothing else.
- Anton (display) + Lora (body, warm serif) + JetBrains Mono (code/labels).
- Inline skull SVG as the brand mark.
- Subtle warm grain overlay + soft vignette for atmosphere.
- Friendly microcopy throughout — no terminal-bunker noise.
- Full mobile responsive with a drawer menu under 860px.
