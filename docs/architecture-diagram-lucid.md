# Architecture diagram — data & usage flow (Lucidchart-ready)

Two Mermaid diagrams of how data flows when a player uses the app + coaching agent, written to
**import cleanly into Lucidchart** and then be restyled with official Salesforce brand assets.

- **Diagram 1 — Runtime data/usage flow** (sequence): what happens on a single play-and-coach turn.
- **Diagram 2 — Component landscape** (flowchart): the systems and how they connect, brand-colored.

> **Why Mermaid for Lucid?** No Lucidchart MCP/plugin is installed, but **Lucidchart imports Mermaid
> natively into editable shapes**. The blocks below are kept *Lucid-safe* (no `%%{init}%%` theme
> directives, no emojis, no `box` groupings — Lucid's importer trips on those). Colors ride in via
> `classDef`, which Lucid honors. After import you drop the real Salesforce logos/icons on the shapes
> (see §3).

**Last verified:** 2026-06-26.

---

## 1. Import into Lucidchart (steps)

1. In a Lucidchart doc: **Insert → Diagram via Markdown** (a.k.a. the Mermaid/Markdown import). In
   some versions it's **File → Import → Mermaid**, or the **Mermaid** shape in the shape library.
2. Paste **one** diagram's fenced block contents (the text *inside* the ```` ```mermaid ```` fence —
   not the backticks).
3. Lucid renders it as **native, editable shapes** (not an image). Repeat for the second diagram.
4. Restyle with brand assets per §3.

> If the sequence diagram (Diagram 1) doesn't import in your Lucid plan, use Diagram 2 (flowchart) —
> flowchart import is the most universally supported — and treat Diagram 1 as the written
> step-by-step it already is.

---

## 2. The diagrams

### Diagram 1 — Runtime data/usage flow (one play-and-coach turn)

```mermaid
sequenceDiagram
    autonumber
    participant U as Player (browser)
    participant B as Chess board (Stockfish + chess.js)
    participant R as Rails app (Heroku)
    participant SF as Salesforce (MIAW + Agentforce)
    participant M as Stockfish MCP server

    Note over U,SF: Sign-in + verified-identity handoff (once per session)
    U->>R: Devise login (email + password)
    B->>R: GET /identity_token (authenticated)
    R-->>B: short-lived RS256 JWT (sub = email)
    B->>SF: setIdentityToken(JWT)
    SF->>SF: verify vs keyset, bind conversation to Contact

    Note over U,M: Each move
    U->>B: make a move
    B->>B: Stockfish replies (eval bar, last move)
    B->>R: PATCH persist FEN + PGN

    alt MIAW coach (reactive, in widget) - player asks a question
        U->>SF: "was that a good move?"
        SF->>SF: check_subscription(email) [deterministic]
        alt subscribed
            SF->>R: GET /coach/game_state?email= (live FEN, PGN, lastMove)
            R-->>SF: current board snapshot
            SF->>M: analyze / judge_move / name_opening (grounded)
            M-->>SF: eval + best line + verdict
            SF-->>U: coaching, grounded in the live position
        else not subscribed
            SF-->>U: subscription-required upsell (no analysis)
        end
    else Headless MCP coach (proactive, in panel) - auto-comment on the move
        B->>R: POST /agent_chat/message (move + FEN + Elo)
        R->>R: Subscription.active?(email) via SOQL [deterministic, fail-closed]
        alt subscribed
            R->>SF: Agent API send message (bypassUser)
            SF->>M: engine tools on the embedded FEN
            M-->>SF: eval + best line
            SF-->>R: grounded auto-comment
            R-->>B: render the coach reply
        else not subscribed
            R-->>B: upsell reply (agent never called - 0 credits)
        end
    end
```

### Diagram 2 — Component landscape (brand-colored)

```mermaid
flowchart LR
    U["Player (browser)"]

    subgraph RAILS["Rails app - Heroku"]
        BOARD["Chess board<br/>Stockfish + chess.js"]
        IDTOK["/identity_token<br/>RS256 JWT minter"]
        GAMESTATE["/coach/game_state<br/>live board pull"]
        AGENTCHAT["/agent_chat<br/>headless turns"]
        SUBSVC["Subscription + SalesforceQuery<br/>SOQL via ECA token"]
    end

    subgraph SF["Salesforce - chess-agent org"]
        MIAW["MIAW channel<br/>+ User Verification"]
        COACH["Chess_Coach<br/>Apex / MIAW agent"]
        AGENTAPI["Agent API<br/>Chess_Coach_MCP"]
        CONTACT[("Contact<br/>Is_Subscribed__c")]
    end

    subgraph MCP["chess-mcp-coach - Heroku"]
        ENGINE["Stockfish MCP server<br/>/mcp + REST facade"]
    end

    U -->|plays| BOARD
    U -->|MIAW widget| MIAW
    BOARD -->|mint JWT| IDTOK
    IDTOK -->|setIdentityToken| MIAW
    MIAW --> COACH
    COACH -->|pull live board| GAMESTATE
    COACH -->|engine tools| ENGINE
    COACH -->|check subscription| CONTACT
    BOARD -->|auto-comment| AGENTCHAT
    AGENTCHAT --> SUBSVC
    SUBSVC -->|SOQL| CONTACT
    AGENTCHAT -->|send message| AGENTAPI
    AGENTAPI --> ENGINE

    classDef rails fill:#E8F4FB,stroke:#0D9DDA,color:#001E5B;
    classDef sf fill:#D6E4FF,stroke:#001E5B,color:#001E5B;
    classDef mcp fill:#FFF3D6,stroke:#B45309,color:#3a2a00;
    classDef data fill:#E9F7EF,stroke:#1B7F4B,color:#0b3d24;
    class BOARD,IDTOK,GAMESTATE,AGENTCHAT,SUBSVC rails;
    class MIAW,COACH,AGENTAPI sf;
    class ENGINE mcp;
    class CONTACT data;
```

---

## 3. Brand the imported diagram (official Salesforce assets)

After import, the shapes are generic. To make it read as authentically Salesforce, drop the **real
asset files** onto the shapes (drag the file into Lucidchart, or Insert → Image). Source of truth is
the `applying-salesforce-brand` skill's `assets/` folder — **use the original files, don't redraw**:

| Shape | Asset to place | File (under `~/.claude/skills/applying-salesforce-brand/assets/`) |
|---|---|---|
| **Salesforce** subgraph header | Salesforce Cloud logo | `Logo/Main Salesforce Cloud - Primary.svg` |
| **Chess_Coach / Agent API** nodes | Agentforce product logo | `Product Logos/Agentforce (Product).png` |
| The agent / AI moment | **Agent Astro** (AI mascot, sunglasses) | `Carachters/Agent Astro/Astrobot_Sunglasses_AFlip_009_2K.png` |
| Value/■ accents (optional) | 3D storytelling icons | `Icons/Acceleration-3D-Storytelling-Icon-preview *.png` |

**Colors** (already applied via `classDef`, match these if you restyle in Lucid):

| Token | Hex | Use |
|---|---|---|
| Salesforce dark blue | `#001E5B` | Salesforce nodes, all heading text |
| Cloud blue | `#0D9DDA` | Rails node borders / accents |
| Amber | `#B45309` | MCP server (self-hosted, non-SF) |
| Green | `#1B7F4B` | the Contact datastore (source of truth) |

**Type:** headings in **AvantGarde**, body/labels in **Salesforce Sans** (both in the skill's
`assets/Fonts/`) if you want full brand type in Lucid.

> Logo rule (from the brand system): use only `Logo/Main Salesforce Cloud - Primary.svg` and **do not
> recolor it** with filters. Brand assets are Salesforce-internal — for internal/authorized use.

---

## 4. Alternatives considered

- **Lucidchart MCP/plugin** — none installed in this environment, so I can't push shapes directly
  into a Lucid doc; Mermaid import is the cleanest editable path and matches the Lucid preference.
- **Rendered PNG** (`generating-visual-diagrams` skill, Nano Banana Pro via Gemini CLI) — produces a
  polished, slide-ready image with the logos baked in, but it's **not editable** in Lucid and needs a
  Gemini CLI/API-key setup. Good for a deck; say the word and I'll generate one.
- These diagrams also live in prose form in [`architecture-and-build.md`](architecture-and-build.md)
  (system landscape + handoff sequence) for the repo's GitHub view.
