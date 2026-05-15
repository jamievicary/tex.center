The highest-priority bug right now is the fact that only page 1 of the PDF is ever displayed in the PDF preview pane in the browser.

The previous analysis of this problem has been low quality. You need to reassess this from scratch. Consider using an agent to help. Any plan that already exists to address this in PLAN.md should be deleted, but this milestone should be considered top-priority.

There was recently a suggestion that this was a bug with the upstream supertex package. But to my knowledge NO BUG REPRODUCTION has yet been achieved outside of the live environment. Obviously it is deeply inappropriate to send a bug report upstream to supertex without this.

Make sure there are failing gold tests that can suitably repro this in the live environment. Collect explicit logging data (inlcuding stdin/stdout) to understand why this is happening. Then propose and work on a fix.

Remember to think hard.
