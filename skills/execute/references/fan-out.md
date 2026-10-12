# Fan-out — concurrent execution in EXECUTE only

Fan-out is allowed **only** in the EXECUTE phase, and only for side effects
(writing code / running tests). Every other phase runs serially. The kernel
permits N tasks `in_progress` at once, but orchestration — sub-agent dispatch,
concurrency count, write-scope isolation — is your job, not the protocol's.

The iron rule: **side effects may run concurrently; loaf-artifact writes are
always serial** (ADR-0005 single writer). Follow this 4-step loop:

1. **Pick a batch of ready leaves.** From `loaf tasks list --status ready
   --format json`, take tasks with `ready: true` (kernel-derived; it already
   requires every `depends_on` to be done). Confirm their write scopes do not
   overlap. Pick N (typically 2–4).
2. **Atomic batch transition (serial).** Call `loaf tasks claim <T>` + `loaf
   tasks step start --task <T> --step <s>` for each — one at a time, in the
   main thread. No race; the kernel validates each transition.
3. **Fan out N sub-agents.** Dispatch one sub-agent per task. Each reads its
   `task.drives` / spec / existing evidence and runs side effects within **only
   its own write scope**. Sub-agents do **not** call `loaf` write commands —
   they return results to you.
4. **Fan in (serial).** Collect the results, then call `loaf evidence add` +
   `loaf tasks step done` (+ `loaf finding raise` if needed) for each — one at
   a time, in the main thread. Loop back to step 1 for the next batch.

## Failure handling

If a sub-agent crashes or times out, at fan-in raise a finding against its task
(`loaf finding raise --category impl-defect --action fix-impl --target-task <T>
--target-step implement --summary "<what failed>"`) and let the `fix-impl`
back-edge return the cursor to `EXECUTE.work` and reset that step for a retry;
close the finding with `loaf finding close <FND-id>` once the retry passes.
If the task itself must be reshaped, use `--action amend-tasks` and then
`loaf tasks amend <T> --input <file> --finding <FND-N>`. Do not fabricate evidence for work that did not complete.

## When NOT to fan out

Serial is the correct default. Fan out only when the batch is genuinely
independent (non-overlapping write scopes) and large enough that parallel side
effects save real wall-clock. A single ready leaf, or leaves that touch shared
files, run serially.
