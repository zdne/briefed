# Briefed → Service: Product Direction & Validation Plan

## Context

Briefed today is a personal, single-user AI news-briefing pipeline (RSS/Atom incl. Google News, Gmail newsletters, Twitter/X lists, Feedbin → LLM enrichment/embeddings → daily digest), used via a local stdio MCP server in Claude Code. One direction explored: turn it into a service other people's AI agents can pull briefings from — reachable from Claude.ai/ChatGPT in a browser, not just a local machine.

Before committing to a build, a round of market research and product-shape discussion happened to avoid building infrastructure nobody wants. The key findings changed the plan significantly from "build multi-tenant infra now" to "validate the actual differentiator manually first":

- **A close competitor already exists** (Agentic News, $9/mo, MCP-based, 10K+ sources) but has no discoverable public traction — the field is more open than expected, not more crowded.
- **No product combines** social trend/velocity detection + news grounding + newsletter inclusion + personal configurability + agent access. That combination is a real, still-open gap.
- **Current Briefed, as built today, is feature-equivalent to Feedly AI Feeds** (topic-filtered multi-source AI digest) — Feedly Pro+ ($99–156/yr) already replicates it, X/Twitter and newsletters included, no add-on needed. The only things Feedly doesn't do: agent-native MCP delivery, and velocity/trend detection.
- **Velocity/trend detection is therefore the actual product bet** — not source breadth, not multi-tenancy infrastructure. Without it, this is a smaller, self-hosted Feedly.
- The founder's own configured topics (agentic commerce/payments: ACP, AP2, x402, agent payment identity, stablecoin settlement) point at a specific underserved niche with real practitioner density (x402 Discord ~41K members, AP2 60+ enterprise partners) — a stronger initial target than competing generally with Feedly/Agentic News.

## Decisions made

1. **Positioning**: niche vertical first (agentic commerce/payments), not a generic Feedly/Agentic News competitor.
2. **Audience**: eventually many external agents/users (multi-tenant), but **invite-gated launch, not public self-serve signup on day one** — public signup requires billing, abuse prevention, and per-tenant credential handling (Gmail OAuth, Twitter API cost, etc.) that shouldn't be built before anyone's confirmed to want the product.
3. **Access model for "away from my computer" use**: local stdio MCP (`src/mcp.ts`) stays untouched for personal use. Reaching Claude.ai/ChatGPT in a browser requires a **remote, OAuth-authenticated MCP server** (Streamable HTTP transport) as new, separate infrastructure — not a replacement for the local path.
4. **Product mechanic** (the "algorithm"):
   - **Social (Twitter/X, Reddit, HN)** → detect what's trending/spiking right now.
   - **News (Google News, blog RSS)** → additive grounding/citation only, **never a gate** — an unconfirmed early signal should still surface, just possibly flagged as "no coverage yet."
   - **Newsletters** → just another written source pulled in alongside the rest, no special tier or separate treatment needed.
5. **Discord**: not automated yet. Two relevant real communities were found (x402: ~41K members, MCP Contributors: 4,191, MCP Community: 13,592) — worth monitoring **manually** by hand for the validation phase. Whether to build an automated Discord collector is a decision to make only after confirming Discord is actually where the useful signal lives (note: AP2 specifically has no Discord — its community lives on Google Developer forums instead, so "Discord has everything" isn't universally true).

## Validation plan — do this before building anything

**Do not build multi-tenant infra, OAuth, remote MCP, billing, or the trend-detection algorithm yet.** Test demand cheaply first:

1. Keep running the existing Briefed digest as-is (already configured for the agentic-commerce/payments topics).
2. Supplement it by hand: skim the x402 and MCP Discords yourself periodically and fold anything notable into what you share — no bot/integration needed for this test.
3. Share the resulting digest with **5-10 real people** for 2-3 weeks. Where to find them, in order of warmth/effort:
   - Your own existing Twitter list (already curated for the Twitter collector) — DM people directly from it first.
   - GitHub contributors on [x402-foundation/x402](https://github.com/x402-foundation/x402) and [google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2) — targeted, credible cold outreach.
   - Your existing professional network (payments PMs, protocol people, fintech VCs).
   - The author of "The Agentic Commerce Frontier" Substack — M FARAH (byline as published; no fuller name found).
   - (Skip public posts on Reddit/HN/Discord general channels for this round — the goal is candid 1:1 feedback, not reach.)
4. Ask directly: would they want this daily, would they pay, what's missing.

**Decision point**: only invest in the remote-MCP/multi-tenant/OAuth build-out and the trend-detection algorithm below if this manual round gets real pull (people asking to keep receiving it / stating willingness to pay). If it doesn't land, revisit positioning before writing any more code.

## v1 differentiator sketch — velocity/trend detection (build only after validation succeeds)

Reuses existing infrastructure rather than introducing new systems — pgvector embeddings already exist on every ingested item (`src/db.ts` content table), and the LLM-classification pattern already exists (`AnalystAI.classifyTopics` in `src/ai.ts`, used from `src/digest.ts`). Deliberately avoids keyword/hashtag-based spike detection — the codebase already moved off keyword matching once (commit 1d9e61d) because synonym lists were brittle and produced false positives; the same failure mode would recur here.

1. **Pool**: items ingested in a rolling window (e.g. last 6-24h) that already have embeddings — both `full` and `embedded_only` enrichment modes qualify (Twitter/Reddit/HN already get embedded today).
2. **Cluster**: group items by embedding similarity (pgvector similarity search + greedy/union-find clustering) — a tight cluster in a short window means many sources are saying roughly the same thing.
3. **Score velocity, not volume**: compare each cluster's size in the current window against a baseline (e.g. trailing 7-day average density in that embedding neighborhood). Weight by **distinct author/source count**, not raw item count, so one person posting repeatedly doesn't register as a trend.
4. **LLM pass on top spiking clusters**: same shape as `classifyTopics` — label what's actually happening, map to a configured topic if applicable.
   - **Open question**: should a spike outside the user's configured topics still surface (flagged as "trending, not on your list")? True to "catch things early," but changes the digest from "my watchlist" to "my watchlist plus nearby spikes." Needs a decision before implementation.
5. **Ground**: search the news-tier pool (Google News/blog RSS) for items near the cluster centroid in a wider time window (news lags social); attach as citation if found, mark "no coverage yet" if not. Always additive — never suppresses a trend for lack of corroboration.

**Relevant files when this gets built**: `src/ai.ts` (mirror `classifyTopics`'s LLM-pass pattern), `src/digest.ts` (`createDigest` orchestration — new stage would slot in before/alongside `classifyTopics`), `src/digest-selection.ts` (bucketing logic to extend with a "trending" bucket), `src/db.ts` (pgvector queries to extend for similarity clustering), `src/twitterapi.ts` / `src/twitter-normalize.ts` (existing Twitter ingestion — list-based only today; breadth question — lists vs. keyword search vs. profile follows — is downstream of this and deliberately deferred).

## Explicitly out of scope for now

- Multi-tenant architecture, OAuth, remote MCP transport (Streamable HTTP), billing/signup flow.
- Automated Discord ingestion (bot token, server access, ToS considerations) — manual monitoring only until proven necessary.
- Any change to the existing personal CLI/Obsidian/launchd workflow — stays untouched throughout.

## How to know if this is working

Not a code-verification step since nothing is being built yet — the check is qualitative: after the 2-3 week manual share, do multiple people (not just polite acknowledgment) ask to keep getting it, volunteer that it caught something they'd have missed, or say they'd pay? That's the signal to come back and turn the trend-detection sketch and remote-MCP access model into an actual build plan.
