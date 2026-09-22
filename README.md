# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order — except for three bodies that are dead weight by rule rather than by
judgement (a body delivered twice, a superseded compaction summary, a delivery
an external ledger says is answered); see
[Three bodies Jev is never asked about](#three-bodies-jev-is-never-asked-about).

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `maxRetainedTokens` | `60000` | Ceiling on the estimated tokens the compacted history may keep; `0` turns the budget off |
| `dedupeRepeatedUserText` | `true` | Remove the older copies of a user body (≥200 chars) delivered again verbatim |
| `dropSupersededSummaries` | `true` | Remove every compaction summary carried as a user message but the newest |
| `resolvedIds` | none | Ids an external ledger answered; a delivery naming only answered ids is removed |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, `retainedTokens` / `retainedTarget` / `budgetTrimmed`
for the budget pass, `repeatedTexts` / `supersededSummaries` /
`resolvedDeliveries` / `textCharsDropped` for the three rules, the state size in
estimated tokens, which fitting stage was needed, and the number of requests.
`result.messageDecisions` lists the bodies the rules removed.

## Design: what a compaction costs, and the two limits that keep it worth it

A pruning is not free. The request that follows one rewrites the whole retained
prefix into the prompt cache, and a cache write is billed above a plain input
token while a cache read is billed far below one. So the question is never "how
many tokens did we remove" but "how many responses does it take to earn the
rewrite back".

A measurement of 22 real plugin compactions and 116 built-in ones (2026-09-22,
two machines, transcripts of live sessions; the workings are in
`experiments/agent-subtask-cost/out/billing/` of the operator's own tree) gave
the numbers this design rests on:

- The retained size **ratcheted upwards**: across one conversation's eight
  compactions the kept history grew 57k → 167k tokens, the reduction fell
  65% → 10%, and the cache rewrite the next request paid grew 177k → 500k.
  Jev decides what is still needed and has no notion of a budget, and the plugin
  only ever offered it the calls it had not seen before — so nothing already
  kept was ever reconsidered. **`maxRetainedTokens` is the answer**: after Jev
  has spoken, kept calls are escalated oldest-first until the history fits.
- The compactions that removed **40% or more paid their rewrite back within
  5–16 responses**; the ones below 40% took **24–1214** (one took 1214 because
  it freed nothing at all and still rewrote 388k tokens). The built-in summary,
  for contrast, cut per-response billing 82% and paid back in about 1 response.
  **`minReductionPercent` is the answer**: below the minimum the plugin now does
  nothing, which costs nothing.

One decision point. `compactionOutcome` in `hooks/cold.ts` is the only place
that turns a finished pruning into `apply` / `skip` / `fallback`. It applies at
or above `minReductionPercent`; below it a cache-cold pruning always skips
(the built-in summary is a model call, and under `-p` it ran past the engine's
hook timeout), a human or engine trigger falls back to the summary, and a
plugin-initiated one falls back only at or above `fallbackAtPercent`.
The retired `minReductionRatio` (0..1) is still read as an alias.

### Three bodies Jev is never asked about

Measured 2026-09-22 on a live history the plugin could no longer shrink: of the
209k tokens it had to keep, **87% was user message bodies**, and one
10,813-character bundle of deliveries sat in it **13 times with an identical
body**. Jev is never asked about a body — the operator's rule is that a person's
words are passed on as they were written — so none of this could ever go.

Three of those bodies are dead weight by rule, not by judgement, so a rule takes
them instead:

1. **A body delivered again** (`dedupeRepeatedUserText`). The same text, trimmed
   of surrounding whitespace, appearing more than once: the newest copy stays,
   the older ones go. A repeat under 200 characters is left alone — a short turn
   ("go ahead") is a real turn and removing it saves nothing.
2. **A superseded compaction summary** (`dropSupersededSummaries`). The engine
   delivers its summary as a user message beginning *"This session is being
   continued from a previous conversation"*, so every earlier summary survives
   each later compaction untouched. The newest one stays, the rest go.
3. **An answered delivery** (`resolvedIds`, the plugin option
   `resolvedIdsCommand`). A shell command prints one answered id per line; a body
   that names ids — the sender of an `[agmsg from …]` header, or a ledger id like
   `lt-…` / `ob-…` / `dav-…` — and names **only** answered ones is removed, so a
   bundle still holding one unanswered letter stays whole. Off unless the command
   is configured, and fail-open: no command, a non-zero exit, a timeout or empty
   output all remove nothing and write one journal line.

None of the three rewrites a body: the message keeps its place and its tool
blocks, and its text becomes a one-line note saying what was removed and why.
Pinned messages (the first, and the newest `preserveRecentMessages`) are never
candidates, and the decisions are made **before** Jev is asked, on the same
decision set `applyDecisions` and `trimToBudget` already use — there is one
place that rebuilds the history, not two. Set any of them to `false` (or leave
`resolvedIdsCommand` unset) to turn that rule off.

### Not done: pruning only the tail so the prefix survives

A compaction that edits the middle of the history invalidates the prompt cache
from the first edited token onwards — measured, the response after a pruning
served only 5.6% of its input from cache and wrote the other 94.4%. Pruning only
the *newest* tool results instead would leave the prefix byte-identical, so the
cache would survive and the rewrite would cost nothing (the idea TokenPilot,
arXiv 2606.17016, reports 56–87% savings for).

Can this hook do it? **Yes mechanically, no usefully.** `session.compact`
receives the whole message array and returns a replacement array, so returning
"prefix unchanged, tail pruned" is a one-line change to the ordering in
`trimToBudget`. But it does not pay here: the newest messages are the ones the
assistant is still working from (they are pinned for that reason), and the tail
beyond the pin is a handful of calls worth a few thousand tokens against a
half-million-token prefix — a rounding error. The saving only exists if the
prefix is large and stale, and that is exactly the part the tail-only rule
refuses to touch. Worth revisiting only if the engine ever exposes which prefix
the cache currently holds, so the plugin could cut at that boundary instead of
guessing.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.
- `maxRetainedTokens` cannot go below the pinned frame (the first message, the
  newest `preserveRecentMessages`, and all message prose). A budget under that
  floor escalates everything it may and stops there.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, `skipped (below 40% minimum: …)` when the pruning
would not have paid for the cache rewrite it causes, or
`fallback to built-in summary (…)` when a person or the engine asked and Jev
could not remove enough.

Two options set the economics (both overridable per profile from the
`pluginConfigs` of `settings.json`, like `cacheTtlMinutes`):

```json
{
  "pluginConfigs": {
    "fast-jev-compaction@fast-jev-compaction": {
      "options": {
        "cacheTtlMinutes": 60,
        "maxRetainedTokens": 60000,
        "minReductionPercent": 40,
        "dedupeRepeatedUserText": true,
        "dropSupersededSummaries": true,
        "resolvedIdsCommand": ""
      }
    }
  }
}
```

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
