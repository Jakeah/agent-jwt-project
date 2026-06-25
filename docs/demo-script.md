# Demo Script — Chess + Agentforce verified-identity coach

A clean, numbered, copy-pasteable runbook a presenter can follow live. No architecture prose — for
the *why*, see [`architecture-and-build.md`](architecture-and-build.md).

**Last verified:** 2026-06-25.

---

## The story you're telling

> Anyone can play the chess engine for free. **Coaching is a paid feature.** Because the app passes a
> verified Salesforce identity into the chat, the agent knows *who* you are and *whether you've paid*
> — and gates coaching deterministically. Same agents on screen for everyone; the experience differs
> by subscription. Two coach implementations show two Agentforce delivery models.

---

## 0. Prerequisites (before the room)

| Item | Value |
|---|---|
| Live app | `https://chess-agent-jwt-95c105a581a5.herokuapp.com` |
| Salesforce org | `chess-agent` (My Domain `trailsignup-e8eb68b2222256`) |
| MCP server | `chess-mcp-coach` (Heroku) — auto-comments come from here |

**Demo personas** (Rails login + matching Salesforce Contact):

| Login | Password | Contact subscribed? | Use it to show |
|---|---|---|---|
| `sam.altaner@gmail.com` | `elobro` | ✅ yes | Full coaching |
| `jacob.connors3@gmail.com` | *(your pw)* | ✅ yes | Full coaching (alt) |
| `player@example.com` (Jordan) | *(your pw)* | 🔒 no | The paywall |

Pre-flight checks (run once, ~2 min before):
1. Open the app, sign in as **Sam**, confirm the board loads and the coach panel appears.
2. Confirm subscription state is current (the headless gate caches ~5 min):
   ```bash
   sf data query --target-org chess-agent \
     --query "SELECT Email, Is_Subscribed__c FROM Contact WHERE Email IN ('sam.altaner@gmail.com','player@example.com')"
   ```
   Expect Sam `true`, Jordan `false`. If you just flipped a flag, bust the Rails cache:
   ```bash
   heroku run --app chess-agent-jwt "bin/rails runner 'Subscription.bust(%q{player@example.com})'"
   ```
3. Confirm the MIAW coach is on the **gated** version: `Chess_Coach` **v11** Active (see §6 of the
   architecture doc if it ever regresses).

---

## 1. Play the engine (free for everyone)

1. Sign in as **Sam**.
2. From **My Games**, click **New game** → the board opens (you're White vs. Stockfish).
3. Set **Level** (top of the page) — e.g. *Beginner ~600* for a forgiving demo, or *Expert* to show
   real strength. The eval bar (left of the board) stays honest regardless of level.
4. Play a few moves. Point out: the computer replies with a natural "thinking" beat, the eval bar and
   last-move card update, and the game persists (it's tied to your user).

> **Say:** "No Salesforce yet — this is just the app. Anyone can play. Now let's bring in the coach."

---

## 2. The MCP coach (headless, proactive) — subscribed

1. Top-right **Coach** toggle → **MCP (Headless)**. The custom chat panel takes the sidebar.
2. Make a move. After the engine replies, the panel shows an animated "thinking…" indicator, then a
   **grounded auto-comment** naming your move, the opening, and any mistake — at the level's Elo.
3. Play a deliberate blunder (e.g. hang a piece). The coach flags it with the eval swing.

> **Say:** "Rails drives the Agentforce **Agent API** server-to-server, so the app posts after every
> move — the agent grounds on the live FEN via a self-hosted Stockfish **MCP** server. Sam's a
> subscriber, so coaching flows."

---

## 3. The paywall — switch to the unsubscribed user

1. **Sign out** (top-right). 
2. Sign in as **Jordan** (`player@example.com`).
3. New game → toggle to **MCP (Headless)** → make a move.
4. Instead of analysis, the panel shows a 🔒 **"Coaching is a premium feature…"** upsell.

> **Say:** "Same agent, same screen. Jordan's Contact isn't subscribed, so Rails checks
> `Is_Subscribed__c` in Salesforce — via SOQL with the same token that drives the Agent API — and
> returns the upsell **without ever calling the agent**. The gate is deterministic, not the model
> deciding. And it's a hard gate: zero agent turns, zero credits."

*(Optional proof)* In a terminal: `heroku logs --app chess-mcp-coach --tail` shows **no** `/mcp` call
for Jordan's move (the agent was never invoked).

---

## 4. The MIAW coach (embedded widget, reactive, verified)

1. Still as **Jordan**: toggle **Coach → Apex (MIAW)**. The embedded chat bubble (bottom-right)
   takes over; the verified-identity JWT binds the conversation to Jordan's Contact.
2. Open the bubble, ask: *"How should I play this position?"*
3. The coach replies with the **same 🔒 upsell** and refuses to analyze — the gate now runs **inside
   the agent** (an Apex action + a deterministic Agent Script branch).

> **Say:** "This path is the embedded MIAW widget with **User Verification** — a signed RS256 JWT
> carries Jordan's identity into Salesforce, so the conversation is a *known Contact*. The gate lives
> in the agent itself here, reading the same Contact field. Two delivery models, one source of truth."

4. **Sign out → sign in as Sam → Apex (MIAW)**, ask the same question. Now the coach **greets context,
   sees the live board, and coaches** — full analysis. (If it resumes an old conversation, hit
   **↻ New chat** to start fresh against the verified identity.)

> **Say:** "Same agent, same question — Sam's a subscriber, so the in-agent gate opens and the coach
> sees the current position and coaches."

---

## 5. Prove the verified binding in Salesforce (optional, for a technical room)

Show that the MIAW conversation really is bound to the Contact, not anonymous:

```bash
sf data query --target-org chess-agent \
  --query "SELECT MessagingPlatformKey, EndUserContactId FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 1"
```
A verified session's `MessagingPlatformKey` contains `AUTH/…/uid:<email>` (not `UNAUTH/…/uid:<random-uuid>`).

> **Say:** "That `AUTH/.../uid:sam.altaner@gmail.com` is the verified handoff — the JWT was accepted
> and the conversation is bound to the real Contact. That's what makes the subscription gate possible."

---

## 6. The contrast slide (one-liner recap)

| | Plays engine | Coaching |
|---|---|---|
| **Anyone (free)** | ✅ | 🔒 upsell |
| **Subscriber** | ✅ | ✅ full, engine-grounded |

Both coaches, both delivery models, gate on the **same** `Contact.Is_Subscribed__c`. The headless path
gates in Rails (no agent turn wasted); the MIAW path gates inside the agent. Verified identity is what
ties a chat visitor to a paying Contact.

---

## Troubleshooting (live)

| Symptom | Fix |
|---|---|
| Jordan still gets coached (MCP) | Sub cache stale — `Subscription.bust('player@example.com')` (see §0) |
| Jordan still gets coached (MIAW) | Active agent isn't the gated version — confirm `Chess_Coach` **v11** Active |
| MIAW coach stuck on the opening / old convo | Hit **↻ New chat** (verified continuity trap) |
| Widget says "Something went wrong, log in" | Token/keyset issue — see the user-verification guide; usually a hard-refresh after a republish |
| Coach reply is slow (~8–20s) | Expected — the Agent API buffers the whole turn; the animated indicator covers the wait |
