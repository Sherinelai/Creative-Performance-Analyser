---
name: mco-creative-explainer
description: >-
  Reference for diagnosing MCO (Multi-Creative Optimization) creative behaviour on Liftoff — why a
  creative is spending, not spending, or was auto-paused. Covers the 4-stage bidding pipeline
  (eligibility -> MCO/ITI selection -> ML pricing), the Auto-Pauser, WCS, the creative throttle,
  inventory-format competition groups, the 13 diagnosis codes, and the metric glossary. This is the
  system prompt behind `diagnoseMcoCreative()` and `summarizeFormatTrends()` in appscript/Code.js.
  Read it before changing any AI-diagnosis prompt, diagnosis code, or lifecycle-state rule.
---

<!--
PROVENANCE — this file is the single source of truth for the app's MCO knowledge.

Origin: extracted from `MCO_SYSTEM_PROMPT_FALLBACK` in appscript/Code.js on 2026-07-27, then
VERIFIED byte-identical (modulo one trailing newline) against the Google Drive original:
  https://drive.google.com/file/d/1w_S9VlNvq_t5tQ50rq8DsiSzU-0DUhyK/view
No drift existed. That Drive file is itself the merged skill + knowledge base, so there was only
ever one document.

Since then this file is authoritative and the app no longer reads Drive at runtime — the old
Script Properties SKILL_FILE_ID / KB_FILE_ID are unused. Edit this file, then run
`python3 tools/sync_skill.py` to recompile it into appscript/Code.js (MCO_SKILL), then
`clasp push -f`. Re-upload to Drive only if humans read the Drive copy — it is no longer wired
to anything.

DIVERGENCE FROM THE DRIVE ORIGINAL (deliberate):
  2026-07-27 — the lifecycle section listed TWO states defined by the 25K-impressions /
  7-days rule. The authoritative definition (supplied by Sherine from the Looker queries that
  produce the state counts) is THREE mutually exclusive states, each a predicate over the
  queue_creative_statistics PDT:
     queuing    = queue_eligible AND NOT optimizing AND current_status='excluded'
     exploring  = queue_eligible AND NOT optimizing AND current_status='included'
     optimizing = NOT queue_eligible AND is_currently_optimizing
  §4, §9 and §11 now state that; the impressions/age rule is demoted to "what flips
  is_currently_optimizing". Mirrored as data in MCO_RULES.creative_states (Code.js), which is
  what buildQueueingSQL / buildExploringSQL / buildOptimizingSQL already implement.
  (An intermediate 2026-07-27 edit flipped the old two-state table's Exploring row from AND to
  OR; that remains the right *proxy* logic — see mcoLifecycleStateProxy() — but it was
  describing a derivation, not the definition, and is superseded here.)

NUMBERS: every threshold in this prose is mirrored as data in MCO_RULES (appscript/Code.js).
tools/sync_skill.py warns when a MCO_RULES number no longer appears here. Change both together.
-->

# MCO Creative Explainer — Complete Reference

This document is the merged skill + knowledge base for diagnosing MCO creative behavior.
It powers the AI diagnostic engine in the Creative Performance Analyzer.

---

## 1. Bidding Pipeline Overview

The Liftoff ad serving pipeline has 4 sequential stages:

```
Bid Request → Eligibility Filtering → MCO (Creative Selection) → ML (Internal Auction)
```

**Stage 1 — Bid Request**: Ad slot size, orientation, device, ad format, ad type support (HTML/VAST), max video length, exchange.

**Stage 2 — Eligibility Filtering**: Filters each ad group to only creatives compatible with the bid request.
- Matches on: ad type, orientation, device, video length
- LXA creatives only eligible on VX exchange
- SAF campaigns: all creatives share same format

**Stage 3 — MCO (Creative Selection)**: Selects the single best creative per ad group based on ITI (Impression-to-Install rate) over past 30 days. Highest ITI wins. Free Floating campaigns select randomly.

**Stage 4 — ML (Internal Auction)**: Prices each (ad group, creative) pair. Considers dest app, source app, user features, campaign goals. Creative features have minor influence. Highest-priced pair wins.

### Key Insight: MCO Chooses Creative, ML Chooses Ad Group

**Per-bid-request auction flow:**
1. A bid request comes in with ad slot specs (size, orientation, device, ad type, video length)
2. Every ad group gets filtered to only **eligible** creatives (matching the bid request)
3. MCO selects the **highest-ITI creative** per ad group (Free-Floating selects randomly)
4. ML prices every **(ad group + creative) pair** for this bid request
5. ML considers: dest app, source app, user features, campaign optimization type, creative features (ad type, video length — minor influence)
6. The (ad group + creative) pair with the **highest ML price wins** the internal auction
7. This internal auction happens across ALL customers

**Critical distinctions:**
- **Format/ad-group-level spend distribution is decided by ML** (pricing), NOT by MCO
- **Creative selection within an ad group is decided by MCO** (ITI-based), NOT by ML
- MCO does NOT "shift spend between formats" — ML pricing determines which ad groups win auctions
- The selected creative has a **minor influence** on the final ML price
- Pausing a creative does NOT guarantee spend shifts to where you want — ML may reprice the ad group differently with a different creative

**Common misconception:** "MCO is shifting spend to format X" is incorrect. ML pricing determines format-level spend. MCO only affects WHICH creative represents each ad group. If a format's spend changes, it's because ML's pricing of that ad group changed (due to different user mix, source apps, or campaign goals), not because MCO moved budget.

---

## 2. Metric Definitions

- **RPI** = Revenue Per Install = cost of install. LOWER is better.
- **7D ROAS** = Return on ad spend over 7 days. HIGHER is better.
- **1D ROAS** = Return on ad spend over 1 day. HIGHER is better.
- **RPA** = Revenue Per Action = cost of target event. LOWER is better.
- **ITI** = Impression-to-Install rate. HIGHER is better. This is what MCO selects on.
- **IPM** = Installs Per Mille (per 1000 impressions). IPM = ITI × 1000. HIGHER is better.

---

## 3. Auto-Pauser (MCO campaigns only)

The Auto-Pauser is a Rush job that is currently responsible for pausing creatives that use MCO.

### Legacy Criteria (before WCS)
With the Autopauser logic today, a creative is considered to be "lost" when it meets ALL of the following criteria:

1. The creative has been live for **at least 5 days**
2. AND the creative has accounted for **<5% of its competing creative format group's spend** for the past 3 days
3. AND either:
   - The creative has spent in the past 3 days
   - OR the creative's selection probability is below 10%

### Current Criteria (with WCS protection)
To ensure new creatives reach the minimum threshold of 25K impressions and 7 days since launch, the Autopauser lose criteria has been updated to:

1. Creative has **at least 25K impressions in the past 3 months** AND **7 days live since launch** ("Optimized")
2. AND the creative has accounted for **<5% of its competing inventory group's spend** for the past 3 days
3. AND either:
   - The creative has spent in the past 3 days
   - OR the creative's selection probability is below 10%

### Key difference: Legacy vs Current
- Legacy: "live for 5 days" + "competing **creative format** group"
- Current: "25K impressions + 7 days live" + "competing **inventory** group"
- The WCS-updated criteria protects new creatives until they have enough data (25K impressions) to compete fairly on ITI

### In Practice
- New creatives (exploring, <25K impressions or <7 days) are NEVER auto-paused — they are WCS-protected
- The Auto-Pauser competes creatives within their "inventory group" (e.g. phone-portrait-vast, phone-banner)
- Once auto-paused, reactivating the creative usually doesn't help because its ITI is still low — MCO will still not select it
- **Cloning** the creative and relaunching gives it a fresh WCS exploration period with guaranteed 25K impressions

### Auto-Pauser Logging (for diagnosis & backtesting)
In order to allow for backtesting of new criteria, the existing job logs to Trino on each run. For each candidate creative, the following data is recorded:

- **Lifecycle metric**: supporting data used at the current time
- **Threshold used**: to calculate the state
- **Calculated state**: the state the candidate was considered to be in based on the supporting data
- **% of spend**: compared to competing group
- **Spend amount**: in the past 3 days
- **Creative selection probability**

With this logging, we can backtest how many creatives would have been paused at a given time in the past using a new definition.

---

## 4. WCS (Winner Candidate Substitution, MCO only)

Rolled out December 2024. Before WCS, ~75% of creatives were auto-paused before calibration.

### How It Works
When a bid is won by an "optimized" creative, 5-10% of the time (max 35%) the optimized creative is swapped out for an "exploring" creative. The exploring creative gets served using the optimized creative's bid price.

### Lifecycle States

| State | Criteria | Behavior |
|-------|----------|----------|
| **Queuing** | `is_currently_queue_eligible` AND NOT `is_currently_optimizing` AND `current_status = 'excluded'` | In the throttle waiting room. Queue-eligible but excluded from serving, so no WCS impressions yet. Protected from Auto-Pauser. |
| **Exploring** | `is_currently_queue_eligible` AND NOT `is_currently_optimizing` AND `current_status = 'included'` | Past the throttle and being served via WCS substitution, still pre-calibration. Protected from Auto-Pauser. |
| **Optimizing** | NOT `is_currently_queue_eligible` AND `is_currently_optimizing` | Calibrated. Normal MCO competition on ITI. Eligible for Auto-Pauser. |

> **State is read, not derived.** There are exactly **three** states and they are **mutually
> exclusive**. Each is a predicate over the `queue_creative_statistics` PDT
> (`looker.*queue_creative_statistics`, joined on `creative_id`; the creative and the campaign
> must both be `state = 'enabled'`). Queuing and Exploring differ **only** by `current_status`
> — `'excluded'` means throttled and not being served, `'included'` means being served.
>
> The 25K-impressions / 7-days rule is what makes the **platform** flip
> `is_currently_optimizing`; it is not a definition to recompute. Do not infer a creative's
> state from impressions and age — if the PDT has no row for a creative (e.g. it is paused),
> it has no state, and the honest answer is `insufficient_data`.
>
> *History:* this table previously listed only two states, defined by the impressions/age
> rule. A 2026-07-27 revision changed its Exploring row from AND to OR — correct as a
> *proxy* for "not yet calibrated", but it was still describing a derivation rather than the
> real definition, and it had no way to express Queuing at all. Superseded by the three
> predicates above (authoritative source: the Looker queries behind the state counts).

- All new creatives start as "exploring"
- For net-new apps (all exploring), no substitutions until first creative becomes "optimizing"
- Substitution rate not user-controllable
- Platinum/Gold customers see lower substitution rates

---

## 5. Creative Throttle (MCO, exploring creatives only)

Prevents too many creatives from exploring simultaneously.

- Queue ("waiting room") before WCS starts serving
- Minimum capacity: 6 creatives per inventory format
- Scales with spend (larger customers = more capacity)
- Budget cuts may shrink capacity → exploring creatives temporarily stop
- **Queuing** state: enabled + queue-eligible + excluded from serving

---

## 6. Eligibility Filtering Details

A creative is eligible if it matches the bid request on ALL of:
- Ad type (HTML/VAST)
- Orientation (portrait/landscape)
- Device (phone/tablet)
- Video length (within max duration)

**Inventory format overlap**: e.g. phone-portrait-vast-30s overlaps with phone-portrait-vast-60s ~46.5% of the time. Competition groups are not as clean as the UI suggests.

---

## 7. Common Diagnosis Patterns

### "Creative was auto-paused but has good ROAS"
MCO selects on ITI, not ROAS. Clone and relaunch for fresh WCS period.

### "New creative isn't getting any spend"
If Queuing → waiting for throttle capacity. If Exploring with some impressions → WCS is working, just low volume.

### "One creative gets all the spend"
Highest-ITI creative dominates WITHIN each ad group. But format-level spend concentration is driven by ML pricing — if one format's ad groups consistently win auctions (due to higher ML prices), that format gets more spend. MCO only determines which creative represents each ad group.

### "Creative was spending, then suddenly stopped"
Check if exploring → optimizing transition. Or spend shifted to another format, or new creative with higher ITI entered.

### "Why is this creative spending if it has low ROAS?"
MCO picks on ITI. High ITI = high install rate, but installs may not lead to high-value events. ITI-ROAS disconnect is a known limitation.

### "LXA creative isn't getting spend on non-VX"
LXA only eligible on VX exchange. Filtered out in eligibility step on other exchanges.

---

## 8. Known Limitations

1. **MCO selects on ITI only** — does not consider ROAS, CPI, CPA, or downstream metrics
2. **Pausing may not have intended effect** — ML reprices ad group with different creative
3. **Cloning is not guaranteed** — fresh WCS period, but may still lose on ITI
4. **ITI susceptible to fraud** — install farming inflates ITI
5. **CPI-ITI correlation** — lower CPI from higher ITI doesn't mean better user quality

---

## 9. Diagnosis Codes

| Code | Meaning |
|------|---------|
| `auto_paused_low_iti` | Paused: ITI lower than competitors |
| `auto_paused_low_spend_share` | Paused: spend share <5% |
| `auto_paused_selection_prob` | Paused: selection probability <10% |
| `exploring_wcs_protected` | In WCS exploration, exempt from pause |
| `exploring_throttle_queued` | In throttle queue, waiting for capacity |
| `winning_highest_iti` | Spending: highest ITI in group |
| `winning_by_eligibility` | Spending: favorable eligibility matching |
| `losing_iti_competition` | Not spending: outcompeted on ITI |
| `losing_eligibility_mismatch` | Not eligible for high-volume bid requests |
| `spend_shift_format_change` | Spend moved to different inventory format |
| `newly_optimizing` | Just exited exploration, competing normally |
| `free_floating_random` | Non-MCO: selected randomly |
| `insufficient_data` | Not enough data to diagnose |

---

## 10. Diagnosis Logic

1. **Free Floating** → `free_floating_random` (recommend adopting MCO)
2. **State is `queuing`** (`current_status = 'excluded'`) → `exploring_throttle_queued`;
   **state is `exploring`** (`'included'`) → `exploring_wcs_protected`. Read the state, don't
   derive it from impressions/age; if there is no state, say `insufficient_data`.
3. **Paused**: compare ITI vs group, check spend share <5%, selection prob <10%
4. **Spending + highest ITI** → `winning_highest_iti`; otherwise check eligibility
5. **Not spending + lower ITI** → `losing_iti_competition`
6. **Missing data** → `insufficient_data` with confidence: low

---

## 11. Terminology Glossary

| Term | Definition |
|------|-----------|
| **MCO** | Multi-Creative Optimization |
| **ITI** | Impression-to-Install rate (30-day window) |
| **WCS** | Winner Candidate Substitution |
| **Auto-Pauser** | Pauses underperforming optimized creatives |
| **Queuing** | Queue-eligible, `current_status='excluded'` — throttled, not yet served, protected |
| **Exploring** | Queue-eligible, `current_status='included'` — served via WCS, pre-calibration, protected |
| **Optimizing** | `is_currently_optimizing` — calibrated, normal competition, Auto-Pauser-eligible |
| **Free Floating** | Non-MCO, random selection |
| **Inventory Format** | e.g. phone-portrait-vast-30s |
| **MAF** | Multi-Ad Format ad group |
| **SAF** | Single Ad Format ad group |
| **LXA** | Liftoff XA, only eligible on VX exchange |
| **Competition Group** | Creatives eligible for same bid requests |
| **Selection Probability** | MCO's probability of selecting a creative |
| **Calibration** | ~25K impressions over 7 days |

